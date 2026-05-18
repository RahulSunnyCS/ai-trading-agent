# AI Trading Agent — Delivery Roadmap

This is the master task breakdown for the whole project, split into
milestones and right-sized tasks. Each task (`T-XX`) is scoped to be
completable by a single implementor in one focused pass — not a one-line
change, not a whole subsystem. `TODO.md` is the at-a-glance mirror of
this file.

> Source specs: `PRODUCT_OVERVIEW.md`, `TECHNICAL_REFERENCE.md`,
> `PERSONALITIES.md`, `SETUP.md`. This roadmap sequences them; it does
> not restate them.

---

## Scope Decisions (locked with the project owner)

| Decision | Choice |
|---|---|
| **First runnable milestone** | Thin vertical slice **+ minimal read-only dashboard** (Milestone 1). ONE fixed-time straddle strategy, no multi-personality / retrospection / evolution yet. |
| **Market data** | **Fyers** WebSocket = primary live source. **Angel One** (SmartAPI) = fallback live source. Random-walk **simulator** retained for credential-free dev/test (`SIMULATE=true`). All three implement the common `BrokerFeed` interface. |
| **MVP triggers** | Hard SL, Trailing SL, Profit target, EOD square-off, Daily loss cap, **Entry/exit time windows**. |
| **Paper trade tracking** | PostgreSQL is the source of truth for paper P&L. Quantiply API integration is **optional/stubbed** in the MVP. |

## Risk / Triage Note

- **Risk level: MEDIUM.** No auth, no PII, no billing (`business.md`).
  Financial logic (P&L, position sizing, risk rules) + external broker
  APIs ⇒ backend + infra architecture lenses apply; security review
  focuses on **secrets hygiene** (Fyers/Angel One credentials, `.env`)
  and safe broker WebSocket handling — not user auth or payments.
- `pricing-reviewer`: **Not applicable** — skip every run.
- Each milestone is a clean Human Gate boundary. Milestones are
  sequential; tasks within a milestone are parallel-safe unless a
  `depends on` is listed.

---

## Milestone 0 — Scaffolding & Infrastructure

Foundation. Nothing else can run until this is in place. Target: a
fresh clone can `bun install`, `docker compose up -d`, `bun run migrate`
cleanly.

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-01** | Bun project init | — | `package.json` (Bun, scripts: `dev`/`sim`/`start`/`migrate`/`test*`), `tsconfig.json` strict mode, `.gitignore`, `.env.example` (all vars from `technical.md`), `src/` skeleton dirs. No `npm`/`yarn`. |
| **T-02** | Docker Compose infra | — | `docker-compose.yml` with `timescale/timescaledb:latest-pg16` + `redis:7`, healthchecks, ports 5432/6379, named volumes. `docker compose ps` shows both `(healthy)`. |
| **T-03** | Postgres client + migration runner | T-01 | `src/db/client.ts` (`pg` pool + query helpers), `src/db/migrate.ts` (ordered, idempotent, `schema_migrations` table, retry logic). |
| **T-04** | Redis client + stream helpers | T-01 | `src/redis/client.ts` with `streamPublish` / `streamRead` for topics `market.ticks`, `straddle.values`, `signals.generated`. |
| **T-05** | Core schema migration `001` | T-03 | Hypertables (`market_ticks`, `straddle_snapshots`, `option_ticks`), standard tables (`straddle_signals`, `paper_trades`, `personality_configs`, `retrospection_results`, `external_signals`), `straddle_1min` continuous aggregate. Matching types in `src/db/schema.ts`. Full schema built once. |
| **T-06** | Seed migration `002` (MVP) | T-05 | Seed ONE Clockwork-style fixed-time personality row (full 10-personality seed deferred to T-25). `is_frozen` column populated. |

---

## Milestone 0.5 — Testing & CI Foundation

