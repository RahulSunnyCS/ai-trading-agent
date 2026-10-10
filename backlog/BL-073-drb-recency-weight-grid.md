# BL-073 — How much recency? A fixed grid of recent-return weight and fit lookbacks, judged by the worst period

| | |
|---|---|
| **Priority** | P2 — options research; closes the BL-067 → BL-072 series |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-071 (hold-out and slice), BL-069/072 (lookbacks) |
| **TODO.md row** | — |

## Context

Across three periods the DRB ranking beats random picks whenever the weekday / days-to-expiry / VIX fit
criteria are in it, but the recent-return criterion helped in 2025-09 → 2026-10 (+₹2.0 lakh) and hurt in
2022-04 → 2024-10 (−₹2.5 lakh) and Jan–Aug 2025 (−₹1.3 lakh). The owner (2026-10-10) asked for one more
backtest on the recency weight rather than leaving it to the forward journal, and for the fit lookbacks
5/21/63/126. All three periods have been read, so this is **not a search**: a fixed grid, every row run
on every period, and the winner declared by its *worst* period.

## Plan

### Phase 0 — Pre-register
- **Rows (fixed, 8):** recent weight R ∈ {0, 10, 20, 33}, the remainder split over weekday / dte / VIX in
  the baseline's 25:25:17 proportion (rounded to whole percents); fit lookbacks L ∈ {5:40,21:30,63:30
  (current), 5:30,21:25,63:25,126:20 (owner's)}. Weights: R=0 → 0/37/37/26; R=10 → 10/34/33/23;
  R=20 → 20/30/30/20; R=33 → 33/25/25/17.
- **Periods:** P1 in-sample 2025-12-03 → 2026-10-08 (202 days, 248 variants); P2 Jan–Aug 2025 slice
  (157 days, `--window-from 2024-10-09`); P3 hold-out 2022-04-05 → 2024-10-08 (618 days, NIFTY-only,
  `--nifty-only --early-results`). Gross, DRB-6W3L2 shape, random comparator per period as before.
- **Read-out (the only one):** for each row and period, its gross as a fraction of the best row's gross
  in that period (relative score). The **robust row is the one with the highest minimum relative score
  across the three periods**; it is *adopted as a journal list* only if that minimum is ≥ 0.85 and the
  row beats the random P90 in all three periods. Drawdown is reported, not scored. No other ranking of
  the rows is read.
- **Will not run:** other weights, other lookbacks, any row added after seeing a result.
- **Result:** pending.

## Log

- 2026-10-10 — created and registered before any run.
