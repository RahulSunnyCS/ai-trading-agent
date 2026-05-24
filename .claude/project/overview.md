# Project Overview

**AI Trading Agent** (`ai-trading-agent`) is a paper-trading research platform for weekly index options strategies on Indian markets (NSE/BSE). It runs 10 parallel "trading personalities" simultaneously, tracks their performance against each other and against a frozen Clockwork benchmark, and evolves tunable parameters automatically based on regime-tagged retrospection data. This is a research and simulation tool only — it does not execute real trades.

## Core Feature Areas

- **Data Ingestion** — Real-time market tick ingestion via Fyers WebSocket (or a built-in random-walk simulator); ATM straddle calculation every 15 seconds; India VIX feed; Redis Streams as the event bus
- **Signal Generation** — Momentum exhaustion peak detection engine (rate-of-change + second derivative + EMA crossover); scheduled fallback entries; probability scoring adjusted for VIX, time of day, and day of week; Phase 2 will add S/R-level signal detection
- **10-Personality Decision Engine** — Each personality independently filters every signal through 5 stages (hard filters → state checks → context checks → signal quality → optional profit gate) and then executes or skips the paper trade
- **Paper Trade Execution** — Simulated straddle entries and exits recorded to PostgreSQL; Quantiply API integration for paper trade tracking; 3 management styles: Hold, Roll (Adjuster), Cut + Re-enter (Reducer)
- **EOD Retrospection Engine** — BullMQ batch job computes per-personality daily metrics, Beat-Clockwork deltas, signal calibration scores, management effectiveness, and queues rule-based parameter suggestions; all results are regime-tagged (RANGING / TRENDING_STRONG / VOLATILE_REVERTING / EVENT_DAY)
- **Parameter Evolution** — Phase 1: rule-based adjustments with minimum sample sizes, cooldown periods, and approval gates; Phase 2: Bayesian optimization; Phase 3: genetic algorithms; Phase 4: RL (if data warrants)
- **React Dashboard** — Real-time straddle value + momentum indicators, active signals, per-personality running P&L, EOD retrospection charts; served via Vite; uses Lightweight Charts and Zustand

## Target Users

Originally a personal / small-team **research tool**; now a **commercial SaaS product** with India-only subscription billing (see `business.md` for billing details). Primary users are quant-oriented options traders who want data-driven evidence on Indian weekly index strategies (Nifty, BankNifty, Sensex). Access is gated by Razorpay UPI payment.

## Secondary Surfaces

- Fastify REST API (port 3000) — signal management, personality CRUD, paper-trade queries, retrospection triggers, live dashboard data, payment/order endpoints
- WebSocket endpoint (`/ws/ticks`) — live tick stream for the React frontend
- Payment routes — `POST /payment/create-order`, `POST /payment/webhook`, `GET /payment/balance`; access-gate middleware for subscription + credit checks
- Docker Compose — development infrastructure (TimescaleDB + Redis)
- Simulation mode (`SIMULATE=true`) — fully self-contained, no broker credentials needed

## Implementation Phases

- **Phase 1 (complete):**
  - M0/M0.5: Bun scaffolding, Docker infra, DB/Redis clients, Vitest + CI, injectable Clock
  - M1: Live/sim paper-trade loop, Fyers/Angel One/simulator brokers, straddle pipeline, trigger engine, Fastify API, React dashboard
  - M2: Peak detection, probability scoring, 10-personality engine, 5-stage filter, Holder/Adjuster/Reducer management, portfolio risk rules, Personalities dashboard tab
  - M3a: Fyers historical REST client, idempotent backfill, straddle reconstruction, deterministic replay harness, regime tagging (T-33)
  - M7: Razorpay UPI payment system — order creation, HMAC webhook verification, credit consumption, geolocation, access-gate middleware, pricing page
  - **M3 gaps remaining:** backtest runner (T-51) and per-regime statistical reporting (T-58) deferred
  - **M4 gaps remaining:** BullMQ EOD job and full retrospection + evolution engine (T-34–T-38, T-40–T-42) not started
- **Phase 2:** S/R signal detection engine, Levelhead personality, BankNifty/Sensex expansion, Bayesian optimisation
- **Phase 3:** Strategies 2 & 3, genetic algorithms, microstructure-aware slippage
- **Phase 4:** Reinforcement learning, live trading readiness assessment

## Project File Maintenance

Update the relevant `.claude/project/` file in the same commit as the code change that affects it. Specifically:

- **`overview.md` (this file):** Update when a milestone or epic completes — revise the Implementation Phases section to mark it done and note any remaining gaps. Also update Target Users or Secondary Surfaces if the product surface changes.
- **`business.md`:** Update when billing tiers, payment processors, compliance obligations, or Pipeline Scope notes change.
- **`technical.md`:** Update when the tech stack, essential commands, repository structure, key patterns/conventions, or environment variables change.

One fact lives in exactly one file. Never duplicate across the three files.
