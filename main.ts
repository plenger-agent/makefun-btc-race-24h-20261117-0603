// TapeRunner: a two-engine long-only bot for the bars-replay/v1 hello/batch/orders protocol.
//
// Engine one is a pullback scalper. Tuning against the frozen dev window showed this tape
// punishes chasing upward momentum at one-minute scale — the roughly 20-plus bps a round
// trip costs in fees, slippage and own impact eats the follow-through — while pullbacks
// into a drifting tape snap back often enough to clear those costs. So the scalper fades
// a measured slide: when the trailing hour-and-a-half return sags past a small threshold
// it buys, then leaves on a quick bounce, a protective stop, or a time limit. Engine two
// is a capitulation dip buyer. When the tape flushes hard over the past hour (or drops
// steeply and prints its first uptick) it buys the washout with the same stake and gives
// the bounce much more room to develop.
//
// Both engines share the same safety rails:
//   - every buy is trimmed so its own pool impact stays near or below ten basis points,
//     sized against the latest bar close depth (c_depth via the vendor shim),
//   - a drawdown guard flattens the book and benches new entries for a while if equity
//     slips far from its peak,
//   - a short cooldown after each scalp exit keeps the bot active without churning,
//   - no fresh entries in the closing stretch of the window.
//
// The bot is fully deterministic: it reads only the hello seed's universe, the batch bars,
// fills and account it is handed. No clock, no randomness, no network, no files.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const TICKER = 'CBBTC';

// ---- pullback scalp engine tuning -----------------------------------------
const SCALP_LOOKBACK = 90; // trailing window whose sag triggers an entry
const SCALP_TRIGGER = 0.002; // window must fall at least this fraction
const SCALP_STAKE = 0.50; // share of equity committed per scalp entry
const SCALP_TAKE = 0.008; // take-profit, fraction over position cost
const SCALP_STOP = 0.015; // stop-loss, fraction under position cost
const SCALP_MAX_HOLD = 180; // bars before a scalp is closed regardless

// ---- dip engine tuning ---------------------------------------------------
const DIP_LONG_BARS = 60; // hourly lookback for a capitulation flush
const DIP_LONG_DROP = 0.015; // hourly fall that counts as a flush
const DIP_SHORT_BARS = 10; // steep short drop alternative trigger
const DIP_SHORT_DROP = 0.010;
const DIP_STAKE = 0.50;
const DIP_TAKE = 0.015;
const DIP_STOP = 0.025;
const DIP_MAX_HOLD = 120;

// ---- shared rails --------------------------------------------------------
const IMPACT_LIMIT_BPS = 10n; // trim buys so own impact stays about here
const SLIPPAGE_CAP_BPS = 150; // generous cap: avoid rejects, still bounded
const COOLDOWN_BARS = 3; // pause between a scalp exit and the next entry
const GUARD_DROP = 0.08; // equity fall from peak that trips the guard
const GUARD_BENCH_BARS = 300; // entries benched after the guard trips
const LATE_CUTOFF = 60; // no new entries this many bars before the end
const WINDOW_BARS = 1440; // one day of one-minute bars

// ---- running state -------------------------------------------------------
const closes: number[] = [];
let heldKind: 'scalp' | 'dip' | null = null;
let heldBars = 0;
let pendingKind: 'scalp' | 'dip' | null = null;
let cooldownLeft = 0;
let benchLeft = 0;
let peakEquity = 0n;
let orderSeq = 0;

function trailingReturn(span: number): number | null {
  if (closes.length <= span) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - span]!;
  if (then <= 0) return null;
  return now / then - 1;
}

// Shrink a desired spend until the shim's own impact estimate fits the limit.
// The estimate uses the latest close depth, the best proxy for the next open.
function trimForImpact(state: BarsState, want: bigint): bigint {
  let amount = want;
  for (let attempt = 0; attempt < 6 && amount > 0n; attempt++) {
    const impact = state.impactBps(TICKER, amount);
    if (impact === null || impact <= IMPACT_LIMIT_BPS) break;
    amount = (amount * IMPACT_LIMIT_BPS) / impact;
  }
  return amount;
}

function buildBuy(state: BarsState, stakeShare: number): BuyInput | null {
  const share = BigInt(Math.round(stakeShare * 10000));
  let want = (state.equity * share) / 10000n;
  if (want > state.cash) want = state.cash;
  const room = state.weightRoom(TICKER);
  if (want > room) want = room;
  want = trimForImpact(state, want);
  const minimum = BigInt(state.hello.fees.min_notional_quote_units);
  if (want < minimum) return null;
  orderSeq += 1;
  return {
    side: 'buy',
    symbol: TICKER,
    notional_quote_units: want,
    max_slippage_bps: SLIPPAGE_CAP_BPS,
    client_id: `tape-buy-${orderSeq}`,
  };
}

