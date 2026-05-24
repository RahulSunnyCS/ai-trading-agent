# Phase 1 Plan — Milestone 5 (Phase 2)

Internal quality score: 8.75/10 after 3 Red Team sprints. Verdict: Acceptable, ready for Gate 1.

## Scope: 4 roadmap tasks

### T-43 — S/R detection engine
New signal engine (sibling to peak-detection-engine), operating on INDEX SPOT (not straddle value).
- Computes objective levels: previous-week High/Low, monthly classic pivot ((H+L+C)/3 + R1/S1/R2/S2), and Volume Point of Control (POC).
- Each level carries a strength score: proximity + confluence of nearby levels + volume weight.
- Levels precomputed daily at session start from TimescaleDB hypertable history (existing backfill).
- **Freshness guard (R-D):** assert historical coverage per index ≥ expected bars for the lookback. Below threshold → SR DISABLED for that index that day, logged loudly (throw-don't-skip, mirrors FROZEN_VIOLATION). Ties to FYERS_ACCESS_TOKEN daily-expiry failure.
- Engine subscribes to `straddle.values` (carries spot/atmStrike/straddleValue); when spot is within `sr_proximity_points` of a strong level, emits an SR signal, writes `straddle_signals`, publishes `signals.generated`.
- **POC consistency (R-E):** each signal tagged `poc_used` boolean + `level_source` breakdown JSON. Backtests/optimizer must filter to a consistent definition — never blend poc_used=true and =false.
- **VIX null (R-I):** when VIX null, SR strength scoring uses a neutral VIX weight (no boost/penalty), consistent with the existing "pass-on-null VIX" filter convention.
- **Migration 012 (R-F):** nullable CHECK-constrained TEXT column for SR signal subtype + nullable strength columns — NOT a Postgres enum ALTER (reversibility). SR rows only written when ACTIVE_PHASE>=2.

### T-44 — Levelhead personality activation
Levelhead already seeded (phase=2, entry_type=sr_anchored, management=cut_reenter, params sr_proximity_points + sr_strength_threshold).
- personality-filter Stage 1: map entry_type `sr_anchored` ↔ the SR signal type.
- Stage 4 (signal quality): for sr_anchored, gate on `sr_strength_threshold` instead of min_probability.
- New `ACTIVE_PHASE` env (default 1); personality-router loads `phase <= ACTIVE_PHASE`. Set to 2 to activate Phase-2 personalities.
- Uses existing cut_reenter (Reducer) management — no new management code.
- **Evolution contract (R-B):** sr_anchored personalities are EXCLUDED from the momentum_exhaustion 8pp comparison-integrity set. `sr_strength_threshold` is NOT tuned by any optimizer in M5 (explicit non-goal) — operator-set only.

### T-45 — Multi-index expansion (BankNifty + Sensex)
- `INDICES` env (default "NIFTY") selects active indices.
- **Single pipeline (R-H):** peak-detection already keeps per-underlying state (UnderlyingState keyed by underlying). Multi-index = feeding multiple underlyings' ticks into the existing single engine process — NO separate per-index processes/consumer-groups.
- **Instrument correctness (R-A, R-K, R-L):** replace the Thursday weekday formula + hardcoded `NSE:` prefix with:
  - DB table `index_expiry_calendar` (underlying, expiry_date, is_holiday_shifted) seeded from exchange calendars with holiday-shift overrides; getCurrentExpiry reads it.
  - Per-underlying symbol prefix (BSE: for Sensex, NSE: for NIFTY/BankNifty).
  - Startup symbol-resolution assert per active index: computed ATM straddle symbol must resolve to a real tradable instrument — in LIVE mode validate against the freshly-fetched broker instrument master; dated fixture is sim-only. Fail loudly + disable that index for the session if it doesn't resolve.
  - Calendar-freshness assert: next expiry_date must be in the future AND within one expiry-interval; HARD-FAIL an expired (past-max-date) calendar; independent refill-reminder log if max seeded date within N days.
- Remove the `as 'NIFTY'` cast in personality-router.
- **DECISION (portfolio caps):** max-4-legs hard cap + portfolio stop — per-index or global across indices? Default proposal: per-index caps (each index treated as an independent book), with a global circuit-breaker deferred to M6 (T-50 Portfolio Greeks).
- **ACTIVE_PHASE blast radius (R-G):** operator can stage — INDICES="NIFTY" + ACTIVE_PHASE=2 first, then widen.

### T-46 — Bayesian optimization
Alternative optimizer to the rule engine, for "stable" momentum_exhaustion personalities with ≥200 samples. Tunes ONLY momentum_exhaustion `min_probability`.
- **DECISION (R-C):** present two options at Gate 1:
  - Option 1 — full GP (RBF kernel + Expected Improvement, single param), with **bounded RBF length-scale prior** fixed to a fraction of [0.30,0.90] as the load-bearing correctness guard (R-M), diagonal jitter for Cholesky stability, and a deterministic 1-D fallback on numerical failure.
  - Option 2 (Optimist-recommended) — guarded deterministic 1-D search (golden-section/grid over [0.30,0.90]) now; defer GP to the multi-param milestone.
- Either way routes through the SAME guard layer: FROZEN_VIOLATION, [0.30,0.90] clamp, 8pp integrity cap, 7-day cooldown, approval gate (EVOLUTION_REQUIRE_APPROVAL default TRUE).
- Objective = risk-adjusted (Sharpe or Beat-Clockwork delta from retrospection_results), evaluated by backtesting candidate params over TRAIN period only; holdout untouched.
- **Min-sample gate (R-J):** applied AFTER freshness + poc-consistency filtering; counts post-filter regime-tagged rows; reuse the rule engine's SHARED min-sample constant (no re-declaration). Below threshold → NO suggestion (never low-confidence).
- Runs in BullMQ EOD job, off critical path. Falls back to rule engine if <200 samples or GP fails.

## Phase-2 decomposition precision points (encode in T-XX.json acceptance criteria)
- T-46 min-sample gate counts POST-FILTER regime-tagged rows, reads the rule engine's shared constant.
- Calendar assert hard-fails an expired calendar; future-date assert and refill-reminder threshold evaluated independently.

## Open decisions for Human Gate 1
1. T-46: full GP (option 1) vs guarded deterministic 1-D search now + defer GP (option 2, recommended).
2. Multi-index portfolio caps: per-index (proposed default) vs global across indices.

## Optional AI recommendations (round 1 of 2)
- R1: S/R proximity hysteresis/dedup so spot oscillating around a level doesn't spam repeated entries. Value: signal quality. Cost: small.
- R2: Bayesian "shadow mode" — log what the optimizer WOULD propose for N days before any proposal reaches the approval queue. Value: trust/audit before acting on live params. Cost: medium.
- R3: Per-index volatility-proxy abstraction so BankNifty/Sensex can later get their own vol index instead of borrowing NIFTY India-VIX. Value: future-proofs scoring. Cost: small refactor.

## Risk register (post-Red-Team)
1. Autonomous mutation bypassing guards → MITIGATED: optimizer reuses the exact rule-engine guard layer.
2. Wrong per-index expiry/symbol → MITIGATED: calendar table + symbol-resolution + calendar-freshness asserts.
3. Portfolio cap scoping → DECISION at Gate 1.
4. Overfitting via optimizer → MITIGATED: ≥200 post-filter sample gate, holdout untouched, approval default-on, risk-adjusted objective.
5. GP numerical instability → MITIGATED: option-2 removes it entirely; option-1 uses length-scale prior + jitter + fallback.
6. POC garbage on null volume → MITIGATED: graceful degrade + poc_used tag + no-blend rule.
7. NIFTY VIX applied to other indices → ACCEPTED (market-wide proxy), R3 future-proofs.
8. Compute load → MITIGATED: single pipeline (R-H), GP off critical path in BullMQ.
