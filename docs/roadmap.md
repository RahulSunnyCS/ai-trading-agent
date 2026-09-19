# AI Trading Agent — Delivery Roadmap

This is the master task breakdown for the whole project, split into
milestones and right-sized tasks. Each task (`T-XX`) is scoped to be
completable by a single implementor in one focused pass — not a one-line
change, not a whole subsystem. `TODO.md` is the at-a-glance mirror of
this file.

> Source specs: `docs/product.md`, `docs/architecture.md`. This roadmap sequences them; it does
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

## Delivery Status

**This file tracks no status and no priorities.** It drifted before — the M3 row
once claimed T-51/T-58 complete while the gap list below still called them
outstanding — which is exactly what the one-fact-one-file rule in `CLAUDE.md`
exists to prevent. So:

- **What is left to do** → [`/TODO.md`](../TODO.md), the single source of truth,
  ordered by priority and marked per item as owner-blocked or codeable.
- **What is already built** → `.claude/project/overview.md` → Implementation
  Phases, auto-loaded into every session.

What this file is for: the **task catalogue** — what each T-number covers, what
it depends on, and what "done" meant for it. That detail exists nowhere else.

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

## Milestone 0.5 — Testing & CI Foundation (lean — research-tool scoped)

This is a solo research tool: the failure mode is **silent wrong
numbers and non-reproducible findings**, not multi-user regressions or
scale. So test the strategy/money math and run-to-run reproducibility
hard; skip team/scale ceremony. Built before heavy implementation so
later tasks plug into an existing gate. The pipeline's Phase 5 still
writes per-task specs — this milestone is the infra they run on.

### Essential — correctness & reproducibility, not ceremony

| Task | Title | Depends on | Acceptance (summary) |
|---|---|---|---|
| **T-59** | Lean CI (GitHub Actions) | T-01 | On push/PR: `tsc --noEmit` strict → lint → unit. Integration on a nightly/manual job, not every push. Red blocks merge. ~1h to stand up; grows later, not gold-plated now. |
| **T-60** | Lint/format + pre-commit | T-01 | Biome (or ESLint+Prettier) + `lefthook` pre-commit (typecheck + lint + changed-unit). Near-zero-effort hygiene. |
| **T-61** | Vitest + targeted property tests | T-01 | Vitest; `fast-check` on the money/trigger/evolution math (P&L, SL/TSL/target, clamping, peak detection, rule conditions). Coverage **tracked, not gated** — no ratcheted threshold. |
| **T-62** | Injectable `Clock` | T-01 | real / fixed / virtual. All time-sensitive code takes `Clock`, never `Date.now()`. Prerequisite for testable time-logic **and** reproducible M3 replay. Cheap, day-one. |
| **T-63** | Minimal integration harness | T-02,T-03 | Ephemeral TimescaleDB+Redis; migration apply-from-scratch **+ idempotency**, the one signal→personality→trade flow, fixture factories. Deliberately not a sprawling suite. |

### Cross-cutting research-integrity oracle (lands in M3)

> **Deterministic golden replay** — frozen historical input → checked-in
> expected trade ledger. For a research tool this is not just regression
> safety, it is a **reproducibility requirement**: a finding you cannot
> reproduce run-to-run is not a finding. Added with T-57/T-58 — highest
> ROI test in the whole project, cheap once replay exists. Runtime
> invariant assertions (max 4 legs, Clockwork frozen, 8pp drift) are
> authored with T-31/T-39/T-40 and reused here.

### Deferred — add only when the project earns it (intentionally not now)

- **Playwright E2E** — dashboard is read-only and personal. When M1
  lands, add **2–3 smoke specs only** (page loads, trades table
  populates) via a minimal `playwright.config.ts`. A full tagged suite
  + boot harness is overhead until there are users. *(was T-64)*
- **BrokerFeed conformance pack** — premature until 2+ real adapters
  diverge; revisit when Angel One / historical adapters land. *(was T-65)*
- **Mutation testing (Stryker)** — slow, fiddly, pays off only on a
  hardened core with a team. Likely skip solo; reconsider post-M3 if a
  module becomes load-bearing.
