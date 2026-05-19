# Pipeline Token Usage — Milestone 2

| Phase | Step | Agent | Model | Effort | Est. Tokens |
|---|---|---|---|---|---|
| Phase 0 | Triage | orchestrator | haiku | low | ~3k |
| Phase 1 | Planning + Red Team (×3 sprints) | Plan agent (opus) | opus | max | ~96k |
| Phase 1 | Red Team adversarial review | red-team | sonnet | high | ~44k |
| Phase 1 | Translator (Gate 1 report) | claude (haiku) | haiku | medium | ~72k |
| Phase 1 | QA Planner | qa-planner | sonnet | medium | ~15k |
| Phase 2 | Decomposition | orchestrator | opus | high | ~30k |
| Phase 3 | T-25: Schema migrations + personality seed | implementor | sonnet | high | ~43k |
| Phase 3 | T-65: GlobalMacroFeed | implementor | sonnet | high | ~15k |
| Phase 3 | T-26: 5-stage personality filter | implementor | sonnet | high | ~15k |
| Phase 3 | T-32: Personality CRUD + performance API | implementor | sonnet | high | ~18k |
| Phase 3 | T-23: Probability scorer (8-factor incl OI) | implementor | sonnet | high | ~55k |
| Phase 3 | T-22: Peak detection engine + OI tracking | implementor | sonnet | high | ~109k |
| Phase 3 | T-27: Personality router | implementor | sonnet | high | ~108k |
| Phase 3 | T-24: Scheduled signal emitter | implementor | sonnet | high | ~15k |
| Phase 3 | T-28: Holder management + PositionMonitor | implementor | sonnet | high | ~25k |
| Phase 3 | T-29: Adjuster management (roll logic) | implementor | sonnet | high | ~20k |
| Phase 3 | T-30: Reducer management (cut + re-entry) | implementor | sonnet | high | ~18k |
| Phase 3 | T-31: Portfolio risk rules | implementor | sonnet | high | ~15k |
| Phase 4 | Security Auditor review | security-auditor | opus | max | ~40k |
| Phase 4 | Performance Reviewer | performance-reviewer | sonnet | high | ~20k |
| Phase 4 | Architecture Reviewer | architecture-reviewer | sonnet | high | ~20k |
| Phase 4 | Synthesis & Gate 2 Translator | translator | haiku | medium | ~12k |
| Phase 5 | Test Writer (unit + integration) | test-writer | sonnet | medium | ~30k |
| Phase 5 | Docs Writer | docs-writer | haiku | low | ~8k |
| Phase 5 | E2E Test Writer | e2e-test-writer | sonnet | medium | ~22k |
