# BL-066 — Daily stop-loss levels for DRB-6W3L2 (₹10k, ₹12k, ₹15k, ₹17k, ₹20k)

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-065 and BL-055 |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-065 (DRB-6W3L2 picks), BL-055 (the stop mechanism), BL-063 (charges) |
| **TODO.md row** | — |

## Context

The owner (2026-10-09 chat) asked which daily stop-loss to use on DRB-6W3L2 and named ₹10k, ₹12k, ₹15k,
₹17k and ₹20k (1% of ₹13 lakh is ₹13k). BL-055 tested ₹8k / ₹10k / ₹12.5k on the 5-lot mixes and found
the stop mostly trims the worst day.

## Plan

### Phase 0 — Pre-register
- **Basket:** DRB-6W3L2 exactly as in BL-065 (3 strategies × 2 lots + the Buy strategy × 2 lots when it fires;
  picks from `daily_picks_min3_core6_buy2L2_whole_day.csv`). The engine's own per-strategy overall stop
  (₹2,500 per lot) stays; for a 2-lot strategy it is therefore ₹5,000.
- **Rule (as BL-055):** each minute the day's combined mark-to-market is the sum over the picks of
  2 × (its 1-lot curve: 0 before it starts, its realised P&L after it ends). The first minute it is ≤ −X,
  everything is closed at that minute's combined value and nothing starts or re-enters that day. X ∈
  {10,000, 12,000, 15,000, 17,000, 20,000}. Strategies not yet started when the stop fires do not start.
- **Re-run:** each (variant, day) pick is re-run one day at a time to read its per-minute curve; the curve's
  final value must equal the stored gross for every pair.
- **Charges:** the unstopped day's charges (BL-063, flat ₹13 per order) are used for every day, which
  slightly overstates them on stopped days (fewer orders if a later strategy never starts). Reported before
  and after charges.
- **Outputs:** per level: days stopped, total and net P&L (₹, % of ₹13 lakh), max drawdown, worst day, worst
  month, days that would have finished better without the stop ("whipsaws") and what they cost, average loss
  on a stopped day against X (minute-bar overshoot); the 10 worst unstopped days with each level's result.
- **Pass / kill rule:** BL-055's "helps": drawdown at least 25% smaller and total at most 10% lower than no
  stop. Reported per level; descriptive otherwise.
- **Hold-out:** none (owner override). **Will not run:** other levels, trailing or time-based stops, re-entry
  after a stop, a stop inside AlgoTest (AlgoTest's overall stop is per strategy, so a portfolio stop needs
  separate automation).
- **Result:** (after the run)

## Log

- 2026-10-09 — created from the owner's request.
