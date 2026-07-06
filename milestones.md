# AI Trading Agent — Milestones Snapshot

> **Generated:** 2026-05-19 — derived from `ROADMAP.md`, `TODO.md`, and the current pipeline run.
> **Do not hand-edit.** Update `ROADMAP.md` as the source of truth; regenerate this file at each milestone boundary.

---

## Build Progress Summary

| Milestone | Tasks | Status |
|---|---|---|
| M0 — Scaffolding & Infrastructure | T-01 … T-06 (6 tasks) | 🔴 Not started |
| M0.5 — Testing & CI Foundation | T-59 … T-63 (5 tasks) | 🔴 Not started |
| M1 — Live Paper-Trading Slice + Dashboard ⭐ | T-07 … T-21 (15 tasks) | 🔴 Not started |
| M2 — Momentum Signals + Multi-Personality | T-22 … T-32 (11 tasks) | 🔴 Not started |
| M3 — Historical Data, Replay & Backtesting | T-54 … T-58 (6 tasks) | 🔴 Not started |
| M4 — EOD Retrospection + Rule-Based Evolution | T-33 … T-42 (10 tasks) | 🔴 Not started |
| M5 — Phase 2: S/R, Multi-Index, Bayesian | T-43 … T-46 (4 tasks) | 🔴 Not started |
| M6 — Phase 3/4 + Production Readiness | T-47 … T-53 (7 tasks) | 🔴 Not started |
| **M7 — Payment & Access Gateway (NEW)** | T-64 … T-72 (9 tasks) | 🟡 Planned — awaiting Gate 1 |
| **Total** | **73 tasks** | **0% complete** |

> **Codebase state:** Greenfield. Only documentation files exist in the repo root. No `src/` directory, no `package.json`, no compiled code. Everything is pending.

---

## Milestone 0 — Scaffolding & Infrastructure

**Goal:** A fresh clone can `bun install`, `docker compose up -d`, `bun run migrate` cleanly.

| Task | Title | Status |
|---|---|---|
| T-01 | Bun project init (package.json, tsconfig strict, .env.example, dirs) | 🔴 Not started |
| T-02 | Docker Compose (TimescaleDB pg16 + Redis 7, healthchecks) | 🔴 Not started |
| T-03 | PostgreSQL client + idempotent migration runner | 🔴 Not started |
| T-04 | Redis client + stream helpers | 🔴 Not started |
| T-05 | Core schema migration 001 (hypertables + tables + continuous aggregate) | 🔴 Not started |
| T-06 | Seed migration 002 — single Clockwork-style personality (MVP) | 🔴 Not started |

---

## Milestone 0.5 — Testing & CI Foundation

**Goal:** CI gate, pre-commit hooks, Vitest, injectable Clock, minimal integration harness.

| Task | Title | Status |
|---|---|---|
| T-59 | Lean CI (GitHub Actions — typecheck → lint → unit on push) | 🔴 Not started |
| T-60 | Lint/format + lefthook pre-commit | 🔴 Not started |
| T-61 | Vitest + targeted property tests (money / trigger / evolution math) | 🔴 Not started |
| T-62 | Injectable Clock (real / fixed / virtual) | 🔴 Not started |
| T-63 | Minimal integration harness (TimescaleDB + Redis, migration idempotency) | 🔴 Not started |

---

## Milestone 1 — Live Paper-Trading Slice + Dashboard ⭐ FIRST RUNNABLE

**Goal:** `bun run sim` and live Fyers mode both produce a working trade loop visible in the browser.

### Data Ingestion
| Task | Title | Status |
|---|---|---|
| T-07 | BrokerFeed interface + tick types | 🔴 Not started |
| T-08 | Random-walk simulator (credential-free dev) | 🔴 Not started |
| T-09 | Fyers WebSocket adapter (primary live) | 🔴 Not started |
| T-10 | Angel One adapter (fallback live) | 🔴 Not started |
| T-11 | Instrument registry + getAtmStrike + expiry helpers | 🔴 Not started |
| T-12 | Broker selection wiring (SIMULATE / BROKER env) | 🔴 Not started |

### Straddle Pipeline
| Task | Title | Status |
|---|---|---|
| T-13 | Straddle calculator (15s snapshots, ROC, acceleration) | 🔴 Not started |
| T-14 | VIX feed (light, context only) | 🔴 Not started |

### Paper Trade Engine
| Task | Title | Status |
|---|---|---|
| T-15 | Scheduled entry engine (fixed-time + entry/exit window + event-day gate) | 🔴 Not started |
| T-16 | Trigger / exit engine (SL, TSL, target, EOD, daily loss cap) | 🔴 Not started |
| T-17 | Paper trade execution + P&L | 🔴 Not started |
| T-18 | Position monitor loop (mark-to-market + trigger eval) | 🔴 Not started |

### API + Dashboard
| Task | Title | Status |
|---|---|---|
| T-19 | Fastify server + MVP REST/WS | 🔴 Not started |
| T-20 | React dashboard shell (live straddle + trades + P&L) | 🔴 Not started |
| T-21 | End-to-end wire-up + smoke test | 🔴 Not started |

---

## Milestone 2 — Momentum Signals + Multi-Personality Engine