The confidence layer for AI-written code. Built **before** heavy
implementation so every later task plugs into an existing gate. The
principle: since the AI writes both code and its tests, a green suite is
only trustworthy with (a) an automated merge gate and (b) independent
oracles the AI cannot satisfy with shallow tests (golden replay,
property tests, mutation testing). The pipeline's Phase 5 still writes
per-task specs — this milestone is the infra those specs run on.

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-59** | CI pipeline (GitHub Actions) | T-01 | On every push/PR: `tsc --noEmit` strict → lint → unit → integration (with services) → e2e → coverage. Red blocks merge. The actual safety mechanism — everything else is optional without it. |
| **T-60** | Lint/format + pre-commit | T-01 | Biome (or ESLint+Prettier) config; `lefthook` pre-commit running typecheck + lint + changed-unit subset. Enforced in CI (T-59). |
| **T-61** | Vitest config + coverage + property testing | T-01 | Vitest set up; `fast-check` wired for property-based money/trigger tests; coverage with **ratcheted thresholds on core money/trigger/evolution modules** (not a vanity global %). |
| **T-62** | Injectable `Clock` abstraction | T-01 | `Clock` interface with real / fixed / virtual implementations. All time-sensitive code (entry/exit windows, EOD, day-of-week, cooldowns) takes `Clock` — never `Date.now()` directly. Consumed by T-15/T-16 and the T-57 replay harness. |
| **T-63** | Dockerized integration harness | T-02,T-03 | Ephemeral TimescaleDB+Redis per run (testcontainers / compose). Migration apply-from-scratch **+ idempotency** test, seed/fixture factories, teardown. |
| **T-64** | Playwright E2E config + deterministic boot harness | T-01 | `playwright.config.ts`, `test:e2e` script, harness booting API+frontend+seeded DB+Redis against a **deterministic feed (fixed seed) + fixed Clock**. Tag taxonomy `@critical`/`@functional`/`@non-blocker` (consumed by the pipeline Automation Gate). Specs themselves written per-task (T-20, T-42). |
| **T-65** | BrokerFeed conformance harness + WS fixture tooling | T-01 | Shared conformance test pack skeleton + recorded-WebSocket fixture recorder/player so every adapter (sim/Fyers/Angel/historical) is verified credential-free. Conformance assertions plug in when `BrokerFeed` lands (T-07). |

> **Cross-cutting (not M0.5 tasks — land where their dependency lands):**
> **Golden replay fixtures** — frozen historical input → checked-in
> expected trade ledger; added with T-57/T-58 in M3 (strongest
> regression anchor). **Mutation testing** (`Stryker`, scoped to
> money/trigger/evolution) — added in M3, run nightly in CI, not
> per-commit. **Runtime invariant assertions** (max 4 legs, Clockwork
> frozen, 8pp drift) — authored with T-31/T-39/T-40, reused in tests.

---

## Milestone 1 — Live Paper-Trading Vertical Slice + Dashboard ⭐ FIRST RUNNABLE

The owner's priority. One fixed-time straddle strategy, live Fyers data
(Angel One / simulator fallback), full basic-trigger exit logic, trades
recorded to DB, and a minimal read-only dashboard. End state:
`bun run sim` and live mode both produce a working trade loop visible in
the browser.

### Data ingestion
| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-07** | `BrokerFeed` interface + tick types | T-01 | `src/ingestion/brokers/types.ts` — `BrokerFeed` interface + `BrokerTick`. All adapters interchangeable. |
| **T-08** | Random-walk simulator | T-07, T-04 | `market-data-sim.ts` — realistic NIFTY tick stream at `SIM_TICK_INTERVAL_MS`, publishes to `market.ticks`. Credential-free. |
| **T-09** | Fyers WebSocket adapter (primary) | T-07, T-04 | `brokers/fyers.ts` via `fyers-api-v3` + `src/types/fyers-api-v3.d.ts` shim. Subscribe ATM CE/PE + index + `NSE:INDIAVIX-INDEX`. |
| **T-10** | Angel One adapter (fallback) | T-07, T-04 | `brokers/angelone.ts` (SmartAPI WebSocket) implementing `BrokerFeed`. Selected when Fyers unavailable / `BROKER=angelone`. |
| **T-11** | Instrument registry | T-01 | Weekly/monthly symbol builder + expiry helpers, `getAtmStrike()` (NIFTY 50 / BankNifty 100 / Sensex 100). Encoder/decoder for Fyers + Angel One symbol formats. |
| **T-12** | Broker selection wiring | T-08,T-09,T-10 | `src/index.ts` selects adapter from env: `SIMULATE=true` → sim; else `BROKER=fyers\|angelone` with Fyers default and Angel One fallback. |

### Straddle pipeline
| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-13** | Straddle calculator | T-05,T-11,T-12 | `straddle-calc.ts` — ATM strike, 15s snapshots, `straddle_value`, ROC, acceleration → `straddle_snapshots` + Redis `straddle.values`. Time-filtered hypertable writes only. |
| **T-14** | VIX feed (light) | T-04 | `vix-feed.ts` — NSE public API poller fallback + Fyers/Angel tick. Stored for context; not required by MVP exits. |

### Paper trade engine (MVP core)
| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-15** | Scheduled entry engine | T-06,T-13 | Fixed entry-time straddle entry (Clockwork-style). Honors **entry time window**, hard **exit time**, blocked-date / event-day gate. Emits an entry intent. |
| **T-16** | Trigger / exit engine | T-13 | Evaluates open positions against **SL**, **TSL**, **profit target**, **EOD square-off**, **daily loss cap**, **exit-time window**. Sets `exit_reason` (`SL\|TSL\|TARGET\|EOD\|MANUAL`). Pure, unit-testable. |
| **T-17** | Paper trade execution + P&L | T-05,T-15 | Open/close straddle legs, `gross_pnl`/`net_pnl`, `max_drawdown`, MFE, context-at-entry → `paper_trades`. Quantiply optional/stubbed. |
| **T-18** | Position monitor loop | T-16,T-17 | Subscribes `straddle.values`, marks open positions to market, runs trigger engine each tick, closes via T-17 on trigger. |

