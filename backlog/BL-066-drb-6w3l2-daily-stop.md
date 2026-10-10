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
  picks from `daily_picks_min3_core6_buy2L2_whole_day.csv`). Each strategy's own overall MTM stop stays: per 1 lot Widesl
  (OTM and closest premium) ₹2,500, Dir ATM ₹3,000, Buy ₹2,000 (checked in the strategy files); a 2-lot strategy is modelled as
  twice the 1-lot result, so its stop is ₹5,000 / ₹6,000 / ₹4,000. The engine closes a strategy at the end of the bar in which it
  crosses its stop, so it can lose more than the stop (₹3,490 against ₹2,500 on 2026-07-15).
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

### 2026-10-09 (later) — Tighter levels: ₹8k, ₹6k, ₹4k
Added after the first block's result was read; nothing else in the rule changes.
- **Rule, basket, charges, outputs, "helps" test:** exactly as above; the curves already recorded are reused.
- **Levels:** X ∈ {8,000, 6,000, 4,000}.
- **Hold-out:** none (owner override). **Will not run:** other levels.
- **Result:** **no level helps**, and the tighter the worse. Days whose intraday low reached −8k / −6k / −4k: 50 / 72 / 96 of
  202. Against no stop (gross ₹4,30,868, drawdown −₹68,294): **₹8k** gross ₹4,56,348 (+5.9%), drawdown −₹81,905 (+19.9%
  deeper), worst day −₹13,696, 50 days stopped (25 would have finished better unstopped), net ₹3,75,887 (+28.9%),
  net drawdown −₹99,752, worst month −2.46%; **₹6k** ₹3,61,524 (−16.1%), −₹68,554 (+0.4%), −₹13,696, 72 days (37
  whipsaws), net ₹2,81,063 (+21.6%), net drawdown −₹82,573; **₹4k** ₹3,09,007 (−28.3%), −₹95,090 (+39.2%), −₹11,464,
  96 days (50 whipsaws), net ₹2,28,546 (+17.6%), net drawdown −₹1,11,266, worst month −3.85%. Stopped days made, with
  the stop vs without: ₹8k −₹4,56,479 vs −₹4,81,959 (+₹25,480), ₹6k −₹5,06,971 vs −₹4,37,627 (−₹69,344), ₹4k −₹4,85,070
  vs −₹3,63,208 (−₹1,21,861). Average loss on a stopped day against the level: ₹8k −₹9,130, ₹6k −₹7,041, ₹4k −₹5,053
  (overshoot of 14–26%). The ₹8k stop fired mostly 11:00–14:00. Across all eight levels tried (4k to 20k) the effect on
  total is not monotonic (₹8k and ₹10k positive, ₹12k negative), which fits noise, not a signal.

### 2026-10-09 (later) — Why the ₹8k stop's worst day is −₹13,696, and a best-case fill
Added after the owner questioned the number. Not a rule change: a check and a sensitivity.
- **Check:** every recorded curve ends exactly at its strategy's final P&L (the gap is ₹0 on all 654 picks), and the
  combined curves reproduce DRB-6W3L2's stored P&L. The −₹13,696 is real data: on 2026-07-15 the combined
  P&L went +₹2,826 (12:54) → −₹4,128 (12:55) → −₹13,696 (12:56); two SENSEX closest-premium strategies hit their own ₹2,500
  stops in the 12:56 bar (₹3,490 and ₹2,671 a lot), a ₹9,568 fall in one bar. No bar closed between −₹4k and −₹13.7k, so a
  stop that acts on bar closes cannot fire at −₹8k. Over the 202 days the largest one-minute fall of the combined path
  has a median of −₹2,202, a 90th percentile of −₹5,394 and a worst of −₹14,444; 66 days fell more than ₹3k in a minute,
  22 more than ₹5k, 5 more than ₹8k. 2026-09-01 shows the same (−₹7,631 → −₹13,526 at 13:50).
- **Best-case sensitivity (`stops.py --fill-at-level`):** the stop fills exactly at −X when a bar crosses it. Gross vs
  no stop / drawdown vs no stop: ₹4k −4.8% / −3.2%; ₹6k +1.3% / −15.7%; ₹8k +19.0% / +6.8%; ₹10k +9.8% / +12.6%; ₹12k
  +4.1% / +14.8%; ₹15k +2.8% / −3.9%; ₹17k +1.4% / −1.3%; ₹20k none. Net after charges: ₹4k ₹3,29,615, ₹6k ₹3,56,034
  (+27.4%, drawdown −₹70,777), ₹8k ₹4,32,366 (+33.3%, −₹88,180), ₹10k ₹3,92,422, ₹12k ₹3,67,911, ₹15k ₹3,62,591,
  ₹17k ₹3,56,422 (no stop ₹3,50,407, −₹84,469). **No level reaches the 25%-smaller-drawdown bar even in the best
  case**; ₹6k comes closest (−15.7% with the total 1.3% higher). The real behaviour of a live stop lies between the
  two fill assumptions and depends on how it is implemented (AlgoTest has no portfolio-wide stop).

