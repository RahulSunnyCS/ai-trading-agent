# TODO — AI Trading Agent

At-a-glance mirror of `ROADMAP.md` + formally contracted pipeline tasks.
⭐ = first runnable milestone. 🔒 = task contract written (pipeline/tasks/T-XX.json).

**Build status:** 5 / 73 tasks complete (T-01, T-02, T-03, T-04, T-72 done). M0 in progress.

---

## Milestone 0 — Scaffolding & Infrastructure
- [x] T-01 Bun project init (package.json, tsconfig strict, .env.example, dirs)
- [x] T-02 Docker Compose (TimescaleDB pg16 + Redis 7, healthchecks)
- [x] T-03 Postgres client + idempotent migration runner
- [x] T-04 Redis client + stream helpers (market.ticks / straddle.values / signals.generated)
- [ ] T-05 Core schema migration 001 (hypertables + tables + straddle_1min + schema.ts)
- [ ] T-06 Seed migration 002 — single Clockwork-style personality (MVP)

## Milestone 0.5 — Testing & CI Foundation (lean — research-tool scoped)
Essential — correctness & reproducibility:
- [ ] T-59 Lean CI (typecheck → lint → unit on push; integration nightly; blocks merge)
- [ ] T-60 Lint/format + lefthook pre-commit
- [ ] T-61 Vitest + targeted fast-check on money/trigger/evolution (coverage tracked, not gated)
- [ ] T-62 Injectable Clock (real/fixed/virtual) — consumed by T-15/T-16/T-57
- [ ] T-63 Minimal integration harness (TimescaleDB+Redis, migration idempotency, one signal→trade flow)
Cross-cutting (M3):
- [ ] (M3) Deterministic golden replay — reproducibility oracle; with T-57/T-58
Deferred (not now — see ROADMAP): 2–3 Playwright smoke specs after M1 · BrokerFeed conformance (2+ adapters) · Stryker · coverage gates

## Milestone 1 — Live Paper-Trading Slice + Dashboard ⭐
- [ ] T-07 BrokerFeed interface + tick types
- [ ] T-08 Random-walk simulator (credential-free dev)
- [ ] T-09 Fyers WebSocket adapter (primary live)
- [ ] T-10 Angel One adapter (fallback live)
- [ ] T-11 Instrument registry + getAtmStrike + expiry helpers
- [ ] T-12 Broker selection wiring (SIMULATE / BROKER env)
- [ ] T-13 Straddle calculator (15s snapshots, ROC, acceleration)
- [ ] T-14 VIX feed (light, context only)
- [ ] T-15 Scheduled entry engine (fixed-time + entry/exit window + event-day gate)
- [ ] T-16 Trigger/exit engine (SL, TSL, target, EOD, daily loss cap, exit time)
- [ ] T-17 Paper trade execution + P&L (DB source of truth; Quantiply stubbed)
- [ ] T-18 Position monitor loop (mark-to-market + trigger eval)
- [ ] T-19 Fastify server + MVP REST/WS
- [ ] T-20 React dashboard shell (live straddle + trades table + P&L)
- [ ] T-21 End-to-end wire-up + smoke test

## Milestone 2 — Momentum Signals + Multi-Personality (Phase 1)
- [ ] T-22 Peak detection engine
- [ ] T-23 Probability scoring
- [ ] T-24 Fallback signals (scheduled + pullback)
- [ ] T-25 Full 10-personality seed (migration 003)
- [ ] T-26 5-stage decision filter
- [ ] T-27 Personality router
- [ ] T-28 Holder management
- [ ] T-29 Adjuster management
- [ ] T-30 Reducer management
- [ ] T-31 Hard portfolio risk rules
- [ ] T-32 Personality CRUD + performance API

## Milestone 3 — Fyers Historical Data, Replay & Backtesting
- [ ] T-54 Fyers historical REST client (candles/quotes, chunking, rate limits)
- [ ] T-55 Historical backfill store + writer (idempotent, resumable)
- [ ] T-56 Historical straddle reconstruction (rebuild snapshots for past dates)
- [ ] T-57 Deterministic replay harness (HistoricalFeed + virtual clock)
- [ ] T-51 Backtest runner — train/test split + holdout (re-homed from old M5)
- [ ] T-58 Backtest reporting + statistical validation (needs T-33; see ROADMAP note)

## Milestone 4 — EOD Retrospection + Rule-Based Evolution (Phase 1)
- [ ] T-33 Regime tagging engine
- [ ] T-34 BullMQ EOD job scaffold
- [ ] T-35 Daily metrics computation
- [ ] T-36 Beat-Clockwork delta
- [ ] T-37 Signal calibration (Brier)
- [ ] T-38 Management effectiveness
- [ ] T-39 Comparison integrity check (8pp drift guard)
- [ ] T-40 Rule-based evolution engine (+ FROZEN_VIOLATION guard)
- [ ] T-41 Retrospection + evolution API + audit log
- [ ] T-42 Dashboard retrospection view

## Milestone 5 — Phase 2 (later)
- [ ] T-43 S/R detection engine
- [ ] T-44 Levelhead personality
- [ ] T-45 Multi-index expansion (BankNifty, Sensex)
- [ ] T-46 Bayesian optimization

## Milestone 6 — Phase 3/4 + Production (later, data-gated)
- [ ] T-47 Strategies 2 & 3
- [ ] T-48 Genetic-algorithm evolution
- [ ] T-49 Dynamic slippage model
- [ ] T-50 Portfolio Greeks + circuit breaker
- [ ] T-52 Probability recalibration
- [ ] T-53 Prod hardening (Fyers token refresh, deploy, secrets)

## Milestone 7 — Payment & Access Gateway 🔒 (blocked on M1; can start T-72 now)
Credits = feature tokens (1 credit consumed per feature call, e.g. backtest run).
No mandate / no autopay — all payments are one-time Razorpay Orders.
Silent fail: omit RAZORPAY_KEY_ID → free/open access, no payment screens.

- [x] T-72 🔒 Update business.md Pipeline Scope (governance — re-enable pricing-reviewer, document PCI boundary)
- [ ] T-64 🔒 DB migrations: access_grants + credit_transactions + processed_webhook_events (depends: T-03, T-05)
- [ ] T-65 🔒 Razorpay service module: createOrder, verifyPaymentSig, verifyWebhookSig (raw bytes), consumeCredit (depends: T-01, T-64)
- [ ] T-66 🔒 Geolocation service: ip-api.com, injectable, graceful fail → show both options (depends: T-01)
- [ ] T-67 🔒 Payment API routes: /plans /create-order /webhook /access-status /credit-balance (depends: T-19, T-64, T-65, T-66)
- [ ] T-68 🔒 Access gate middleware + PAYMENT_ENABLED silent-fail (depends: T-19, T-64)
- [ ] T-69 🔒 React pricing page: region-aware, Razorpay Checkout widget, post-payment polling (depends: T-20, T-67)
- [ ] T-71 🔒 Update .env.example with all RAZORPAY_* + GEOLOCATION_API_URL vars (depends: T-65)
