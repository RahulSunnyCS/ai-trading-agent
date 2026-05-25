# Pipeline Progress

**Task:** Complete Milestone 5 (Phase 2) — T-43 S/R detection, T-44 Levelhead, T-45 multi-index, T-46 Bayesian optimization
**Lane:** feature-full · **Risk:** MEDIUM · **Sprints:** 3 · **Gates:** 3
**Effort:** default per CLAUDE.md table (Planning + Red Team = max)
**recommendation_rounds_used:** 0

## Phase State

- [x] Phase 0 — Triage (risk_manifest.json written)
- [x] Phase 1 — Planning + Red Team (3 sprints, 8.75/10) + QA Planner → **Gate 1 APPROVED**
- [x] Phase 2 — Decomposition (6 contracts: T-43-A/B/C, T-44, T-45, T-46)
- [~] Phase 3 — Implementation
  - [x] Wave 1: T-43-A (committed), T-46 (committed; hybrid-objective rework in flight per user)
  - [x] Wave 2: T-43-B + T-44 done — 193 signals tests green (sr-levels 53 + filter/router incl. sr_anchored + ACTIVE_PHASE). Per-index leg cap confirmed correct (paper_trades.symbol = underlying).
  - [x] T-46 hybrid-objective rework committed (93 tests green). LIMITATION: backtest-runner hardcodes adjustedProbability=0.7 → finalist scoring can't discriminate yet (Gate-2 follow-up).
  - [x] Wave 3: T-43-C (S/R detection engine) committed — 39 tests. Found integration leak: SR signals (signal_type=PULLBACK) would route to momentum_exhaustion personalities.
  - [x] Wave 4: T-45 (multi-index) committed — 1019 tests green. Phase 3 COMPLETE.
- [~] Phase 4: security + performance + architecture reviewers running in parallel vs c1b5b48..HEAD. → Human Gate 2 next.
  - Gate-2 carries: (1) migration 013 expiry weekdays need live NSE/BSE verification; (2) backtest-runner hardcodes adjustedProbability=0.7 (T-46 finalist scoring inert until fixed); (3) T-43-C session-boundary level reload (levels load once per engine lifetime — stale across midnight); (4) T-43-C minHistoryBars=500 default.
  - [ ] Wave 3: T-43-C
  - [ ] Wave 4: T-45
  - Gate-2 carry: migration 013 expiry weekdays need live NSE/BSE verification (T-45 symbol-resolution assert is the runtime net)

## Gate 1 Decisions (locked)
- **D1 — Bayesian optimizer:** Option B — guarded deterministic 1-D search (golden-section over [0.30,0.90]); full GP deferred to multi-param milestone.
- **D2 — Multi-index risk caps:** Option A — per-index caps (each index an independent book); global circuit-breaker deferred to M6 (T-50).
- **Optional recommendations:** none accepted (recommendation_rounds_used stays 0).
- Rebased onto origin/main @ c1b5b48 before decomposition.
- [ ] Phase 3 — Implementation
- [ ] Phase 4 — Specialist Review → Human Gate 2
- [ ] Phase 5 — Test Generation
- [ ] Phase 6 — Test Execution + Automation Gate
- [ ] Phase 7 — Final Review → Human Gate 3
