# BL-066 — Daily stop-loss levels for DRB-6W3L2 (₹10k, ₹12k, ₹15k, ₹17k, ₹20k)

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-065 and BL-055 |
| **Status** | Done (no level helps; exploratory: same already-seen year, owner override) |
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
- **Result:** **no level helps** under BL-055's rule; exploratory (same already-seen year). 654 (variant, day) picks re-run
  (curves end at the stored gross on every pair; the combined curves reproduce DRB-6W3L2's ₹4,30,868). The deepest
  intraday combined loss in the 202 days was −₹19,368, so a ₹20,000 stop never fires. Days whose intraday low
  reached −10k / −12k / −15k / −17k / −20k: 38 / 28 / 13 / 6 / 0. **Gross** (no stop ₹4,30,868, max drawdown −₹68,294,
  worst day −₹19,368): ₹10k stop ₹4,47,497 (+3.9%), drawdown −₹80,626 (+18% deeper), worst day −₹13,696, 38 days
  stopped, 14 would have finished better unstopped; ₹12k ₹4,17,350 (−3.1%), −₹80,786 (+18%), −₹18,350, 28 days,
  15 whipsaws; ₹15k ₹4,33,287 (+0.6%), −₹69,399 (+1.6%), −₹18,824, 13 days, 4 whipsaws; ₹17k ₹4,29,715 (−0.3%),
  −₹67,689 (−0.9%), −₹19,368, 6 days, 2 whipsaws; ₹20k no change. **Net** after charges (flat ₹13 an order, the unstopped
  day's charges): none ₹3,50,407 (+27.0%, drawdown −₹84,469); ₹10k ₹3,67,036 (+28.2%, −₹96,801); ₹12k ₹3,36,889
  (+25.9%, −₹96,921); ₹15k ₹3,52,825 (+27.1%, −₹81,765); ₹17k ₹3,49,253 (+26.9%, −₹83,865). What the stopped days made
  with the stop vs without: ₹10k −₹4,05,386 vs −₹4,22,015 (+₹16,629), ₹12k −₹3,67,022 vs −₹3,53,505 (−₹13,518), ₹15k
  −₹2,04,766 vs −₹2,07,185 (+₹2,419), ₹17k −₹1,09,168 vs −₹1,08,015 (−₹1,154). Average loss on a stopped day against
  the level: ₹10k −₹10,668, ₹12k −₹13,108, ₹15k −₹15,751, ₹17k −₹18,195 (minute-bar overshoot of 7–9%). The ₹10k stop
  fired between 10:00 and 15:30, most often 11:00–14:00. The strategies' own overall stop (₹2,500 a lot) is
  already in the curves. Scripts: `research/bl066/` (`curves.py`, `stops.py`).

## Log

- 2026-10-09 — created from the owner's request.
- 2026-10-09 — curves recorded and the five levels evaluated (Result above).
