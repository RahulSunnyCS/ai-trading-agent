# BL-075 — The final map: 100 weightings × 3 periods, then the structural switches on the robust region

| | |
|---|---|
| **Priority** | P2 — options research; the last backtest before the forward journal |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-065, BL-071, BL-073, BL-074 |
| **TODO.md row** | — |

## Context

BL-067 → BL-074 ran about 110 configurations on three periods (P1 2025-12-03 → 2026-10-08, the year the
rule was built on, 202 days; P2 2025-01-10 → 2025-08-29, 157 days; P3 NIFTY-only 2022-04-05 →
2024-10-08, 618 days). Two candidates are above the random P90 in all three — recent 10 / — / 34 / 33 / 23
(BL-073) and own 0 / family-band 10 / 34 / 33 / 23 (BL-074), both on fit lookbacks 5:30,21:25,63:25,126:20
— and nothing met the 0.85 worst-period bar. Each is a single cell with no tested neighbours, and the
structure (Widesl minimum, Buy add-on, closest-premium variants) was never varied. The owner (2026-10-10)
asked for a final map, staged: the 100-cell weight map first, then the structural switches tried on
whatever it finds.

## Plan

### Phase 0 — Pre-register
- **Stage 1 cells:** own-recent {0, 5, 10, 15, 20} × family-band recent {0, 5, 10, 15, 20} × fit split of
  the remaining weight {baseline 25:25:17, equal 1:1:1, no-VIX 1:1:0, dte-heavy 1:2:1} = 100 cells;
  weekday / dte / VIX shares are the remainder split in the stated ratio, rounded to whole percents by the
  largest-remainder method (ties to the first criterion; reproduces BL-073/074's weights exactly); lookbacks 5:30,21:25,63:25,126:20; basket DRB-6W3L2, 248 variants, Buy on.
  Each cell on P1, P2, P3 (300 runs); rotate.py's own random comparator on each period via `--window-to`.
- **Stage 1 read-out:** per cell the worst-period relative score (gross ÷ best cell's gross in that
  period) and above-P90-in-all-three; *fragility* = the share of the 100 above chance everywhere, overall
  and per fit split; *robust region* = cells above chance everywhere whose recency-axis neighbours
  (±5 own, ±5 family, same split) are also above chance everywhere; the two candidates' position.
- **Hand-off:** the cells above chance in all three periods ranked by worst-period score; the top 50 (the
  top 10 by worst-period score if fewer than 10 qualify) go to stage 2, written to
  `research/bl075/out/stage1_top.csv` before stage 2 starts.
- **Stage 2 switches:** Widesl minimum {2 strategies, none (`DRB-6W0L2`)} × Buy add-on {on, `--no-buy`} ×
  closest-premium variants {in (248), out (`--no-closest`, 148)}: 7 non-current combinations × the stage-1
  cells × 3 periods (≤ 1,050 runs).
- **Stage 2 read-out:** per switch, the fraction of the stage-1 cells whose worst-period score improves
  when the switch is flipped, and the number pushed below chance in any period. A switch is *adopted for
  the final rule* only if it improves ≥ 70% of the cells and pushes none below chance. The *final
  structure* = the current one with every adopted switch flipped; the *final region* = the robust-region
  rule re-applied at the final structure. Reported: gross ÷ max-drawdown map; per-calendar-year gross
  (2022 … 2026) of the top 10 cells.
- **Stage 3:** 10 label shuffles per period for the top 10 cells of the final region (300 runs; *real*
  only if above all 10 in every period); one charges pass (flat ₹13 an order) for the top 3.
- **Adoption:** the centre of the largest final region becomes a forward-journal list if its worst-period
  score ≥ 0.85 and it is real under the shuffles in every period; otherwise the map is the result.
  Nothing goes live from this item.
- **Hold-out:** none left: every period has been read. Honest label: a fragility map and a structure
  check, not a validation.
- **Will not run:** other lookbacks, finer weight steps, other families, stop levels, the ladder.
- **Result, stage 1 (2026-10-10 13:05; 300 runs, 40 minutes):** **the rule is fragile: 19 of the 100
  cells are above the random P90 in all three periods, and none sits in a robust region.**

  | Fit split | Cells | Above chance in all three | Robust | Best worst-period score |
  |---|---|---|---|---|
  | baseline 25:25:17 | 25 | 8 | 0 | 0.819 |
  | dte-heavy 1:2:1 | 25 | 6 | 0 | 0.761 |
  | equal 1:1:1 | 25 | 5 | 0 | 0.733 |
  | no VIX 1:1:0 | 25 | **0** | 0 | 0.694 |

  Best period scores (the denominators): P1 ₹5,53,890; P2 ₹3,51,201; P3 ₹13,15,791. Above chance by
  period, over all 100 cells: P1 98%, P3 100%, **P2 (Jan–Aug 2025) 19%** — the slice is what removes
  almost every cell.
  - **Plateau or spike:** the BL-073 candidate (own 10 / family 0, baseline split) is above chance
    everywhere, worst-period score 0.627, **not robust**; BL-074 (a) (own 0 / family 10) likewise, 0.577,
    not robust. Both are isolated cells: at least one recency-axis neighbour is below chance in some period.
  - **Where the above-chance cells sit:** family-band weight 5 holds 55% of them (10 of 20 cells at
    family 5), family 15 and 20 none; own-recent 0–10 holds 20–30% each, own 15–20 5–10%. The best
    worst-period cell (own 15 / family 10, baseline split, 0.819) fails chance in one period. **VIX out
    (no-VIX split) is above chance in all three periods in none of 25 cells**: with 5/21/63/126 lookbacks
    the VIX-band criterion cannot be dropped, unlike BL-067's no-VIX row (5/21/63 lookbacks, 33% recency).
  - **Nothing reaches the 0.85 worst-period bar;** the best above-chance cell is own 15 / family 5,
    baseline split (0.772). The 19 chance-clearing cells go to stage 2 (fewer than 50, more than 10).

- **Result, stage 2 (2026-10-10 13:50; 399 runs on the 19 stage-1 cells × 7 structures × 3 periods):**
  **no switch is adopted; the structure stays as it is (Widesl minimum 2, Buy add-on on, closest-premium
  variants in).** Fraction of the 19 cells whose worst-period score improves, and cells pushed below
  chance in some period, when one switch is flipped (adopt only if ≥ 70% improve and none fall):

  | Switch flipped | Improved | Below chance | Mean worst-period score (was 0.624) |
  |---|---|---|---|
  | Widesl minimum 2 → none | **74%** (14 of 19) | **1** | 0.663 |
  | Buy add-on on → off | 0% | 6 | 0.594 |
  | closest-premium variants in → out | 16% | 17 | 0.554 |
  | none + Buy off | 53% | 1 | 0.633 |
  | none + closest out | 63% | 10 | 0.670 |
  | Buy off + closest out | 11% | 14 | 0.515 |
  | all three | 53% | 12 | 0.631 |

  - **Buy add-on and the closest-premium variants earn their place:** removing either pushes 6 and 17
    of the 19 cells below chance in at least one period.
  - **The Widesl minimum is borderline:** dropping it raises the worst-period score of 14 of 19 cells
    (mean +0.04) and clears the 70% bar, but one cell falls below chance in one period, which the
    registered rule forbids. Not adopted; it is the one open structural question for the journal.
  - **Final structure = the current one.** The best cell per structure: current (stage 1) own 15 /
    family 5, baseline split, 0.772; no minimum, own 15 / family 5, 0.723; no minimum + closest out,
    own 5 / family 5, 0.763 (only 9 of 19 cells above chance everywhere).

### Block 2 — the combined A+B+C ranking (2026-10-10, registered before its runs)
- **Why:** the owner asked what a strategy that ranks every variant under A, B and C and sums the ranks
  would do (a rank-aggregation of the three journal lists).
- **Rule:** each variant's composite under A, B and C is turned into a percentile rank among the 248
  variants; the combined score is the mean of the three ranks; selection as DRB-6W3L2 (top 3 strategies
  × 2 lots, at least 2 Widesl, Buy add-on when a Buy ranks in the top 10). `rotate.py --ensemble
  "5,34,33,23,0,5;0,36,35,24,0,5;15,30,30,20,0,5"` with the lists' lookbacks 5:30,21:25,63:25,126:20 and
  the band family.
- **Periods and read-out:** BL-075's three periods; the combined row's gross, max drawdown and win %
  beside A, B and C (stage-1 cells o5_f5, o0_f5, o15_f5 on the baseline split) and the mean of the
  three. It is *worth a journal list* only if its gross is ≥ the mean of A, B, C in every period **and**
  it is above the random P90 in every period. Reported: the share of days its three strategies differ
  from each member's.
- **Will not run:** other combinations, other aggregations (median, product).
- **Result:** pending.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — before any BL-075 result was read: rounding made explicit (largest remainder), so the cells (10, 0, baseline) and (0, 10, baseline) are exactly BL-073's 10/34/33/23 and BL-074 (a)'s 0/10/34/33/23. Regressions: P1 baseline ₹4,30,868 / P90 ₹2,70,198; P2 through `--window-to` ₹1,70,015 / P50 ₹1,98,170 / P90 ₹2,94,240 (identical to BL-071 part A). Stage 1 launched 12:21 IST, chained into stage 2.
- 2026-10-10 — stage 1 done (13:05): 19 of 100 cells above chance everywhere, 0 robust; stage 2 running on those 19 cells.
- 2026-10-10 — stage 2 done (13:50): no switch adopted. Stage 3 (shuffles on the top 10 cells) launched; journal lists A, B, C (all in the top 10) are fixed from stage 1.