function buildSellAll(state: BarsState): SellInput | null {
  const held = state.positions.get(TICKER);
  if (held === undefined || held.qty <= 0n) return null;
  orderSeq += 1;
  return {
    side: 'sell',
    symbol: TICKER,
    qty: held.qty,
    max_slippage_bps: SLIPPAGE_CAP_BPS,
    client_id: `tape-sell-${orderSeq}`,
  };
}

// Position profit as a fraction: value at the latest close over booked cost.
// Cost already carries the entry fee, so this understates the raw price move
// slightly, which is the conservative direction for both exits.
function positionGain(state: BarsState): number | null {
  const held = state.positions.get(TICKER);
  if (held === undefined || held.cost <= 0n) return null;
  const worth = state.value(TICKER, held.qty);
  return Number(worth) / Number(held.cost) - 1;
}

await runBars({
  onBatch(state, batch) {
    // Learn from this batch: append the fresh bar close for our ticker.
    for (const bar of batch.bars) {
      if (bar.symbol === TICKER) closes.push(Number(bar.c));
    }

    const orders: (BuyInput | SellInput)[] = [];
    const held = state.positions.get(TICKER);
    const isFlat = held === undefined;

    // Sync the position bookkeeping with what the account actually shows.
    if (isFlat) {
      heldKind = null;
      heldBars = 0;
      if (pendingKind !== null) pendingKind = null;
    } else {
      if (heldKind === null) heldKind = pendingKind ?? 'scalp';
      pendingKind = null;
      heldBars += 1;
    }

    if (state.equity > peakEquity) peakEquity = state.equity;
    if (cooldownLeft > 0) cooldownLeft -= 1;
    if (benchLeft > 0) benchLeft -= 1;
    if (state.warmingUp) return orders;

    const barsLeft = WINDOW_BARS - state.seq;

    // Drawdown guard first: protect the book before anything else speaks.
    if (peakEquity > 0n && state.equity * 100n < peakEquity * BigInt(Math.round((1 - GUARD_DROP) * 100))) {
      if (!isFlat) {
        const exit = buildSellAll(state);
        if (exit !== null) orders.push(exit);
      }
      if (benchLeft === 0) benchLeft = GUARD_BENCH_BARS;
      peakEquity = state.equity;
      return orders;
    }

    // Holding something: only exits are considered on this bar.
    if (!isFlat) {
      const gain = positionGain(state);
      const take = heldKind === 'dip' ? DIP_TAKE : SCALP_TAKE;
      const stop = heldKind === 'dip' ? DIP_STOP : SCALP_STOP;
      const maxHold = heldKind === 'dip' ? DIP_MAX_HOLD : SCALP_MAX_HOLD;
      const mustExit =
        (gain !== null && gain >= take) ||
        (gain !== null && gain <= -stop) ||
        heldBars >= maxHold;
      if (mustExit) {
        const exit = buildSellAll(state);
        if (exit !== null) {
          orders.push(exit);
          if (heldKind === 'scalp') cooldownLeft = COOLDOWN_BARS;
        }
      }
      return orders;
    }

    // Flat: entries only outside the bench, the cooldown and the late cutoff.
    if (benchLeft > 0 || cooldownLeft > 0) return orders;
    if (barsLeft <= LATE_CUTOFF) return orders;

    // Dip engine gets first claim on a flat book: a flush is the rarer,
    // larger signal, and it should not be crowded out by a scalp trigger.
    const hourly = trailingReturn(DIP_LONG_BARS);
    const shortDrop = trailingReturn(DIP_SHORT_BARS);
    const lastStep = trailingReturn(1);
    const flushed = hourly !== null && hourly <= -DIP_LONG_DROP;
    const snapped =
      shortDrop !== null && shortDrop <= -DIP_SHORT_DROP && lastStep !== null && lastStep > 0;
    if (flushed || snapped) {
      const entry = buildBuy(state, DIP_STAKE);
      if (entry !== null) {
        orders.push(entry);
        pendingKind = 'dip';
      }
      return orders;
    }

    // Pullback scalp engine: the trailing window sagged past the trigger,
    // so buy the dip in miniature and play the snap-back.
    const sag = trailingReturn(SCALP_LOOKBACK);
    if (sag !== null && sag <= -SCALP_TRIGGER) {
      const entry = buildBuy(state, SCALP_STAKE);
      if (entry !== null) {
        orders.push(entry);
        pendingKind = 'scalp';
      }
    }
    return orders;
  },
});
