# BL-073 — How much recency? A fixed grid of recent-return weight and fit lookbacks, judged by the worst period

| | |
|---|---|
| **Priority** | P2 — options research; closes the BL-067 → BL-072 series |
| **Status** | Done — nothing meets the adoption bar; recent 10% with 5/21/63/126 is the only row above chance in all three periods (journal candidate) |
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
- **Result (2026-10-10, gross):** **no row meets the adoption bar; recent 10% with 5/21/63/126 comes
  closest and is the only row above chance in all three periods.** Relative score = gross ÷ the best row's
  gross in that period; P90 = random picks of the same shape.

  | Recent | Lookbacks | P1 2025-12→2026-10 (202 d) | P2 Jan–Aug 2025 (157 d) | P3 2022-04→2024-10 (618 d) | Min rel | Mean rel | ≥ P90 everywhere |
  |---|---|---|---|---|---|---|---|
  | 0 | 5/21/63 | 2,18,410 (0.50) ✗ | 2,80,604 (0.89) ✗ | 12,36,724 (0.97) ✓ | 0.50 | 0.79 | no |
  | 0 | 5/21/63/126 | 2,63,442 (0.61) ✓ | 2,69,734 (0.86) ✗ | 12,57,862 (0.99) ✓ | 0.61 | 0.82 | no |
  | **10** | **5/21/63/126** | 3,47,323 (0.80) ✓ | **3,14,099 (1.00)** ✓ | **12,72,319 (1.00)** ✓ | **0.80** | **0.93** | **yes** |
  | 10 | 5/21/63 | 2,98,733 (0.69) ✓ | 2,71,086 (0.86) ✗ | 12,58,993 (0.99) ✓ | 0.69 | 0.85 | no |
  | 20 | 5/21/63/126 | 3,94,053 (0.91) ✓ | 2,63,941 (0.84) ✗ | 11,62,457 (0.91) ✓ | 0.84 | 0.89 | no |
  | 20 | 5/21/63 | 3,23,611 (0.74) ✓ | 2,19,640 (0.70) ✗ | 11,33,148 (0.89) ✓ | 0.70 | 0.78 | no |
  | 33 | 5/21/63/126 | **4,34,745 (1.00)** ✓ | 2,10,304 (0.67) ✗ | 9,93,269 (0.78) ✓ | 0.67 | 0.82 | no |
  | 33 (baseline) | 5/21/63 | 4,30,868 (0.99) ✓ | 1,70,015 (0.54) ✗ | 10,13,627 (0.80) ✓ | 0.54 | 0.78 | no |

  Drawdowns (reported, not scored): recent 10 / 126 has −74,842 / −67,030 / −48,841 across the periods,
  the shallowest hold-out drawdown of the eight; the baseline −68,294 / −88,366 / −56,329.
  - **Adoption rule:** min ≥ 0.85 **and** ≥ P90 everywhere. Recent 20 / 126 has the highest minimum
    (0.84) but is below P90 on Jan–Aug 2025; recent 10 / 126 is the only row ≥ P90 in all three periods
    but its minimum is 0.80 (in-sample it makes 80% of the best). **Nothing is adopted by the rule.**
  - **Two regularities, read after the fact and therefore not conclusions:** (i) the 126-day window
    helps at every recency weight (mean relative score up 0.03–0.08 in each pair) — the owner's 5/21/63/126
    suggestion was right; (ii) recency is monotone across periods: more recent weight is better in
    2025–26 and worse in both other periods, which is why only a low, non-zero weight is above chance
    everywhere.
  - **Recommendation to the owner, outside the rule:** recent 10 / 5:30,21:25,63:25,126:20 is the best
    evidence we have for a middle weighting; adding it to the forward journal as a fourth list costs
    nothing and lets unseen days judge it. Not a live change.

### Block 2 — the 5-day fit window at 0% (2026-10-10, registered before its runs)
- **Why:** the owner asked what happens if the 5-day window is dropped from the fit lookbacks. Known:
  with recency 33% (BL-069 B3) it helped on 2025–26 and Jan–Aug 2025 and failed the 2022–24 hold-out.
  Unknown: with recency 10%, the row block 1 singled out.
- **Rows (fixed, 2):** recent 10 (10/34/33/23) and recent 20 (20/30/30/20), fit lookbacks
  21:36,63:36,126:28 (block 1's 25/25/20 for 21/63/126 rescaled to 100, the 5-day window at 0); the
  three periods as block 1.
- **Read-out:** block 1's rule (minimum relative score vs the eight block-1 rows plus these two; adopt only
  if ≥ 0.85 and ≥ P90 everywhere). Read beside the same recency weight with the 5-day window kept.
