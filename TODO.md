# TODO — AI Trading Agent

At-a-glance mirror of `ROADMAP.md`. Status: all tasks **not started**
(greenfield repo — only docs exist). ⭐ = first runnable milestone.

## Milestone 0 — Scaffolding & Infrastructure
- [ ] T-01 Bun project init (package.json, tsconfig strict, .env.example, dirs)
- [ ] T-02 Docker Compose (TimescaleDB pg16 + Redis 7, healthchecks)
- [ ] T-03 Postgres client + idempotent migration runner
- [ ] T-04 Redis client + stream helpers (market.ticks / straddle.values / signals.generated)
- [ ] T-05 Core schema migration 001 (hypertables + tables + straddle_1min + schema.ts)
- [ ] T-06 Seed migration 002 — single Clockwork-style personality (MVP)

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

## Milestone 3 — EOD Retrospection + Rule-Based Evolution (Phase 1)
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

## Milestone 4 — Phase 2 (later)
- [ ] T-43 S/R detection engine
- [ ] T-44 Levelhead personality
- [ ] T-45 Multi-index expansion (BankNifty, Sensex)
- [ ] T-46 Bayesian optimization

## Milestone 5 — Phase 3/4 + Production (later, data-gated)
- [ ] T-47 Strategies 2 & 3
- [ ] T-48 Genetic-algorithm evolution
- [ ] T-49 Dynamic slippage model
- [ ] T-50 Portfolio Greeks + circuit breaker
- [ ] T-51 Backtesting harness
- [ ] T-52 Probability recalibration
- [ ] T-53 Prod hardening (Fyers token refresh, deploy, secrets)
