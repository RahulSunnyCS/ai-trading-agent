# Business & Product Context

AI Trading Agent is an internal, single-researcher paper-trading research tool. It has no commercial offering, no paid tiers, no payment provider, and no end-user accounts. All research runs under one operator's credentials.

## Offering

- Paper-trading simulation — no real capital at risk
- Multi-personality parallel strategy comparison
- Regime-aware retrospection and parameter evolution
- Signal calibration tracking (Brier scores, win-rate vs stated probability)

## Tiers

None. There is no tier system, no billing, and no user accounts. This is a self-hosted research tool used by its author.

## Pipeline Scope

The following pipeline specialists are **Not-Applicable** for this project on every run:

- **pricing-reviewer** — no billing, no Stripe, no tiers; do not spin up
- **security-auditor** (auth/PII scope) — no user accounts, no authentication, no personal data stored; basic security hygiene still applies but auth/PII risk_flags do not trigger

The system does expose a **public-facing Fastify API** (planned endpoints for personalities, signals, trades, dashboard data), which means:
- Any implemented HTTP endpoints should be reviewed for input validation and injection risks
- The `backend` tag applies when API routes are being built

## Key Business Rules for Implementation

1. **Clockwork is the permanent control group** — its parameters must never change. Any code path that could mutate a personality with `is_frozen = true` is a critical bug.
2. **Management style is identity** — `entry_type` and `management_style` columns in `personality_configs` are frozen per personality (except learning personalities). Changing them invalidates the experiment.
3. **Evolution requires evidence** — rules have minimum sample sizes, cooldown periods, and max-application caps. High-impact rules require human approval (`EVOLUTION_REQUIRE_APPROVAL=true`).
4. **Comparison integrity** — Precision, Adjuster, and Reducer share the same entry style. If their `min_probability` thresholds diverge by more than 8 percentage points, evolution on the outlier is paused.
5. **Regime tagging is mandatory** — every retrospection result must carry a regime tag before any cross-personality comparison is made.