- **Will not run:** other splits of the remaining weight.
- **Result (2026-10-10, gross; relative scores recomputed against the best of all ten rows per period —
  P1 best is now recent 20 / 21:63:126 at ₹4,86,802, P2 ₹3,14,099, P3 ₹12,72,319):**

  | Recent | Lookbacks | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022-04→2024-10 | Min rel | ≥ P90 everywhere |
  |---|---|---|---|---|---|---|
  | 10 | 5/21/63/126 (block 1) | 3,47,323 (0.71) ✓ | 3,14,099 (1.00) ✓ | 12,72,319 (1.00) ✓ | 0.71 | **yes** |
  | 10 | 21/63/126, no 5-day | 3,82,026 (0.78) ✓ | 2,78,979 (0.89) ✗ | 12,28,826 (0.97) ✓ | 0.78 | no |
  | 20 | 5/21/63/126 (block 1) | 3,94,053 (0.81) ✓ | 2,63,941 (0.84) ✗ | 11,62,457 (0.91) ✓ | 0.81 | no |
  | 20 | 21/63/126, no 5-day | **4,86,802 (1.00)** ✓ | 2,34,458 (0.75) ✗ | 9,88,372 (0.78) ✓ | 0.75 | no |

  Dropping the 5-day window moves P&L **toward the in-sample year and away from both other periods** at
  both recency weights (recent 10: +₹35k in-sample, −₹35k on the slice, −₹43k on the hold-out; recent 20:
  +₹93k, −₹29k, −₹1.74 lakh) — the same pattern as BL-069 B3. Nothing meets the adoption bar; recent 10 /
  5:21:63:126 remains the only row above chance in all three periods (its minimum falls to 0.71 only
  because the new row raised the in-sample best). **Keep the 5-day window.** The 2025-12 → 2026-10 year
  rewards reacting within a week (recency, and the 5-day fit window); the other 2½ years penalise it.

### Block 3 — a 10-day window in place of the 5-day (2026-10-10, registered before its runs)
- **Why:** block 2 showed the 5-day window matters out of period; the owner asked whether 10 days does
  the same job with less noise (a 10-day window holds ~2 matching weekdays instead of ~1).
- **Rows (fixed, 2):** recent 10 (10/34/33/23) and recent 20 (20/30/30/20), fit lookbacks
  10:30,21:25,63:25,126:20; the three periods as block 1.
- **Read-out:** block 1's rule, relative to the best of all twelve rows per period; read beside the same
  recency weight with 5:30,21:25,63:25,126:20.
- **Will not run:** other first-window lengths.
- **Result (2026-10-10, gross; relative to the best of all twelve rows per period: P1 ₹4,86,802, P2
  ₹3,14,099, P3 ₹12,72,319):** the 10-day window is worse than the 5-day on both out-of-period sets.

  | Recent | First window | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022-04→2024-10 | Min rel | ≥ P90 everywhere |
  |---|---|---|---|---|---|---|
  | 10 | 5 days (block 1) | 3,47,323 (0.71) ✓ | **3,14,099 (1.00)** ✓ | **12,72,319 (1.00)** ✓ | 0.71 | **yes** |
  | 10 | 10 days | 3,58,436 (0.74) ✓ | 1,99,937 (0.64) ✗ | 11,20,218 (0.88) ✓ | 0.64 | no |
  | 20 | 5 days (block 1) | 3,94,053 (0.81) ✓ | 2,63,941 (0.84) ✗ | 11,62,457 (0.91) ✓ | 0.81 | no |
  | 20 | 10 days | 4,13,582 (0.85) ✓ | 2,03,974 (0.65) ✗ | 10,70,299 (0.84) ✓ | 0.65 | no |

  Recent 10: +₹11k in-sample, **−₹1,14,162 on the slice** (below chance), −₹1,52,101 on the hold-out.
  Recent 20: +₹20k, −₹60k, −₹92k. Three blocks now agree: the first fit window should be the 5-day one;
  lengthening it (10) or removing it (block 2) trades the two out-of-period sets for the in-sample year.
  Nothing adopted; recent 10 / 5:30,21:25,63:25,126:20 stays the only row above chance in all three
  periods. The series is closed here.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — 24 runs done; Result above. Series BL-067 → BL-073 closed; next evidence is the forward journal (BL-058).
- 2026-10-10 — block 2 (5-day window at 0%) ran: shifts P&L toward the in-sample year, away from the other two; keep the window.
- 2026-10-10 — block 3 (10-day first window) ran: worse than the 5-day out of period; keep 5. Closed.