### API + dashboard
| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-19** | Fastify server + MVP REST/WS | T-17 | `GET /dashboard/live`, `GET /dashboard/summary`, `GET /paper-trades`, `WS /ws/ticks`. Schema-validated routes. |
| **T-20** | React dashboard shell | T-19 | Vite + React 18 + Tailwind + Zustand. Live straddle value (Lightweight Charts), open/closed trades table, running P&L. WS wired to `/ws/ticks`. Read-only. |
| **T-21** | End-to-end wire-up + smoke | T-18,T-20 | `src/index.ts` runs full loop. `SIMULATE=true bun run sim` produces visible trades + dashboard updates. SETUP smoke steps pass. |

---

## Milestone 2 — Momentum Signals + Multi-Personality Engine (Phase 1)

Layer the real signal engine and the six Phase-1 personalities on top of
the working slice.

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-22** | Peak detection engine | T-13 | Momentum-exhaustion: expansion %, ROC decline window, acceleration threshold, confirmation candles → `exhaustion_score`, writes `straddle_signals` + Redis `signals.generated`. |
| **T-23** | Probability scoring | T-22 | Base + VIX + time-of-day + day-of-week adjustments → clamped probability + confidence tier. |
| **T-24** | Fallback signals | T-22 | Scheduled-entry + pullback-entry signal types. |
| **T-25** | Full 10-personality seed | T-06 | Migration `003` seeds all 10 personalities with starting params (`PERSONALITIES.md`). Clockwork `is_frozen=TRUE`. |
| **T-26** | 5-stage decision filter | T-25 | Hard / state / context / signal-quality / profit-gate stages, each independently unit-testable. |
| **T-27** | Personality router | T-26 | Broadcast every signal to all active personalities; independent filter chains; no shared decision-time state. |
| **T-28** | Holder management | T-27 | Formalize no-adjustment style (already implicit in MVP); held to SL/TSL/EOD. |
| **T-29** | Adjuster management | T-27,T-28 | Roll one leg at `adjustment_trigger_points`; respect `max_open_legs`. |
| **T-30** | Reducer management | T-27,T-28 | Cut one straddle on adverse move; re-enter on VIX spike / re-entry signal gate. |
| **T-31** | Hard portfolio risk rules | T-29,T-30 | Max 4 legs (hard cap), portfolio-level stop, event-day gate, 30% margin buffer — enforced across all styles. |
| **T-32** | Personality CRUD + perf API | T-25 | `GET/PUT /personalities`, `GET /personalities/{id}/performance`, audit-logged config changes. |

---

## Milestone 3 — Fyers Historical Data, Replay & Backtesting

Unlock data-driven validation: pull Fyers historical data, reconstruct
straddles for past dates, replay them through the **real** pipeline, and
run full backtests over the personality engine. Sequenced after M2 so
there is a signal + personality engine to replay against. Consolidates
the old `T-51` backtesting task (re-homed here with broader scope).

> **Forward dependency note:** per-regime backtest reporting (T-58)
> needs the regime tagging engine (**T-33**, Milestone 4). If
> regime-bucketed backtests are wanted before M4, pull T-33 forward and
> implement it alongside this milestone — the rest of M3 does not
> depend on it.

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-54** | Fyers historical REST client | T-09 | `brokers/fyers-historical.ts` — Fyers history REST API (candles/quotes), reuses Fyers auth + `fyers-api-v3` shim. Date-range chunking, pagination, rate-limit backoff, typed responses. |
| **T-55** | Historical backfill store + writer | T-05,T-54 | Idempotent backfill into `market_ticks` / `option_ticks` hypertables (time-filtered, dedupe on conflict). Resumable; tracks backfilled ranges. |
| **T-56** | Historical straddle reconstruction | T-13,T-55 | Rebuild `straddle_snapshots` (value, ROC, acceleration) from historical option candles for any past date range — live snapshots do not exist for the past. |
| **T-57** | Deterministic replay harness | T-12,T-56 | `HistoricalFeed` implementing `BrokerFeed` + a virtual clock. Replays a historical window through the real pipeline at configurable speed; deterministic given the same data. |
| **T-51** | Backtest runner *(re-homed from old M5)* | T-27,T-57 | Run all active personalities over a historical window via the replay harness. Train/test split + reserved **holdout** period that optimisation must not touch. |
| **T-58** | Backtest reporting + statistical validation | T-51,T-33 | Per-regime Sharpe / drawdown, signal accuracy, per-personality results. Two-sample t-test / Mann-Whitney U (p < 0.05). Holdout-respecting; emits an experiment-card-style report. |

