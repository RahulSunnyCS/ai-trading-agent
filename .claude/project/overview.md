# Project Overview

**AI Trading Agent** (`ai-trading-agent`) is a paper-trading research platform for weekly index options strategies on Indian markets (NSE/BSE). It runs 10 parallel "trading personalities" — each with a different entry signal type and position management style — tracks their performance, and evolves parameters automatically via a daily retrospection engine. The goal is to discover, through controlled experiments, which combination of entry signal and management style consistently beats a fixed-time baseline (Clockwork) across different market regimes.

- **Signal Generation** — Momentum exhaustion detector that tracks straddle rate-of-change and acceleration; also supports scheduled (fixed-time) and pullback entry fallbacks
- **Multi-Personality Engine** — 10 personalities run in parallel (7 reference + 3 learning); each independently filters every signal through a 5-stage gate (hard filters → state checks → VIX context → signal quality → profit gate)
- **Position Management** — Three management styles tested in parallel: Holder (no adjustment), Adjuster (roll one leg at ±70pt), Reducer (cut and re-enter)
- **Retrospection Engine** — EOD BullMQ job that computes per-personality metrics, beats-Clockwork delta, signal calibration, management effectiveness, and regime-tagged parameter suggestions
- **Parameter Evolution** — Rule-based (Phase 1 now), Bayesian optimization (Phase 2 planned), genetic algorithms (Phase 3 planned); all changes logged with full audit trail; high-impact changes require human approval
- **Market Regime Tagging** — Every result tagged RANGING / TRENDING_STRONG / VOLATILE_REVERTING / EVENT_DAY; comparisons are only meaningful within the same regime bucket
- **Simulation Mode** — Built-in market data simulator; runs without any broker credentials (`SIMULATE=true`)
- **Dashboard** — Planned React + Vite real-time dashboard (not yet implemented in source)

## Supported Underlyings

- **NIFTY** (NSE) — primary; Phase 1 runs on Nifty only
- **BankNifty** (NSE) — Phase 2 expansion
- **Sensex** (BSE) — Phase 2 expansion

## The 10 Personalities

| Name | Group | Entry Type | Management |
|------|-------|-----------|-----------|
| Clockwork | Reference | Fixed time | Hold — **frozen forever, the permanent benchmark** |
| Precision | Reference | Momentum exhaustion | Hold |
| Scanner | Reference | Any signal | Hold |
| Adjuster | Reference | Momentum exhaustion | Roll |
| Reducer | Reference | Momentum exhaustion | Cut + Re-enter |
| Blitz | Reference | Any signal | Roll |
| Levelhead | Reference | S/R-anchored | Cut + Re-enter — Phase 2 only |
| Conservative Learner | Learning | Starts as Clockwork | Evolves slowly (30-sample bar) |
| Medium Learner | Learning | Starts as Clockwork | Evolves moderately (15-sample bar) |
| Aggressive Learner | Learning | Starts as Clockwork | Evolves quickly (5-sample bar) |

## This Is Not a Live Trading System

All trades are simulated. The system produces no real orders. The broker integration (Fyers) is used solely for real-time market data.
