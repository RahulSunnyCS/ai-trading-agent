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

This is a personal / small-team **research tool** for quant-oriented options traders who want data-driven evidence on Indian weekly index strategies (Nifty, BankNifty, Sensex) before going live. It is not a commercial product and has no external end-users.

## Secondary Surfaces

- Fastify REST API (port 3000) — signal management, personality CRUD, paper-trade queries, retrospection triggers, live dashboard data
- WebSocket endpoint (`/ws/ticks`) — live tick stream for the React frontend
- Docker Compose — development infrastructure (TimescaleDB + Redis)
- Simulation mode (`SIMULATE=true`) — fully self-contained, no broker credentials needed

## Implementation Phases

- **Phase 1 (current):** Sprint 1 = data ingestion pipeline (DB, Redis, straddle calc, Fyers adapter, simulator); Sprint 2 = paper trading, personalities, retrospection skeleton
- **Phase 2:** S/R signal detection engine, Levelhead personality, BankNifty/Sensex expansion
- **Phase 3:** Strategies 2 & 3, genetic algorithms, microstructure-aware slippage
- **Phase 4:** Reinforcement learning, live trading readiness assessment