---

## Milestone 4 — EOD Retrospection + Rule-Based Evolution (Phase 1)

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-33** | Regime tagging engine | T-13 | Classify each day `RANGING\|TRENDING_STRONG\|VOLATILE_REVERTING\|EVENT_DAY`. Every retrospection result carries it. |
| **T-34** | BullMQ EOD job scaffold | T-04 | Redis-backed scheduler, EOD trigger, `< 5 min` budget, off critical path. |
| **T-35** | Daily metrics computation | T-34 | Per-personality trades / win rate / P&L / drawdown / Sharpe → `retrospection_results`. |
| **T-36** | Beat-Clockwork delta | T-35 | `clockwork_pnl_today`, `beat_clockwork_by` for every non-Clockwork personality. |
| **T-37** | Signal calibration | T-35 | Brier score + reliability for signal-based personalities. |
| **T-38** | Management effectiveness | T-35 | Roll/cut P&L vs estimated hold baseline → `mgmt_verdict`. |
| **T-39** | Comparison integrity check | T-25 | Pause evolution on outlier if Precision/Adjuster/Reducer `min_probability` drift > 8pp. |
| **T-40** | Rule-based evolution engine | T-35,T-39 | Entry + management tuning rules; min sample size, cooldown, max-applications, approval gate; `FROZEN_VIOLATION` guard on Clockwork / identity attributes. |
| **T-41** | Retrospection + evolution API | T-40 | `POST /retrospection/run`, `GET /retrospection/results/{date}`, `POST /personalities/{id}/evolve`, full audit/change log. |
| **T-42** | Dashboard: retrospection view | T-41,T-20 | EOD reports + timing-analysis charts in the dashboard. |

---

## Milestone 5 — Phase 2: S/R Signals, Multi-Index, Bayesian (later)

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-43** | S/R detection engine | T-13 | Objective levels (prev-week H/L, monthly pivot, volume POC) + strength score. |
| **T-44** | Levelhead personality | T-43,T-27 | S/R-anchored entry + Reducer mgmt; `phase=2` gated. |
| **T-45** | Multi-index expansion | T-11 | BankNifty + Sensex (ATM intervals, registry, feeds). |
| **T-46** | Bayesian optimization | T-40 | Gaussian-process parameter search for stable personalities (≥200 samples). |

---

## Milestone 6 — Phase 3/4 + Production Readiness (later, data-gated)

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-47** | Strategies 2 & 3 | T-27 | Directional ATM short + momentum buy. |
| **T-48** | Genetic-algorithm evolution | T-46 | Population/fitness/crossover/mutation over configs. |
| **T-49** | Dynamic slippage model | T-17 | Microstructure-aware `f(roc, spread, volume, oi)` + tail stress tests. Replaces optimistic static assumption. |
| **T-50** | Portfolio Greeks + circuit breaker | T-31 | Aggregate delta/gamma; pause all personalities past exposure cap. |
| **T-52** | Probability recalibration | T-37 | Isotonic / Platt scaling + reliability diagrams. |
| **T-53** | Prod hardening | T-09 | Fyers daily token auto-refresh, Railway/Fly.io deploy, secrets hygiene audit. |

---

## Sizing & Workflow Notes

- **Right-sizing:** infra primitives (DB client, Redis client) are
  their own tasks because everything depends on them; conversely a
  whole management style = one task (cohesive, independently testable).
  No task is a trivial one-liner; none is a multi-week subsystem.
- **Parallelism:** within a milestone, tasks with no `depends on` edge
  can be implemented in parallel by separate agents (no shared file
  writes — e.g. T-08/T-09/T-10/T-11 are independent broker files).
- **Testing model:** Milestone 0.5 builds the *infra and gate* (CI,
  Vitest/coverage, Clock, integration + Playwright harness, conformance
  pack). The pipeline's Phase 5 then writes the *per-task specs*
  (unit + integration; E2E for dashboard tasks) that run on that infra.
  Golden replay + mutation testing are independent oracles added in M3.
  Acceptance criteria above are the per-task test contract.
- **Task-ID stability:** `T-XX` IDs are permanent identifiers, not a
  sequence. Numeric order need not match milestone order — e.g. `T-51`
  was re-homed from the old M5 into Milestone 3 with broader scope, ID
  unchanged so references stay stable. New work appends new IDs rather
  than renumbering.
- **Gates:** each milestone end is a natural Human Gate. Milestone 1
  is the first "is this real and working?" checkpoint.
- **Next step:** on approval, decompose **Milestone 0 + Milestone 0.5
  + Milestone 1** into formal `pipeline/tasks/T-XX.json` contracts and
  begin implementation; later milestones stay as this roadmap until
  reached.
