# Pipeline Token Usage Log

| Phase | Step | Agent | Model | Effort | Est. Tokens |
|---|---|---|---|---|---|
| Phase 0 | Triage | orchestrator | haiku | low | ~3k |
| Phase 1 | Planning + Red Team (3 sprints) | orchestrator + red-team | opus | max | ~60k |
| Phase 1 | QA Planner | qa-planner | sonnet | medium | ~8k |
| Phase 1 | Translator (Gate 1) | translator | haiku | medium | ~4k |
| Phase 2 | Decomposition (21 task contracts) | orchestrator | opus | high | ~20k |
| Phase 3 | T-01: Bun project scaffold | implementor | sonnet | high | ~15k |
| Phase 3 | T-02: Docker Compose | implementor | sonnet | high | ~12k |
| Phase 3 | T-03: PostgreSQL client + migration runner | implementor | sonnet | high | ~15k |
| Phase 3 | T-04: Redis client + Streams helpers | implementor | sonnet | high | ~15k |
| Phase 3 | T-07: BrokerFeed interface + types | implementor | sonnet | high | ~10k |
| Phase 3 | T-11: Instrument registry + ATM helpers | implementor | sonnet | high | ~70k |
| Phase 3 | T-59: GitHub Actions CI workflows | implementor | sonnet | high | ~12k |
| Phase 3 | T-60: Biome lint + lefthook pre-commit | implementor | sonnet | high | ~70k |
| Phase 3 | T-61: Vitest config + P&L property tests | implementor | sonnet | high | ~25k |
| Phase 3 | T-62: Injectable Clock abstraction | implementor | sonnet | high | ~59k |
| Phase 3 | T-05: Core DB schema migration 001 | implementor | sonnet | high | ~15k |
| Phase 3 | T-08: Random-walk simulator | implementor | sonnet | high | ~15k |
| Phase 3 | T-09: Fyers WebSocket adapter | implementor | sonnet | high | ~20k |
| Phase 3 | T-10: Angel One SmartAPI adapter | implementor | sonnet | high | ~20k |
| Phase 3 | T-14: VIX feed — NSE polling | implementor | sonnet | high | ~12k |
| Phase 3 | T-63: Integration test harness | implementor | sonnet | high | ~12k |
| Phase 3 | T-06: Fastify server skeleton + /ws/ticks | implementor | sonnet | high | ~61k |
| Phase 3 | T-12: Straddle calculator + broker factory | implementor | sonnet | high | ~75k |
| Phase 3 | T-16: Trigger/exit engine (pure function) | implementor | sonnet | high | ~41k |
| Phase 3 | T-13: Entry engine — signal generation | implementor | sonnet | high | ~20k |
| Phase 3 | T-17: Paper trade executor + Quantiply stub | implementor | sonnet | high | ~15k |
| Phase 3 | T-18: Position monitor — trailing stop, triggers, watchdog | implementor | sonnet | high | ~20k |
| Phase 3 | T-19: Dashboard + paper-trades API + WebSocket | implementor | sonnet | high | ~55k |
| Phase 3 | T-20: React dashboard shell | implementor | sonnet | high | ~65k |
| Phase 3 | T-21: End-to-end wire-up + smoke test + README | implementor | sonnet | high | ~105k |
| Phase 4 | Security Audit | security-auditor | sonnet | max | ~131k |
| Phase 4 | Performance Review | performance-reviewer | sonnet | high | ~82k |