| Task | Title | Status |
|---|---|---|
| T-22 | Peak detection engine | 🔴 Not started |
| T-23 | Probability scoring | 🔴 Not started |
| T-24 | Fallback signals (scheduled + pullback) | 🔴 Not started |
| T-25 | Full 10-personality seed (migration 003) | 🔴 Not started |
| T-26 | 5-stage decision filter | 🔴 Not started |
| T-27 | Personality router | 🔴 Not started |
| T-28 | Holder management | 🔴 Not started |
| T-29 | Adjuster management | 🔴 Not started |
| T-30 | Reducer management | 🔴 Not started |
| T-31 | Hard portfolio risk rules (max 4 legs, event-day gate, margin buffer) | 🔴 Not started |
| T-32 | Personality CRUD + performance API | 🔴 Not started |

---

## Milestone 3 — Historical Data, Replay & Backtesting

| Task | Title | Status |
|---|---|---|
| T-54 | Fyers historical REST client | 🔴 Not started |
| T-55 | Historical backfill store + writer (idempotent, resumable) | 🔴 Not started |
| T-56 | Historical straddle reconstruction | 🔴 Not started |
| T-57 | Deterministic replay harness (HistoricalFeed + virtual clock) | 🔴 Not started |
| T-51 | Backtest runner — train/test split + holdout | 🔴 Not started |
| T-58 | Backtest reporting + statistical validation | 🔴 Not started |

---

## Milestone 4 — EOD Retrospection + Rule-Based Evolution

| Task | Title | Status |
|---|---|---|
| T-33 | Regime tagging engine (RANGING / TRENDING_STRONG / VOLATILE_REVERTING / EVENT_DAY) | 🔴 Not started |
| T-34 | BullMQ EOD job scaffold | 🔴 Not started |
| T-35 | Daily metrics computation | 🔴 Not started |
| T-36 | Beat-Clockwork delta | 🔴 Not started |
| T-37 | Signal calibration (Brier score) | 🔴 Not started |
| T-38 | Management effectiveness | 🔴 Not started |
| T-39 | Comparison integrity check (8pp drift guard) | 🔴 Not started |
| T-40 | Rule-based evolution engine (+ FROZEN_VIOLATION guard) | 🔴 Not started |
| T-41 | Retrospection + evolution API + audit log | 🔴 Not started |
| T-42 | Dashboard retrospection view | 🔴 Not started |

---

## Milestone 5 — Phase 2: S/R Signals, Multi-Index, Bayesian

| Task | Title | Status |
|---|---|---|
| T-43 | S/R detection engine | 🔴 Not started |
| T-44 | Levelhead personality | 🔴 Not started |
| T-45 | Multi-index expansion (BankNifty, Sensex) | 🔴 Not started |
| T-46 | Bayesian optimization | 🔴 Not started |

---

## Milestone 6 — Phase 3/4 + Production Readiness

| Task | Title | Status |
|---|---|---|
| T-47 | Strategies 2 & 3 (Directional ATM short + Momentum Buy) | 🔴 Not started |
| T-48 | Genetic-algorithm evolution | 🔴 Not started |
| T-49 | Dynamic slippage model | 🔴 Not started |
| T-50 | Portfolio Greeks + circuit breaker | 🔴 Not started |
| T-52 | Probability recalibration (isotonic/Platt scaling) | 🔴 Not started |
| T-53 | Prod hardening (Fyers token refresh, Railway/Fly.io, secrets) | 🔴 Not started |

---

## Milestone 7 — Payment & Access Gateway (NEW — awaiting Gate 1 approval)

**Goal:** UPI subscription payments for India-geolocated users via Razorpay. Single-instance license model. Silent fail when no payment keys configured. Blocked on M1 completion (requires Fastify server, DB, React app).

**Dependencies:** T-03, T-05, T-19, T-20 (all in M0 / M1)

| Task | Title | Status |
|---|---|---|
| T-72 | Update business.md Pipeline Scope (governance task — enables pricing-reviewer, documents PII scope) | 🟡 Planned |
| T-64 | DB migrations: `subscriptions` + `processed_webhook_events` tables | 🟡 Planned |
| T-65 | Razorpay service module (client, webhook signature verify on raw bytes, sub CRUD) | 🟡 Planned |
| T-66 | Server-side geolocation service (ip-api.com, trustProxy, injectable, graceful fail) | 🟡 Planned |
| T-67 | Payment API endpoints (plans, create-sub, webhook, status) + rate limiting | 🟡 Planned |
| T-68 | Access gate middleware + PAYMENT_ENABLED silent-fail | 🟡 Planned |
| T-69 | React pricing page (region-aware, Razorpay Checkout widget, post-payment polling) | 🟡 Planned |
| T-70 | Reconciliation + orphan sweep BullMQ job (12h schedule) | 🟡 Planned |
| T-71 | Update .env.example with all payment-related vars | 🟡 Planned |

**Accepted risks for M7 v1:**
- International (Stripe) payment path deferred to Phase 2
- Annual subscription plans deferred to Phase 2
- GST-compliant invoice generation deferred to Phase 2
- DPDP data-protection formal compliance deferred (Razorpay holds PCI scope; no raw payment instruments stored locally)

---

## Next Steps

1. **Gate 1 approval** — review and approve the M7 plan report
2. **Confirm 5 decisions** — identity model, international scope, pricing, GST approach, annual plans
3. **Start M0** — T-01 through T-06 can begin immediately (no prerequisites)
4. **M1 after M0** — the core app must exist before M7 payment code can be attached
