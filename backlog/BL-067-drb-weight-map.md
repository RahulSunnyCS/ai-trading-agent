# BL-067 — Which of DRB's four ranking criteria carry the edge? A 16-row weight map

| | |
|---|---|
| **Priority** | P2 — options research; sharpens the BL-064/065 basket, does not block Momentum |
| **Status** | Done — recent return carries the edge; no row beats the baseline beyond noise |
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

### Result (2026-10-10)

Baseline row reproduces BL-065 exactly (gross ₹4,30,868, drawdown −₹68,294, net ₹3,50,407). Gross → net after
charges at flat ₹13 an order (net drawdown, net ÷ drawdown, months positive, worst month); random-pick P90
₹2.57–2.70 lakh in every row. Weights are recent/weekday/dte/vix.

| # | Row | Weights | Gross | Net | Net DD | Net÷DD | Months+ | Worst month | BL-057 verdict |
|---|---|---|---|---|---|---|---|---|---|
| 0 | baseline | 33/25/25/17 | 4,30,868 | 3,50,407 (+27.0%) | −84,469 | 4.1 | 8/11 | −1.7% | Inconclusive |
| 1 | recent only | 100/0/0/0 | 3,15,861 | 2,33,188 (+17.9%) | −134,924 | 1.7 | 8/11 | −2.8% | Inconclusive |
| 2 | weekday only | 0/100/0/0 | 2,65,902 | 1,85,669 (+14.3%) | −120,270 | 1.5 | 7/11 | −5.7% | Kill |
| 3 | dte only | 0/0/100/0 | 2,37,445 | 1,56,523 (+12.0%) | −136,359 | 1.1 | 8/11 | −6.4% | Kill |
| 4 | vix only | 0/0/0/100 | 2,01,990 | 1,19,972 (+9.2%) | −143,387 | 0.8 | 6/11 | −3.3% | Kill |
| 5 | equal | 25/25/25/25 | 3,48,114 | 2,66,746 (+20.5%) | −103,193 | 2.6 | 7/11 | −1.6% | Inconclusive |
| 6 | no recent | 0/33/33/34 | 2,26,105 | 1,45,008 (+11.2%) | −103,918 | 1.4 | 7/11 | −3.9% | Kill |
| 7 | no vix | 40/30/30/0 | 4,35,207 | 3,54,050 (+27.2%) | −63,662 | 5.6 | 8/11 | −2.5% | Pass |
| 8 | no weekday | 40/0/30/30 | 3,44,255 | 2,63,134 (+20.2%) | −109,717 | 2.4 | 7/11 | −2.2% | Inconclusive |
| 9 | no dte | 40/30/0/30 | 3,04,751 | 2,23,974 (+17.2%) | −112,853 | 2.0 | 8/11 | −2.6% | Inconclusive |
| 10 | recent + dte | 50/0/50/0 | 3,67,962 | 2,86,530 (+22.0%) | −71,696 | 4.0 | 8/11 | −2.7% | Pass |
| 11 | recent + weekday | 50/50/0/0 | 3,46,132 | 2,64,722 (+20.4%) | −90,614 | 2.9 | 8/11 | −2.9% | Inconclusive |
| 12 | recent + vix | 50/0/0/50 | 3,34,249 | 2,52,661 (+19.4%) | −142,433 | 1.8 | 9/11 | −5.6% | Inconclusive |
| 13 | calendar only | 0/50/50/0 | 2,85,530 | 2,04,537 (+15.7%) | −119,857 | 1.7 | 8/11 | −5.4% | Inconclusive |
| 14 | recent-heavy | 60/13/14/13 | 4,19,119 | 3,38,543 (+26.0%) | −80,102 | 4.2 | 8/11 | −1.5% | Inconclusive |
| 15 | recent-light | 15/28/28/29 | 3,12,943 | 2,31,719 (+17.8%) | −89,630 | 2.6 | 8/11 | −2.2% | Inconclusive |

Per-criterion verdicts under the registered rules:
- **Recent return: has an edge.** Its corner (₹3,15,861 gross) clears the random P90 (₹2,64,143) and
  dropping it (row 6) cuts net by 59% (₹3,50,407 → ₹1,45,008). Every row keeping recent at ≥ 40% makes
  ₹3.0–4.4 lakh gross; every row without it ₹2.0–2.9 lakh. Recent alone has the worst drawdown of the
  blends (−₹100,936 gross / −₹134,924 net).
- **Weekday, days to expiry, VIX band: dead weight alone.** Each corner is below the random P90 and is
  killed. Weekday and dte add value only on top of recent: dropping weekday (row 8) costs 25% of net,
  dropping dte (row 9) 36%. Dropping VIX (row 7) changes net by +1% (₹3,54,050 vs ₹3,50,407) and gives the
  shallowest drawdown of all 16 (−₹63,662, net ÷ drawdown 5.6). VIX is the weakest criterion; recent + VIX
  (row 12) has the deepest drawdown of the blends (−₹142,433 net).
- **Blend shape.** Recent + dte (row 10) is the best two-criterion blend: net ₹2,86,530, drawdown −₹71,696,
  best worst week (−₹26,050 gross). Equal weights (row 5) are 24% below the baseline on net. Recent-heavy
  60/13/14/13 is within 3% of the baseline on net.
- **Against the yardstick.** The spread between the four corners is ₹2.0–3.2 lakh gross; row 7 beats the
  baseline by ₹4k gross / ₹3.6k net, far inside it. Nothing in the 16 rows is a real improvement on the
  baseline; the only large effect is recent versus not recent.
- **Adoption:** none from this run. Row 7 (no VIX) is a candidate for the BL-058 forward journal only,
  beside the baseline. Picks files `research/bl057/daily_picks_min3_core6_buy2L2_whole_day_w*.csv`; summaries
  `research/bl067/out/summary.csv` and `net_summary.csv`; runs `research/bl067/run_all.py`.

## Risks

Single-criterion rows tie heavily (many variants share a weekday/VIX fit of 0 early on), so their picks
lean on the name tie-break; read the corner rows as "this criterion alone" with that caveat.

## Open questions

None.

## Log

- 2026-10-10 — created from the owner's request for 10–15 weight combinations; 16 rows registered before
  any run.
- 2026-10-10 — ran all 16 rows; baseline reproduces BL-065; Result above. Nothing adopted.
