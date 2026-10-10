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
- **Result (2026-10-10 15:10, gross; random P90 of each combined run in brackets):** **not worth a
  separate journal list under the registered rule, but it behaves as a hedge: never the worst of the
  three lists and never the best.**

  | Period | A | B | C | Mean of A, B, C | **Combined A+B+C** | Max DD (combined) | ≥ P90 |
  |---|---|---|---|---|---|---|---|
  | P1 2025-12 → 2026-10 | 3,89,900 | 3,52,327 | 4,27,782 | 3,90,003 | **3,52,816** | −72,509 | yes (2,65,362) |
  | P2 Jan–Aug 2025 | 3,18,652 | 3,51,201 | 2,98,124 | 3,22,659 | **3,37,046** | −67,738 | yes (2,91,083) |
  | P3 2022-04 → 2024-10 | 12,20,482 | 12,39,935 | 11,58,525 | 12,06,314 | **12,30,836** | −68,042 | yes (8,76,076) |

  - **Rule (gross ≥ the mean of A, B, C in every period):** passes P2 (+₹14,387) and P3 (+₹24,522), fails
    P1 (−₹37,187). Not adopted as a fourth list.
  - **Against the best list in each period:** 0.82 (P1, C), 0.96 (P2, B), 0.99 (P3, B). **Against the
    worst:** at or above it in all three (P1 level with B, P2 and P3 above C). Drawdowns −72,509 /
    −67,738 / −68,042: the middle of the three lists in each period, with no period deeper than −73k.
  - So combining removes the choice between A, B and C rather than improving on them: the ensemble's
    worst case is better than the average member's worst case and its best case is worse than the best
    member's. The journal already records A, B and C separately, so the combination can be computed
    afterwards from their picks if wanted; nothing is lost by not recording it.

- **Result, stage 3 (2026-10-10 14:20; 300 runs): label shuffles on the top 10 cells (10 per cell and
  period; *real* = the true gross beats all 10 shuffled grosses in every period): 3 of 10 are real.**

  | Cell (own / family / split) | P1 true vs best shuffle | P2 true vs best shuffle | P3 true vs best shuffle | Real |
  |---|---|---|---|---|
  | **o5_f5 baseline (list A)** | 3,89,900 vs 3,73,009 | 3,18,652 vs 3,12,965 | 12,20,482 vs 10,02,607 | **yes** |
  | o10_f5 baseline | 3,86,308 vs 3,65,100 | 3,18,346 vs 2,95,093 | 12,14,125 vs 9,44,445 | **yes** |
  | o20_f5 baseline | 4,10,834 vs 3,58,581 | 2,99,702 vs 2,96,696 | 10,84,412 vs 9,38,430 | **yes** |
  | o15_f5 baseline (list C) | 4,27,782 vs 3,48,532 | **2,98,124 vs 3,01,951** | 11,58,525 vs 9,66,109 | no (P2 by ₹3.8k) |
  | o0_f5 baseline (list B) | **3,52,327 vs 3,98,438** | **3,51,201 vs 3,67,753** | 12,39,935 vs 10,23,330 | no (P1, P2) |
  | o10_f0 baseline (BL-073 candidate) | **3,47,323 vs 4,04,312** | 3,14,099 vs 3,43,674 | 12,72,319 vs 9,81,924 | no (P1, P2) |
  | o20_f5 dte-heavy | 3,86,539 vs 3,39,868 | 2,99,554 vs 3,03,563 | 10,66,303 vs 9,72,620 | no (P2) |
  | o0_f5 dte-heavy | 3,73,686 vs 4,16,995 | 3,49,111 vs 3,86,930 | 12,20,428 vs 10,38,306 | no (P1, P2) |
  | o5_f5 dte-heavy | 3,58,256 vs 3,74,131 | 3,00,580 vs 3,59,149 | 11,61,806 vs 10,01,918 | no |
  | o10_f5 equal | 3,56,325 vs 3,79,570 | 2,96,662 vs 3,10,868 | 11,60,641 vs 9,17,435 | no |

  - **The three real cells are all baseline split with family-band 5% and own-recent 5–20%** — the
    one corner of the map where the true labels clearly beat scrambled ones in all three periods.
    **List A is real. List C misses in Jan–Aug 2025 by ₹3.8k (the shuffle maximum is ₹3,01,951 against its
    ₹2,98,124). List B is not real: in P1 and P2 the best of ten scrambled-label runs beats it.**
  - The shuffles beat B and the BL-073 candidate even though they were the strongest cells out of period
    on gross, which is the reason to hold B and the "recent 10 / no family" row back from a live role;
    they stay in the journal as registered (Phase 0b allows no change), where unseen days judge them.
  - **Adoption (registered):** the centre of the largest final region becomes a journal list if its
    worst-period score ≥ 0.85 and it is real in every period. **No cell reaches 0.85** (best 0.77), so
    nothing is adopted; the map is the result: *a rule with a real, small edge in a narrow region (low
    own-recent, family-band 5%, baseline fit split, VIX band kept, 5/21/63/126 lookbacks)*.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — before any BL-075 result was read: rounding made explicit (largest remainder), so the cells (10, 0, baseline) and (0, 10, baseline) are exactly BL-073's 10/34/33/23 and BL-074 (a)'s 0/10/34/33/23. Regressions: P1 baseline ₹4,30,868 / P90 ₹2,70,198; P2 through `--window-to` ₹1,70,015 / P50 ₹1,98,170 / P90 ₹2,94,240 (identical to BL-071 part A). Stage 1 launched 12:21 IST, chained into stage 2.
- 2026-10-10 — stage 1 done (13:05): 19 of 100 cells above chance everywhere, 0 robust; stage 2 running on those 19 cells.
- 2026-10-10 — stage 2 done (13:50): no switch adopted. Stage 3 (shuffles on the top 10 cells) launched; journal lists A, B, C (all in the top 10) are fixed from stage 1.
- 2026-10-10 — block 2 (combined A+B+C) ran: a hedge, not an improvement; not adopted.
- 2026-10-10 — stage 3 done: 3 of the top 10 cells are real (list A among them); B and C are not. No cell meets the 0.85 adoption bar. Charges pass for A, B and C next.
