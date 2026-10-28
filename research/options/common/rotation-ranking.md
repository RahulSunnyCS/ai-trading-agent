# Options: rotation ranking (DRB and lists A / B / C / REF)

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

Each morning before 09:17, score every rotation variant (strategy family × index × start time) and
trade the top few. **DRB, the Daily Ranked Basket** ([BL-064][bl064]): a composite of percentile ranks
of (1) **own recent P&L** (⅔ last 5 days + ⅓ the 5 before), (2) **weekday fit**, (3) **days-to-expiry
fit** (weekdays to the nearest expiry since 2026-10-16, [BL-109][bl109]), (4) **VIX-band fit** (09:15 open), and since BL-074 (5) **family-band recent** (recent P&L pooled
over strategy type × start-time band). A *fit* is the variant's average P&L on past days that match
today, over several lookbacks (5 / 21 / 63, later 5 / 21 / 63 / 126 days). Core = top Widesl / Dir picks
with at least 2 Widesl; Buy is added only when a Buy variant is in the overall top 10.

## Live value (the forward journal, [BL-058][bl058] Phase 0b)

298 variants (248 + 50 Dir ITM1), DRB-6W3L2 shape: 3 strategies × 2 lots, at least 2 Widesl, the Buy
add-on as one 2-lot strategy. Picks recorded at 09:16 in a hash-chained journal from Mon 2026-10-12.

| List | Own recent | Weekday | DTE | VIX | Family-band | Lookbacks |
|---|---|---|---|---|---|---|
| A (Steady) | 5 | 34 | 33 | 23 | 5 | 5:30, 21:25, 63:25, 126:20 |
| B (Calendar) | 0 | 36 | 35 | 24 | 5 | same |
| C (Adaptive) | 15 | 30 | 30 | 20 | 5 | same |
| REF (Baseline) | 33 | 25 | 25 | 17 | 0 | 5:40, 21:30, 63:30 |

Primary yardstick: the **fixed base** (2 × NIFTY Widesl OTM1 09:17 + 1 × Dir ATM 09:24, 2 lots each).
A list beats it at the 60-day read-out if the 5-day block-bootstrap 90% interval of (list − base) in ₹
per lot-day is above zero and its drawdown per lot is no worse.

## Tested (gross unless stated; comparators: R = random picks of the same shape, E = equal weight)

