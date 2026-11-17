# TapeRunner — cbBTC bars-replay bot

A long-only trading bot for the `agent-fun/bars-replay/v1` protocol: it reads one
JSON line per 1-minute cbBTC bar (hello, then batch after batch carrying bars,
fills and the account) and answers each batch with buy/sell orders. Orders fill
at the next bar's open with a 4 bps fee, 2 bps slippage and constant-product
price impact against the pool depth, so every round trip costs roughly 20–26 bps
and the strategy is built around that friction.

## Strategy

Two engines share one book (at most one open position, no leverage):

1. **Pullback scalper (the core).** Local grading on the dev window showed that
   chasing upward momentum at 1-minute scale loses to the ~20+ bps round-trip
   cost, while pullbacks in this tape snap back often enough to clear it. So the
   core fades a measured slide: when the trailing 90-bar return sags to about
   −0.20% or lower, the bot buys roughly 50% of equity. It exits at about +0.8%
   over cost, −1.5% under cost, or after 180 bars. That keeps the bot trading
   regularly in ordinary tape instead of waiting for a rare episode. A short
   cooldown (3 bars) separates scalp round trips. The parameters sit in a broad
   plateau on the dev window (neighbouring lookbacks, thresholds and exits all
   grade positive), rather than on a single lucky spike.

2. **Capitulation dip buyer.** On a sharp flush — the trailing 60-bar return at
   or below −1.5%, or a steep 10-bar drop (≤ −1.0%) followed by a first uptick —
   it buys about 50% of equity and holds for a bigger bounce: exit near +1.5%,
   stop near −2.5%, or after 120 bars.

Safety rails shared by both engines:

- **Impact trim.** Every buy is shrunk until the vendor shim's impact estimate
  against the latest close depth (`c_depth`) is about 10 bps or less, so the bot
  never pays outsized slippage to itself.
- **Drawdown guard.** If equity falls about 8% from its peak, the position is
  flattened and new entries are benched for 300 bars — far inside the 25%
  drawdown guardrail.
- **Late-window cutoff.** No new entries in the last 60 bars of the 1,440-bar
  window.

## Runtime properties

- Node 22, standard library plus the vendored `vendor/makefun-bars.ts` shim only.
- No network, no wall clock, no environment reads, no randomness: the same bars
  always produce byte-identical orders.
- Run locally against the competition kit with:
  `node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process`
