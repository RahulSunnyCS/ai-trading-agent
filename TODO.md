# TODO — Milestone 5 (Phase 2)

> At-a-glance mirror of pipeline/tasks/ (orchestrator is sole writer). Phase 2 decomposition complete; awaiting go-ahead for implementation.

**Lane:** feature-full · **Risk:** MEDIUM · **Plan score:** 8.75/10
**Gate 1 decisions:** D1 = deterministic 1-D optimizer (GP deferred) · D2 = per-index risk caps

| Task | Title | Depends on | Files (owner) | Status |
|---|---|---|---|---|
| T-43-A | Schema & migrations (SR signal columns 012, expiry calendar 013) | — | migrations 012/013, schema.ts | ⬜ contract ready |
| T-43-B | S/R level computation + freshness guard | T-43-A | sr-levels.ts (new) | ⬜ contract ready |
| T-43-C | S/R detection engine (proximity → signal) | T-43-A, T-43-B | sr-detection-engine.ts (new) | ⬜ contract ready |
| T-44 | Levelhead activation (sr_anchored filter, ACTIVE_PHASE, per-index legs) | T-43-A | personality-filter.ts, personality-router.ts | ⬜ contract ready |
| T-45 | Multi-index — BankNifty + Sensex (instrument correctness, bootstrap, per-index stop) | T-43-A, T-43-C, T-44 | instrument-registry.ts, index.ts, portfolio-risk.ts | ⬜ contract ready |
| T-46 | Guarded deterministic 1-D optimizer (Bayesian-deferred) | — | optimizer.ts (new), evolution-engine.ts, eod-retrospection-job.ts | ⬜ contract ready |

**Parallel execution waves (no shared file writes within a wave):**
- Wave 1: **T-43-A** + **T-46** (independent file sets)
- Wave 2: **T-43-B** + **T-44** (after T-43-A)
- Wave 3: **T-43-C** (after T-43-B)
- Wave 4: **T-45** (after T-43-C, T-44)

**QA:** 🔴 22 critical · 🟡 20 functional · 🟢 8 non-blocker (pipeline/qa-checklist.md)