| Item | Question | Verdict | Evidence |
|---|---|---|---|
| BL-054 | Weekly: top 5 by 2-week P&L, 33 NIFTY variants | **Killed**: 79th percentile of random; rank persistence +0.025 | [BL-054][bl054] |
| BL-057 | Daily four criteria, 66 variants (09:17–11:47) | **Inconclusive**: beats 98% of random, drawdown ₹1,058 worse than E | [BL-057][bl057] |
| BL-062 | Same rule, whole day, 248 variants | **Pass** (exploratory): ₹3,36,113, beats 100% of random; 31% of lots start 12:02+ and make 45% of core P&L | [BL-062][bl062] |
| BL-064 / 065 | 6 lots; 3 strategies × 2 lots | 6W2 / 6W3 pass; 6W3L2 inconclusive (E drawdown) | [BL-064][bl064], [BL-065][bl065] |
| BL-067 | 16-row weight map | Recent return carries the edge; nothing beats the baseline beyond noise | [BL-067][bl067] |
| BL-068 | Lag, reverse, label placebo | Recent is short-term momentum, stable in P1; weekday / DTE / VIX fits not shown real (1 of 20 label shuffles beats the true labels); PBO 0.42–0.49 | [BL-068][bl068] |
| BL-069 / 070 | New ingredients; no per-strategy stops | None beats the baseline; edge survives without stops, smaller margin | [BL-069][bl069], [BL-070][bl070] |
| BL-071 A | P2 (Jan–Aug 2025) | **Not confirmed**: baseline − no-recent −₹1,26,882; baseline below the random median | [BL-071][bl071] |
| BL-071 B | **Hold-out** P3, NIFTY 2022-04 → 2024-10, 618 days | Recent edge **fails** (−₹2,47,680, interval wholly negative); no-recent best each year; rows keeping the fits beat random P90 | [BL-071][bl071] |
| BL-072 / 073 / 074 | Blends, recency grid, family-band recent | Blend candidate killed by hold-out; recent 10% + 126-day lookback and own 0 / family 10 are above chance in all three periods | [BL-072][bl072], [BL-073][bl073], [BL-074][bl074] |
| BL-075 | 100-cell map × 3 periods; switches; shuffles | 19 of 100 cells above chance everywhere, none robust; no switch adopted (Buy off: 0 of 19 improve, 6 fall below chance); 3 of top 10 real, list A among them; no cell reaches 0.85 | [BL-075][bl075] |
| BL-080 | Wider closest-premium families; Dir ITM1 | Extra premiums harmful; Dir ITM1 useful → 298 universe; 58 of 100 cells above chance in all periods | [BL-080][bl080] |
| BL-100 | Pools restricted to the BL-099 families, on P3 | **Planned, not run** | [BL-100][bl100] |
| BL-106 | The lists over a first-year-selected candidate pool (New-536, registered; New-556 with NIFTY ITM sets, exploratory) vs the 298, test year 2025-10-09 → 2026-10-09, gross | **No list won** on New-536: every interval straddles zero (about ±₹200 a day). Adaptive ₹393 on Core-298 vs ₹292 on New-536 and ₹324 on New-556; New-556's drawdown was shallower (−8.6k vs −10.1k) in one path, descriptive only. The lists were fitted inside the test year, which favours Core-298 | [BL-106][bl106] |
| BL-109 | Days to expiry counted in weekdays (Sat and Sun skipped) instead of calendar days | Adopted as **no worse**, not better: over 238 days (2025-10-16 → 2026-10-15) Adaptive +₹406 → +₹430 per lot-day, newer minus older +₹25 [-₹6, +₹63]; Steady +₹395 → +₹406, +₹11 [-₹16, +₹46]; Adaptive drawdown 6% deeper (limit 20%); in-sample, lists fitted on calendar labels | [BL-109][bl109] |
| BL-129 | Order inside Adaptive's picks: Widesl rank 1 (higher composite) vs rank 2; rank 1 at two lots instead of both | **Not positive**: rank 1 earned less than rank 2 over 2025-01 → 2026-10 (Core-298 −₹183 [−339, −36], T1 −₹200 [−388, −1] per lot-day); rank 2 is usually the Widesl the minimum swapped in, so this says the forced-in Widesl earned at least as much as the one picked on merit. The doubled book is not better (intervals include zero) even after ~₹100/day saved brokerage | [BL-129][bl129] |
| BL-130 | Merge two same-index Widesl picks within 30 minutes into one two-lot entry at the earlier time | Core-298: no effect beyond the brokerage (intervals include zero). T1: the earlier entry earned more, merge +₹107 [+30, +186] (identical strategies) / +₹290 [+141, +437] (any Widesl, deeper drawdown) per one-lot day over two years; last year +90 / +217, the first inconclusive. Partly in T1's selection year | [BL-130][bl130] |
| BL-133 | A fourth lot on non-expiry days (3 on expiry days): Core's Dir at two lots or an added Dir; T1's top / lowest Widesl at two lots, an added Widesl, or (owner override) its Dir at two lots; against the same size spread evenly | Core Dir ×2 beat the even spread (after brokerage +₹149 [+14, +279] two years, +₹230 [+90, +379] last year) but the top 10 days carry 68 % of it; no T1 Widesl placement beat it (lowest Widesl ×2 −₹95 / −₹105, an added Widesl −₹129 / −₹194); T1's Dir ×2 (owner override) +₹98 [−20, +215] / +₹150 [+27, +270], two-thirds of it from 5 days. In-sample | [BL-133][bl133] |
| BL-134 | Two strategies a day: top Widesl ×2 + Dir (×2 normal days, ×1 expiry) vs three picks with the Dir doubled | T1 worse (−₹254 [−486, −30] / −₹330 [−621, −55] net per day); Core inconclusive (−₹152 [−392, +62] / +₹128 [−87, +337]); its −70k drawdown is one early stretch (2025-01 → 2025-05), outside which P is slightly ahead. The ~₹100/day brokerage saved does not pay for the dropped Widesl | [BL-134][bl134] |
| BL-154 | Adaptive's weekday / DTE / VIX fits shrunk toward the variant's own window mean by n/(n+10); plus opening-gap and previous-day-range bands (÷ ATR, terciles) at weight 10 from weekday; P1 decides, 20 label shuffles | **Killed**: on P1 shrinkage −₹24 per lot-day [−116, +75], 1 of 20 shuffles above it, drawdown 21% deeper; labels −₹20 [−91, +48]. Out of P1 shrinkage is wholly negative (P2 −₹172 [−321, −38], whole span −₹71 [−146, −1]); the more weight on the plain mean, the worse. Today's fits beat all 20 label shuffles on P2 and the whole span (17 of 20 on P1). Gross, 431 days 2025-01 → 2026-10 | [BL-154][bl154] |
| BL-090 | A cap in `select`: no two core picks above trailing 63-day Pearson 0.5 / 0.6 / 0.7, lists A / B / C / REF, on BL-075's P1 / P2 / P3 (248 variants, P3 NIFTY only); pass = drawdown 10% shallower with net at most 5% lower in 2 of 3 periods | **Killed** for all 12 cells (best: 1 period). Drawdown is often shallower but net falls; in P2 every cap loses 28%–105% of net. Before charges, lists in-sample | [BL-090][bl090] |
| BL-167 | ITM2 Dir added to the Adaptive universe (Core-298; Core-298 + T1), in-sample, 431 days | **No gain**: Core −₹57 a day (interval −235 to +118), T1 −₹74 (−258 to +108); Core drawdown 25% shallower, T1's 11% deeper; 75–78% of Core's ITM1 picks and 51–58% of its ATM picks are dropped (ITM2 enters in their place) | [BL-167][bl167] |

