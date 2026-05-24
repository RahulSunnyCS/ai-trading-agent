# TODO — Milestone 5 (Phase 2)

> At-a-glance mirror of pipeline/tasks/ (orchestrator is sole writer). Status as of Phase 1 planning.

**Lane:** feature-full · **Risk:** MEDIUM · **Plan score:** 8.75/10 · **Stage:** awaiting Human Gate 1

| Task | Title | Status |
|---|---|---|
| T-43 | S/R detection engine (prev-week H/L, monthly pivot, volume POC + strength score; freshness guard; poc_used tagging; migration 012) | ⬜ planned |
| T-44 | Levelhead personality activation (sr_anchored filter mapping, sr_strength_threshold gate, ACTIVE_PHASE phase gate) | ⬜ planned |
| T-45 | Multi-index expansion — BankNifty + Sensex (INDICES env, per-underlying expiry calendar + symbol prefix, startup symbol/freshness asserts, remove NIFTY cast) | ⬜ planned |
| T-46 | Bayesian optimization (guarded min_probability tuner; GP vs deterministic 1-D — Gate 1 decision; shared guard layer; ≥200 post-filter sample gate) | ⬜ planned |

**Open Gate-1 decisions:** (1) T-46 optimizer mode — full GP vs deterministic 1-D (recommended); (2) multi-index portfolio caps — per-index (proposed) vs global.