### 2026-10-09 (later still) — A trailing stop: ₹16k, with ₹12k and ₹20k beside it
Added after the fixed-level results were read; the owner asked about "a 16k trailing stop loss".
- **Rule:** the day's combined mark-to-market path as above. The stop is **X below the day's highest combined P&L so
  far** (the highest is at least 0, the start of the day): at each minute t the stop level is
  `max(0, highest combined P&L through minute t−1) − X`; the first minute whose combined value is at or below that level
  closes everything at that minute's combined value, and nothing re-enters. So it behaves as a fixed −X stop until the
  day has made money, then follows the peak up. X ∈ {16,000 (asked), 12,000, 20,000 (bracketing)}.
- **Fill:** two assumptions, as in the fixed-level test: close of the bar (default) and exactly at the level (best case).
- **Everything else, outputs and the "helps" test:** as above. **Hold-out:** none (owner override). **Will not run:** other
  trail sizes, trailing in steps, a profit target.
- **Owner's note:** "1:1" read as the trail ratio (the stop rises ₹1 for each ₹1 the day's combined profit rises), which is
  what this rule does.
- **Result:** **no trailing level passes**; exploratory (same already-seen year). `stops.py --trail`; with the trail off it reproduces
  the fixed-level results exactly. Against no stop (gross ₹4,30,868, drawdown −₹68,294, worst day −₹19,368, net ₹3,50,407):
  **₹16k trail, close-of-bar fill:** 25 days stopped (14 would have finished better unstopped), gross ₹4,23,584 (−1.7%),
  drawdown −₹75,390 (10.4% deeper), worst day −₹18,824, net ₹3,43,122 (+26.4%), net drawdown −₹95,391; **best-case fill at the
  level:** gross ₹4,52,797 (+5.1%), drawdown −₹70,411 (+3.1%), worst day −₹16,000, net ₹3,72,335 (+28.6%). **₹12k trail:** 47
  days, close-of-bar gross ₹4,24,273 (−1.5%), drawdown −₹58,598 (**14.2% smaller**), net ₹3,43,811, net drawdown −₹71,821;
  best case gross ₹4,70,292 (+9.1%), drawdown −₹54,295 (**20.5% smaller**, the closest to the 25% bar of any stop tried),
  net ₹3,89,831 (+30.0%). **₹20k trail:** 11 days, close-of-bar −3.2% / drawdown 11.6% deeper, best case −0.3% / 11.2% deeper.
  The trail adds stops on days that rose and then gave back ₹12–16k (25 days at ₹16k against 13 for the fixed ₹15k), which
  is where it differs from the fixed stop.

### 2026-10-09 (last) — Trailing that starts after the day's profit reaches ₹5k
Added after the plain trailing result was read, at the owner's request.
- **Rule:** a fixed stop at −X until the day's best combined profit exceeds the activation A = ₹5,000; above that the
  stop rises ₹1 for every extra ₹1 of best profit, never falls back. Stop level at minute t =
  −X + max(0, best combined P&L through minute t−1 − A). X = 16,000 (asked), with 12,000 and 20,000 beside it.
  With A = 0 this is the plain trailing stop above (checked: same numbers). The alternative reading, where the stop jumps
  up to (best profit − X) at the moment ₹5k is reached, is not run.
- **Fill, outputs, "helps" test, hold-out:** as above (both fill assumptions). **Will not run:** other activation levels.
- **Result:** **no level passes**; exploratory (same already-seen year). `stops.py --trail --activate 5000`; check: activation 0 reproduces the
  plain ₹16k trail (₹4,23,584, −₹75,390, 25 days). Reference, the plain fixed ₹16k stop: 9 days, gross ₹4,29,729 (−0.3%), drawdown
  −₹66,766 (2.2% smaller). Against no stop (gross ₹4,30,868, drawdown −₹68,294, net ₹3,50,407): **₹16k, trailing after ₹5k, close-of-bar fill:**
  14 days stopped (5 would have finished better unstopped), gross ₹4,20,148 (−2.5%), drawdown −₹75,568 (10.7% deeper), worst day
  −₹18,824, net ₹3,39,687 (+26.1%), net drawdown −₹90,144; **best-case fill at the level:** gross ₹4,32,495 (+0.4%), drawdown −₹75,050
  (+9.9%), worst day −₹16,000, net ₹3,52,034 (+27.1%). **₹12k:** 29 days, close-of-bar +0.9% / drawdown 17.2% deeper, best case +9.4% /
  4.8% deeper. **₹20k:** 3 days, close-of-bar +0.0% / −0.8%, best case +1.1% / drawdown 3.3% smaller. With activation the trail fires on
  14 days instead of 25 (plain trail) and behaves much like the fixed stop at the same X; it does not reduce the drawdown.

## Log

- 2026-10-09 — created from the owner's request.
- 2026-10-09 — curves recorded and the five levels evaluated (Result above).
