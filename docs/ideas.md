# Ideas

Candidate work that is **not committed to**. Everything here is grounded in
something observed in this codebase, and every item carries the case against it
— an idea without a stated cost is a wish, not a proposal.

Nothing here should be started without deciding it beats what is already in
`docs/pending-actions.md`.

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
(`docs/runbooks/contract-notes-handover.md`).

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
