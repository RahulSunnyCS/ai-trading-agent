# BL-067 — Which of DRB's four ranking criteria carry the edge? A 16-row weight map

| | |
|---|---|
| **Priority** | P2 — options research; sharpens the BL-064/065 basket, does not block Momentum |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-064 (DRB), BL-065 (DRB-6W3L2) |
| **TODO.md row** | — |

## Context

DRB ranks the 248 variants each day by four criteria, percentile-ranked and weighted: recent return 33%
(two-thirds last 5 days, one-third the 5 before), weekday fit 25%, days-to-expiry fit 25%, VIX-band fit
17% (fit = average P&L on matching days over the last 5 / 21 / 63 days, 40/30/30). The 33/25/25/17 split
was set once in BL-057 and never tuned. The owner (2026-10-10 chat) asked for 10–15 combinations laid out
so that, if there is an edge in one criterion, the map shows it. Earlier diagnostics (Spearman of each
criterion rank with same-day P&L) were all small and positive: recent +0.07, weekday +0.05, dte +0.04,
vix +0.05. The same already-studied window is used again, so this is exploratory and the best row is not
adopted on this run.

## Goal

A table of 16 weightings of DRB-6W3L2 (gross, net at flat ₹13 an order, drawdown, win %, worst week, the
three BL-057 conditions) and a verdict per criterion: carries an edge, dead weight, or unclear.

## Out of scope

New criteria, other lookbacks inside a criterion, other baskets, the closest-premium / grid / pool
variants of BL-065, any change to the live strategies.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** at least one criterion alone ranks variants better than random, and the baseline blend
  is not worse than its best single criterion.
- **Universe / rule:** DRB-6W3L2 exactly as BL-065 (248 variants, 3 core strategies × 2 lots, at least
  2 Widesl, one Buy strategy when a Buy ranks in the top 10, window 2025-09-01 → 2026-10-08, 202
  selection days from 2025-12-03, per-strategy stops, charges at flat ₹13 an order). Only the four
  weights change (recent / weekday / dte / vix, percent): 0 baseline 33/25/25/17; 1 recent-only
  100/0/0/0; 2 weekday-only 0/100/0/0; 3 dte-only 0/0/100/0; 4 vix-only 0/0/0/100; 5 equal 25/25/25/25;
  6 no-recent 0/33/33/34; 7 no-vix 40/30/30/0; 8 no-weekday 40/0/30/30; 9 no-dte 40/30/0/30; 10
  recent+dte 50/0/50/0; 11 recent+weekday 50/50/0/0; 12 recent+vix 50/0/0/50; 13 calendar-only
  0/50/50/0; 14 recent-heavy 60/13/14/13; 15 recent-light 15/28/28/29. `rotate.py --basket DRB-6W3L2
  --weights R,W,D,V`. Ties in a single-criterion row break by variant name (the existing rule).
- **Look-ahead check:** unchanged from BL-057: scores read only rows before the day (plus the day's own
  weekday, VIX band and days to expiry, known before the first entry).
- **Read-out (per criterion):** *has an edge* if its corner row (1–4) beats the random P90 total and
  dropping it from the baseline (rows 7–9, and row 6 for recent) lowers net by more than 5%. *Dead
  weight* if its corner is inside the random P50–P90 band and dropping it leaves net within 5% of the
  baseline. Otherwise *unclear*. Rows 5, 10–15 are reported as the shape of the blend.
- **Multiple comparisons:** 16 rows on one year; the spread between the four corners is the yardstick
  for a real difference. A row that beats the baseline by less than that spread is noise. No row is
  adopted from this run; a winner becomes a candidate for the BL-058 forward journal only.
- **Pass / kill:** none for the basket (descriptive). The BL-057 three conditions are reported per row.
- **Hold-out:** none (owner override: the same already-seen window, as BL-053 to BL-066).
- **Will not run:** other weights, other lookbacks, a search over the simplex, any combination with the
  BL-065 variants (closest-premium removal, top-25% pool, 30-minute grid).

### Phase 1 — Run
- **Tasks:** `--weights` flag in rotate.py; `research/bl067/run_all.py` runs the 16 rows; trades and
  charges through `research/bl063/`.
- **Deliverables:** `research/bl067/out/summary.csv`; Result below.
- **Done when:** 16 rows have gross and net; the baseline row reproduces BL-065's ₹4,30,868 / ₹3,50,407.

## Risks

Single-criterion rows tie heavily (many variants share a weekday/VIX fit of 0 early on), so their picks
lean on the name tie-break; read the corner rows as "this criterion alone" with that caveat.

## Open questions

None.

## Log

- 2026-10-10 — created from the owner's request for 10–15 weight combinations; 16 rows registered before
  any run.