- **Ratcheted coverage gates** — chasing a number is itself overhead
  solo. Track coverage, never gate on it.

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
| **T-25** | Full 10-personality seed | T-06 | Migration `003` seeds all 10 personalities with starting params (`docs/product.md`). Clockwork `is_frozen=TRUE`. |
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
- **Testing model (research-tool scoped):** M0.5 builds only the
  essential gate + correctness infra (lean CI, Vitest + targeted
  property tests, Clock, minimal integration harness). Deterministic
  golden replay in M3 is the reproducibility oracle. E2E /
  conformance / mutation / coverage-gates are explicitly deferred until
  the project earns them. Phase 5 writes per-task specs onto this
  infra; acceptance criteria above are the per-task contract.
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

---

# Ideas — not committed to

Candidate work that is **not committed to**. Everything here is grounded in
something observed in this codebase, and every item carries the case against it
— an idea without a stated cost is a wish, not a proposal.

Nothing here should be started without deciding it beats what is already in
[`/TODO.md`](../TODO.md). Several of these have since been promoted into that
file (#1–#7, #9); the rest stay here as the reasoned case for *not* doing them.

Last updated: 2026-09-19

---

## 1. Calibrate the probability scores

**Observed:** `technical.md` says *"Probability scores: not empirically
calibrated yet. Treat as relative rankings, not absolute probabilities."*
Brier scores are already computed and stored in
`retrospection_results.signal_brier_score`.

**Idea:** Run the stored signals against realised outcomes and fit a calibration
curve (isotonic or Platt). A signal claiming 70% should win ~70% of the time.

**Why it matters more than anything else here:** every threshold in the 5-stage
filter — `min_probability` for Precision, Scanner, Blitz — is set against an
uncalibrated number. If the scores are systematically 15 points optimistic,
every personality is trading a different strategy than its config claims, and
the whole comparison is measuring the wrong thing.

**Case against:** needs a meaningful sample of closed trades per regime. Fitting
on a thin sample produces a calibration curve that is itself overfitted — the
exact failure the platform was built to avoid. Do not start until the trade
count per regime bucket justifies it.

---

## 2. Reconcile realised P&L against paper P&L

**Observed:** `packages/contract-notes` produces **real** realised F&O P&L from
broker contract notes. `apps/server` produces **simulated** P&L. Nothing joins
them.

**Idea:** A scheduled job that matches the two on date and instrument and reports
the gap. The difference is slippage, fill quality, and cost-model error —
measured rather than assumed.

**Why:** the paper executor uses a flat cost model
(`total_lots × 2 legs × per_leg_rt`). Whether that is right is currently an
article of faith. Real contract notes settle it.

**Case against:** only works for days you actually traded manually, so the
sample builds slowly. And it needs the contract-notes cutover finished first
(`docs/algotest-execution.md` → Runbook).

---

## 3. Feed real fills into the backtest fill model

**Observed:** `packages/option-backtesting/src/option_backtesting/engine/fills.py`
offers `trigger_level` / `bar_close` / `worst_of_bar` / `next_open` plus a
slippage parameter — all chosen by assumption.

**Idea:** Use the realised fills from idea 2 to pick the fill mode and slippage
value empirically, per underlying and time-of-day bucket.

**Why:** backtest results are only as honest as the fill model. A golden-fixture
engine verified "to the rupee" is precise about the wrong number if fills are
modelled wrongly.

**Case against:** depends on 2, which depends on the cutover. Also a small
sample of real fills can mislead worse than a conservative assumption — if in
doubt, `worst_of_bar` is the safer default.

---

## 4. Selector-drift canary for broker-login

**Observed:** `packages/broker-login/src/brokers/types.ts` documents
`UNKNOWN` as *"usually a selector that stopped matching"* — selector drift is a
known, already-experienced failure mode. The login runs at 08:35 IST, inside a
window that closes at 15:40.

**Idea:** A read-only job that loads the AlgoTest pages an hour earlier and
asserts every locator in `src/selectors.ts` still resolves. No login, no
credentials beyond the platform session — just "does the DOM still match".

**Why:** the current failure mode is discovering drift at 08:35, when there is
one retry and a closing window. An early canary converts an outage into an
overnight fix.

**Case against:** a second Playwright job to maintain, and it can itself go
stale. It also cannot check anything behind the login without credentials, so
it covers the page shell rather than the broker cards.

---

## 5. Fail CI on undeclared dependencies

**Observed:** the monorepo merge surfaced **four** packages imported but never
declared — `fastify-plugin`, `ws`, `google-auth-library`, and the `bun-types`
types reference. All four had been resolving by accident through hoisting.

**Idea:** Add `knip` or `depcheck` to CI.

**Why:** these are invisible until the package manager's layout changes, and
then they all fail at once. Bun 1.2 hoists, 1.3 isolates — that upgrade is
coming whether or not anyone plans it.

**Case against:** both tools are noisy on monorepos and need an ignore list,
which becomes its own maintenance surface. The alternative — remembering to
declare imports — is free but unreliable.

---

## 6. Fix the dashboard type error and enforce it in CI

**Observed:** `technical.md` notes the dashboard *"has one pre-existing type
error and isn't CI-enforced yet"*. Confirmed: `bun run --filter @ata/dashboard
typecheck` fails with `Type 'boolean | undefined' is not assignable to type
'boolean'`. The root `typecheck` script is deliberately scoped to `@ata/server`
to route around it.

**Idea:** Fix the one error, then widen the root script and the CI job to cover
both apps.

**Why:** it is a single error. While it stands, the dashboard has no type gate
at all, and a second error would arrive unnoticed.

**Case against:** none worth the name. This is the cheapest item on the list.

---

## 7. Run E2E against a real backend

**Observed:** 4 of the 5 specs in `apps/dashboard/e2e/` use `page.route()` to
intercept and mock API responses. `playwright.config.ts` says so explicitly —
the suite is *"fully deterministic without a running API server"*.

**Idea:** Keep the mocked suite, and add a small second suite tagged
`@integration` that runs against a real server in `SIMULATE=true` with
TimescaleDB and Redis up.

**Why:** the current suite can only catch frontend regressions. A contract change
in a Fastify route — a renamed field, a changed shape — passes every E2E test
while breaking the dashboard, because the mock still returns the old shape.

**Case against:** slower, flakier, and needs service containers in CI. This is
why the suite was written mocked in the first place, and that reasoning was
sound. The proposal is to add a layer, not to replace one.

---

## 8. Make regime a live strategy-DSL condition

**Observed:** `packages/option-backtesting` M-5 added regime bucketing
(`analytics/regime_source.py`, `features/regime.py`), but its `DECISIONS.md`
records that this is post-hoc bucketing only, deliberately **not** a DSL
condition.

**Idea:** Revisit — let a strategy express "only enter in RANGING".

**Why:** the platform's central claim is that regime determines which
personality wins. If that is true, regime belongs in the entry condition, not
only in the report.

**Case against:** the original decision was right and is documented. Regime is
classified at 14:30 IST; making it an entry condition risks lookahead unless the
point-in-time discipline is airtight. Read that `DECISIONS.md` entry before
reopening this.

---

## 9. Guard against documentation drift

**Observed:** consolidating these docs found the same fact recorded four ways
and disagreeing with itself. `ROADMAP.md` claimed T-51 complete in one table and
outstanding two sections later. `overview.md` said the backtest runner did not
exist while `backtest-runner.ts` sat in the tree.

**Idea:** A CI check that greps for status language (`not started`, `deferred`,
`complete`) in `docs/**` and fails if it appears outside
`.claude/project/overview.md`.

**Why:** `CLAUDE.md` already states the one-fact-one-file rule. Nothing enforces
it, and it was violated repeatedly.

**Case against:** grep-based rules produce false positives on prose and train
people to phrase around the check rather than obey it. A lighter version — a
PR-template line asking "did this change a fact in `.claude/project/`?" — may
get most of the benefit.

---

## 10. Revisit Turborepo — but only on these triggers

**Observed:** evaluated and rejected during the merge. At the time: no
cross-package dependencies at all, root unit suite 16s, Jest 1.4s, and GitHub
`paths:` filters already doing affected-detection for free.

**Reconsider when at least two hold:**
- Packages start depending on each other (the `ExecutionCommand` contract will
  be the first)
- CI exceeds ~5 minutes
- More than 5 workspaces
- Remote caching between a laptop and CI becomes worth configuring

**Case against doing it now:** unchanged. It would add configuration to solve a
problem that has not appeared.
