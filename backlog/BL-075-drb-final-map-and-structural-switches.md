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
- **Result:** pending.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — before any BL-075 result was read: rounding made explicit (largest remainder), so the cells (10, 0, baseline) and (0, 10, baseline) are exactly BL-073's 10/34/33/23 and BL-074 (a)'s 0/10/34/33/23. Regressions: P1 baseline ₹4,30,868 / P90 ₹2,70,198; P2 through `--window-to` ₹1,70,015 / P50 ₹1,98,170 / P90 ₹2,94,240 (identical to BL-071 part A). Stage 1 launched 12:21 IST, chained into stage 2.