## What we know

- With the weekday / days-to-expiry / VIX fits in it, the ranking beat random picks of the same shape
  on the 2022–24 hold-out (baseline beats 100%, P90 ₹8,65,554). That is the most solid result here.
- The fits' small samples are not noise to be smoothed away (BL-154): shrinking them toward each
  variant's own mean (k = 10) lowered Adaptive in every period, most out of the period its weights
  came from.
  Today's Adaptive beat all 20 label shuffles on Jan–Aug 2025 and on 2025-01 → 2026-10 (17 of 20 on
  P1), so the fits look more real out of period than BL-068's P1-only shuffle suggested.
- Own recent return is momentum that worked in 2025-12 → 2026-10 and **subtracted** in Jan–Aug 2025 and
  in 2022–24. Lists A, B and C keep it small (0–15%) for that reason; REF keeps the old 33%.
- The rule is fragile: few weight cells are above chance in every period, and which one is best is not
  knowable from one year (PBO near 0.5). Adding Dir ITM1 made it much less fragile (58% of cells).
- Charges: lists A / B / C / REF pay ₹80–81k each in P1 at ₹13 an order ([charges](charges.md)).
- In-sample comparison only, not BL-100's test: over 2025-10-09 → 2026-10-09 the full pool earned more
  per lot-day than both restricted pools for every list (A ₹383.6 full vs ₹309.1 / ₹268.6), gross
  (`research/bl100/replay_lastyear.csv`, committed).

## Not yet tested

- The forward read-out after 60 trading days from 2026-10-12 (the only unseen test).
- BL-100 on P3.

## Related

- [Intraday state](intraday-state.md) (re-timing picks after 09:16), [portfolio stop](portfolio-stop.md),
  [Buy](../strategies/buy-breakout/README.md) (the add-on).
- Code: `src/option_backtesting/rotation/` (`score.py`, `lists.py`, `pick.py`), `research/bl057/rotate.py`.
  Picks and per-day outputs are git-ignored; regenerate with `rotate.py --basket …`.

[bl054]: ../../../backlog/BL-054-weekly-strategy-slot-rotation.md
[bl057]: ../../../backlog/BL-057-daily-four-criteria-rotation.md
[bl058]: ../../../backlog/BL-058-options-rotation-forward-journal-and-ui.md
[bl062]: ../../../backlog/BL-062-whole-day-rotation.md
[bl064]: ../../../backlog/BL-064-drb-daily-ranked-basket.md
[bl065]: ../../../backlog/BL-065-drb-two-lots-per-strategy.md
[bl067]: ../../../backlog/BL-067-drb-weight-map.md
[bl068]: ../../../backlog/BL-068-drb-recent-controls-and-label-placebo.md
[bl069]: ../../../backlog/BL-069-drb-new-ingredients.md
[bl070]: ../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl071]: ../../../backlog/BL-071-drb-out-of-period-and-2022-import.md
[bl072]: ../../../backlog/BL-072-drb-blend-long-fit-lookbacks.md
[bl073]: ../../../backlog/BL-073-drb-recency-weight-grid.md
[bl074]: ../../../backlog/BL-074-drb-family-by-type-and-start-band.md
[bl075]: ../../../backlog/BL-075-drb-final-map-and-structural-switches.md
[bl080]: ../../../backlog/BL-080-drb-wider-closest-premium-families.md
[bl109]: ../../../backlog/BL-109-rotation-weekday-dte.md
[bl100]: ../../../backlog/BL-100-restricted-rotation-lists-p3.md
[bl106]: ../../../backlog/BL-106-pool-picker-poc.md
[bl129]: ../../../backlog/BL-129-widesl-rank-one-doubled.md
[bl130]: ../../../backlog/BL-130-merge-close-widesl-picks.md
[bl133]: ../../../backlog/BL-133-fourth-lot-on-normal-days.md
[bl134]: ../../../backlog/BL-134-two-strategy-book.md
[bl154]: ../../../backlog/BL-154-adaptive-fit-shrinkage.md
[bl090]: ../../../backlog/BL-090-strategy-correlation-and-diverse-baskets.md
[bl167]: ../../../backlog/BL-167-itm2-in-adaptive-and-t1.md
