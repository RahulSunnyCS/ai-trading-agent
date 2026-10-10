# BL-074 — Family recent pooled by strategy type and start-time band (index- and strike-agnostic)

| | |
|---|---|
| **Priority** | P2 — options research; the owner's variant of BL-069 B1 |
| **Status** | In progress |
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
- **Result:** pending.

## Log

- 2026-10-10 — created and registered before any run.
