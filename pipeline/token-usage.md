# Pipeline Token Log

| Phase | Step | Agent | Model | Effort | Est. Tokens |
|---|---|---|---|---|---|
| Phase 0 | Triage + codebase map | orchestrator + Explore | haiku/sonnet | low/medium | ~10k |
| Phase 1 | Red Team Sprint 1 | red-team | opus | max | ~44k |
| Phase 1 | Red Team Sprint 2 | red-team | opus | max | ~42k |
| Phase 1 | Red Team Sprint 3 | red-team | opus | max | ~40k |
| Phase 1 | Planning + synthesis | orchestrator | opus | max | ~30k |
| Phase 1 | QA Planner | qa-planner | sonnet | medium | ~43k |
| Phase 1 | Translator (Plan Report) | translator | haiku | medium | ~12k |
| Phase 2 | Decomposition (6 contracts) | orchestrator | opus | high | ~20k |
| Phase 3 | T-43-A: schema & migrations | implementor | sonnet | high | ~14k |
| Phase 3 | T-46: deterministic optimizer | implementor | sonnet | high | ~18k |
| Phase 3 | T-43-B: S/R level computation | implementor | sonnet | high | ~16k |
| Phase 3 | T-44: Levelhead activation | implementor | sonnet | high | ~14k |
| Phase 3 | T-46 hybrid-objective rework | implementor | sonnet | high | ~22k |
| Phase 3 | T-43-C: S/R detection engine | implementor | sonnet | high | ~16k |
| Phase 3 | T-45: multi-index expansion | implementor | sonnet | high | ~22k |
| Phase 3 | Fix: SR-signal leak into momentum personalities | implementor | sonnet | medium | ~8k |
| Phase 4 | Security Auditor (M5 diff) | security-auditor | opus | max | ~45k |
| Phase 4 | Performance Reviewer (M5 diff) | performance-reviewer | sonnet | high | ~18k |
| Phase 4 | Architecture Reviewer (M5 diff, backend+infra) | architecture-reviewer | sonnet | high | ~18k |
| Phase 4 | Synthesis (3 reports) | orchestrator | opus | high | ~12k |
| Phase 4 | Gate-2 Translator pass | translator | haiku | medium | ~7k |
| Phase 6 | FIX-A: risk controls (C1,H2,H3,M4,M5) | implementor | sonnet | high | ~20k |
| Phase 6 | FIX-B: optimizer/EOD (C2,M3,M1,H4) | implementor | sonnet | high | ~20k |
| Phase 6 | FIX-C: multi-index/lifecycle (H1,M2) | implementor | sonnet | high | ~20k |
| Phase 6 | FIX-A2: populate underlying (C1 completion) | implementor | sonnet | medium | ~7k |
| Phase 6 | Re-review: security (fix diff) | security-auditor | opus | high | ~22k |
| Phase 6 | Re-review: performance (fix diff) | performance-reviewer | sonnet | high | ~12k |
| Phase 6 | Re-review: architecture (fix diff) | architecture-reviewer | sonnet | high | ~12k |
