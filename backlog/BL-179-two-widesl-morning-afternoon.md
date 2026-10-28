# BL-179 — Two Wide SL a day: the top morning one and the top afternoon one, against Adaptive

| | |
|---|---|
| **Priority** | P2 — a direct owner question about the live picks; two fixed rules, no search |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-28 |
| **Depends on** | BL-058 (the rotation lists and stored results), BL-113 (the T1 track), BL-178 |
| **TODO.md row** | — |

## Context

The owner (2026-10-28): trade two Wide SL strategies a day, the best-ranked one entering in the
morning (09:30–12:00) and the best-ranked one entering in the afternoon (13:00–15:30), leaving
12:00–13:00 out. Then the same without the break. On Core and on Adaptive tuned (T1).

## Goal

For each pool and each rule, the daily net beside Adaptive's over the same days, with the same
costs, and a verdict under the rule below.

## Out of scope

Changing the live pick. Other windows, other ranks, a third strategy, lots other than one.

## Plan

### Phase 0 — Pre-register

#### 2026-10-28 — Morning + afternoon Wide SL vs Adaptive
- **Hypothesis:** one Wide SL from the morning and one from the afternoon, each the best by
  Adaptive's own ranking, earn more per strategy-lot than Adaptive's three picks.
- **Ranking:** Adaptive's composite (list C, `pick._rank`), computed over the whole pool on the
  history before each day, unchanged.
- **Wide SL:** what Adaptive counts as Widesl (`variants.is_wide`): `wide` and the
  closest-premium families (Core p80, p100, p250, p320; T1's wide-t1s4, wide-t1s8, p150, p285).
- **Rule G (with the break):** the highest-composite Wide SL entering 09:30–11:59 (slots 0932 to
  1147) plus the highest entering 13:00–15:30 (1302 to 1517). 09:17 is outside both.
- **Rule N (no break):** the same morning pick, plus the highest entering 12:00–15:30 (1202 to
  1517).
- **Expiring-index rule:** on the days Adaptive applies it (from 2026-10-19, one index expiring),
  both picks come from that index only, as Adaptive's picks do. Ties broken by name.
- **Universe:** Core = Core-298; T1 = Core-298 plus the T1 track's variants, as `pick --track t1`.
- **Comparator:** Adaptive's three core picks re-scored for the same day (checked against the
  journal in BL-178).
- **Measure:** one lot each, net of estimated brokerage (`lot_plans.brokerage`). Primary: net per
  strategy-lot a day (the day's net divided by its number of picks: 2 for G and N, 3 for
  Adaptive), so the comparison holds the money per lot equal. The day's total is reported too.
- **Period:** 2025-10-28 to 2026-10-27, the sessions every variant of the pool has (239).
- **Look-ahead check:** the composite reads only rows before the day; the window is fixed by the
  variant's entry time, known before the open.
- **Pass / kill rule (per pool, per rule):** difference = rule minus Adaptive, per strategy-lot,
  daily. Pass: mean > 0 and the 5-day block-bootstrap 90% interval (5,000 resamples, seed 179)
  above zero. Kill: mean ≤ 0. Otherwise inconclusive. Four tests (2 rules × 2 pools); a pass on
  one of four is weak evidence. G against N is reported, not tested.
- **Hold-out:** none. The period was already looked at (the Wide SL entry-window table and BL-178,
  both 2026-10-28), and Adaptive's weights were chosen on P1 (Dec 2025 – Oct 2026), which favours
  Adaptive. The window edges are the owner's, set after seeing that table.
- **Will not run:** other window edges, 09:17 in the morning window, top-2 per window, other
  rankings. Each needs a new block, or `override: <reason>` in the Log.

#### Result
(after the run)

## Risks

One year; the windows were proposed after a table of this same year.

## Log

- 2026-10-28 — created and pre-registered at the owner's request.
