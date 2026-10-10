# BL-074 — Family recent pooled by strategy type and start-time band (index- and strike-agnostic)

| | |
|---|---|
| **Priority** | P2 — options research; the owner's variant of BL-069 B1 |
| **Status** | Done — row (a) is above chance in all three periods (second such row); nothing meets the adoption bar; journal candidate |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-073 (candidate row and periods), BL-069 B1 (the dropped family pooling) |
| **TODO.md row** | — |

## Context

BL-069 B1 pooled a variant's recent score over its family defined as index + strike rule across all
start times; it was the worst-travelling idea of the series. The owner (2026-10-10) proposed a different
family: strategy **type** × **start-time band**, pooled across NIFTY and SENSEX and across OTM and
closest-premium strikes — "is morning short-premium working right now?". It keeps the start-time
information the earlier pooling erased and pools what shares a regime.

## Plan

### Phase 0 — Pre-register
- **Family key:** type ∈ {Widesl (OTM and closest-premium together), Dir, Buy} × band ∈ {09:17–10:02,
  10:17–12:02, 12:17–14:02, 14:17–15:17} → 12 families. The family's recent score is the mean of its
  members' recent scores (⅔ last 5 days + ⅓ the 5 before), computed from earlier rows only.
- **Rows (fixed, 3), weights own-recent / family-recent / weekday / dte / VIX, all fit lookbacks
  5:30,21:25,63:25,126:20:** (a) 0/10/34/33/23; (b) 10/10/30/30/20; (c) 10/20/26/26/18.
- **Periods and read-out:** BL-073's three periods and its rule (relative score against the best row per
  period over BL-073's twelve rows plus these three; adopt as a journal list only if the minimum is
  ≥ 0.85 and the row beats the random P90 in all three periods). Read beside the BL-073 candidate
  (10/—/34/33/23).
- **Will not run:** other bands, other weights, family pooling of the fit criteria.
- **Result (2026-10-10, gross; relative to the best of all fifteen rows per period — P1 ₹4,86,802,
  P2 now ₹3,45,861 (row a), P3 ₹12,72,319):** **row (a) is a second row above chance in all three
  periods; nothing meets the adoption bar.**

  | Row (own / family-band / weekday / dte / VIX) | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022-04→2024-10 | Min rel | Mean rel | ≥ P90 everywhere |
  |---|---|---|---|---|---|---|
  | **(a) 0 / 10 / 34 / 33 / 23** | 3,19,785 (0.66) ✓ | **3,45,861 (1.00)** ✓ | 11,44,736 (0.90) ✓ | 0.66 | 0.85 | **yes** |
  | (b) 10 / 10 / 30 / 30 / 20 | 4,57,784 (0.94) ✓ | 2,69,764 (0.78) ✗ | 11,16,990 (0.88) ✓ | 0.78 | 0.87 | no |
  | (c) 10 / 20 / 26 / 26 / 18 | 4,56,030 (0.94) ✓ | 2,34,195 (0.68) ✗ | 10,47,141 (0.82) ✓ | 0.68 | 0.81 | no |
  | BL-073 candidate 10 / — / 34 / 33 / 23 | 3,47,323 (0.71) ✓ | 3,14,099 (0.91) ✓ | 12,72,319 (1.00) ✓ | 0.71 | 0.87 | yes |

  Drawdowns: (a) −91,790 / −70,347 / −51,909; (b) −78,095 / −75,993 / −56,258; candidate −74,842 /
  −67,030 / −48,841.
  - The owner's family (type × start band, index- and strike-agnostic) **travels where BL-069's family
    (index × strike rule) did not**: with own-recent at 0 and the family at 10% it is above chance in
    all three periods and sets the best Jan–Aug 2025 result of the series (₹3,45,861 vs the slice's
    random P90 ₹2,94,240). Its weakness is the in-sample year (0.66), where own-recent carries more.
  - Adding own-recent back (rows b, c) buys the in-sample year (₹4.57 lakh, 0.94) and loses the slice
    (below P90 by ₹24k and ₹60k) — the recency pattern again.
  - Against the BL-073 candidate: same mean score (0.85 vs 0.87), the candidate better on the hold-out
    (1.00 vs 0.90) and drawdowns, (a) better on the slice. Neither reaches a 0.85 minimum. Both are
    journal candidates; (a) is the one that carries the owner's regime question ("is morning
    short-premium working?") and is worth a journal list for that reason.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — 9 runs done; Result above.
