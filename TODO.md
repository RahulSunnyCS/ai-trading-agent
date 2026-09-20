# TODO — single source of truth

Every open work item for this repo lives here and **nowhere else**. If it is not
on this list, it is not committed to.

This file replaced the task lists that used to live in
`docs/algotest-execution.md` (phases + pending actions) and `docs/roadmap.md`
(milestones + ideas). Those files still exist, but only as **reference**: the
verified AlgoTest API contract, the decision log, the cutover runbook, and the
per-task acceptance detail. They no longer carry status or open items.

**Conventions**

- **Who** — `owner` = only the repo owner can do it (create a secret, click a
  UI, watch a live run, decide a trade-off). `claude` = can be done from a
  session. `owner→claude` = owner unblocks, then it is codeable.
- Ordered by priority. Within a priority, ordered by what unblocks what.
- A task with a `T-` number has an acceptance contract — either in
  `docs/roadmap.md` (T-01…T-65) or inline below (T-70+).
- Status lives here. `.claude/project/overview.md` holds *what is built*; this
  file holds *what is left*.

Last updated: 2026-09-20

**Closed while consolidating** (they were still listed as open somewhere, but
are done): the stray `yarn.lock` and `package-lock.json` are both gone; T-51
(backtest runner) and the M4 retrospection modules exist and are wired —
though see 3.3.0 for the difference between *present* and *audited*.

---

## Priority 1 — Broker login, live in the monorepo

The daily Playwright job that logs Angel One and Finvasia into AlgoTest.
Code is merged and typechecks; **nothing has run for real from this repo yet.**

The untested delta vs. the old `algo-automation` workflow, which did run: this
repo's version replaced `npm ci` with `setup-bun` + `bun install --frozen-lockfile`
inside the Playwright container. That swap has never executed. One other
difference worth watching on the first real run — Finvasia failed the Saturday
test via the row-state path (`submitted but row still shows logged_out`) rather
than the toast path Angel One took, so the two brokers may not report a genuine
refusal the same way.

| # | Task | Who | Notes |
|---|---|---|---|
| 1.1 | Create the 10 `algo-automation` secrets on `RahulSunnyCS/ai-trading-agent` | owner | `ALGOTEST_PHONE`, `ALGOTEST_PASSWORD`, `ANGELONE_CLIENT_CODE`, `ANGELONE_MPIN`, `ANGELONE_TOTP_SECRET`, `SHOONYA_CLIENT_ID`, `SHOONYA_PASSWORD`, `SHOONYA_TOTP_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Values are in the old repo's Settings → Secrets. They do **not** migrate with the code. |
| 1.2 | Decide where those ten live | owner | Recommended: a GitHub **Environment** with required reviewers, not plain repo secrets. Merging the repos removed the boundary that kept broker credentials away from the Razorpay keys — an Environment restores it. |
| 1.3 | One **successful** `workflow_dispatch` run of "Daily broker login" **on a weekday** inside 08:15–15:40 IST | owner | Dispatch on a **trading day** — that is the whole trick. The two `failure` lines in `packages/broker-login/run-log.md` are *not* this repo's: they came in with the subtree merge and belong to `algo-automation` runs `35427092512`/`35427372298`, both dispatched Sat 2026-09-19. Logs show the automation worked end to end — AlgoTest login OK, My Brokers opened, credentials and TOTP accepted — and AlgoTest refused with *"Broker login is only possible between 08:15 IST - 15:40 IST **on trading days**"*. Saturday, so a refusal was guaranteed. Nothing to fix. |
| 1.4 | Uncomment `schedule:` in `.github/workflows/daily-broker-login.yml`, merge to `main` | owner | Crons only fire from the default branch. Do this only after 1.3 passes. |
| 1.5 | Merge `claude/stock-trading-monorepo-plan-k4zs5t` → `main` in `algo-automation` | owner | A branch was created there on 2026-09-19 carrying one doc-only commit (a new `CLAUDE.md`, since that repo had none, pointing at this monorepo). Nothing breaks if it is never merged — but the repo stays without any orientation file until it is. |
| 1.6 | CODEOWNERS on `packages/broker-login/` | claude | So execution-path changes always get a review. |
| 1.7 | Selector-drift canary | claude | A scheduled run that asserts the AlgoTest login selectors still resolve, so drift is caught before 08:35 on a trading day rather than during it. Case + cost: `docs/roadmap.md` → Ideas #4. |

---

## Priority 2 — Trading analytics (contract notes), live in the monorepo

The daily job turning broker contract-note emails into realised F&O P&L in the
Google Sheet. **The `trade-analytics` repo still owns the live cron** — this
repo's copy is disabled. Step 2.4 is the one that can damage the sheet.

Full procedure and rollback: `docs/algotest-execution.md` → Runbook.

| # | Task | Who | Notes |
|---|---|---|---|
| 2.1 | Create the 5 `trade-analytics` secrets here | owner | `BROKER_ACCOUNTS_JSON`, `GOOGLE_CREDENTIALS`, `GOOGLE_SHEET_ID`, `SHEET_GID`, `SHEET_NAME`. |
| 2.2 | Merge `claude/stock-trading-monorepo-plan-k4zs5t` → `main` in `trade-analytics` | owner | Commit is pushed and waiting. Comments out its cron, keeps `workflow_dispatch` as the rollback. |
| 2.3 | Dispatch "Daily Trading Data Processing" here once | owner | Reseeds the `row-tracker` artifact, which is scoped to the old repo and does not migrate. |
| 2.4 | Check the row it wrote against the sheet | owner | Right after the last real trading day, nothing overwritten, columns aligned to `sheetStartColumn`. With no artifact, `updateSheet.js` falls back to reading the sheet — this is the only moment that fallback is unverified. |
| 2.5 | Uncomment `schedule:` in `contract-notes-daily.yml`, merge to `main` | owner | |
| 2.6 | Watch one real overnight run | owner | Before calling the cutover done. |
| 2.7 | Archive `trade-analytics` and `algo-automation` | owner | **Archive, not delete** — the old Actions artifacts and run history live there. Only after both cutovers run clean. |
| 2.8 | `realised-pnl.schema.json` contract emitted by contract-notes | claude | The typed hand-off that lets realised P&L be ingested as a benchmark series. Prerequisite for 3.3. |
| 2.9 | `packages/contract-notes`: CJS → ESM | claude | Last package on CommonJS. Cosmetic until it blocks something — low priority within P2. |

---

## Priority 3 — Everything else

### 3.1 Telegram approval gate

Signal fires → Telegram message with Approve/Reject buttons → owner taps →
`repository_dispatch` fires the (not-yet-built) `activate-strategy.yml`.
Scoped and decided; contracts below are ready to implement.

**Design decisions already locked** (do not re-litigate):

- **Intent-level, not signal-level.** A raw signal carries no personality,
  strike or lots — those only exist after `personality-router.ts` runs its
  5-stage filter. The gate hooks the `passingIntents[]` array, filtered to one
  configured execution personality.
- **The internal paper-trade simulator is unaffected.** `personality-router`
  opens simulated trades for every passing personality unconditionally
  (`personality-router.ts:539-542`). Rejecting or expiring an approval only
  means "do not also fire this on real AlgoTest".
- **Webhook, not long-polling.** `apps/server` is already a public HTTPS
  service with a webhook precedent (`routes/payment.ts`).
- **Explicit Reject button**, not expiry-as-implicit-reject — Phase 5 wants
  approve/reject as a labelled dataset.
- **`dispatch_failed` is a distinct state** from `approved`, surfaced in the
  Telegram message, so a GitHub API failure is never silent.
- **FK the signal, snapshot the params.** `straddle_signals` already stores the
  signal immutably, so reference it. The strategy params are mutable config, so
  snapshot them as JSON on the row — same reasoning as
  `option-backtesting`'s `strategy_yaml` registry column.
- **Use `recoverPending()` + `streamConsume()`** (the `position-monitor.ts`
  pattern), *not* `personality-router.ts`'s hand-rolled read loop — see 3.5.4.

**Blocked on owner before this can be tested end-to-end:**

| # | Task | Who |
|---|---|---|
| 3.1.0a | Your Telegram numeric user ID (from `@userinfobot`) — the gate checks `callback_query.from.id` against it, so that only you can fire a trade, not merely anyone who can reach the chat | owner |
| 3.1.0b | Confirm the bot can receive `callback_query` (BotFather; default for private chats) | owner |
| 3.1.0c | Confirm the expiry window — default **5 minutes** unless you say otherwise | owner |
| 3.1.0d | Decide GitHub dispatch auth: fine-grained PAT (`actions: write`, this repo only) vs GitHub App. Recommended: PAT for now, given this is personal-account scope | owner |

#### Task contracts

**T-70 — `execution_approvals` table**
- Create: `apps/server/src/db/migrations/013_execution_approvals.sql`
- Modify: `apps/server/src/db/schema.ts`
- Columns: `id` (uuid pk), `signal_id` (fk → `straddle_signals`), `personality_id`
  (fk → `personality_configs`), `strategy_params` (jsonb snapshot),
  `status` (`pending|approved|rejected|expired|dispatch_failed`),
  `telegram_message_id`, `telegram_chat_id`, `created_at`, `expires_at`,
  `resolved_at`, `dispatch_run_url`
- Acceptance: migration is idempotent and applies from scratch; TS interface
  added alongside the existing ones; index on `(status, expires_at)` for the
  sweep; **no** status column default that would let a row skip `pending`
- Depends on: nothing

**T-71 — Intent emit point**
- Modify: `apps/server/src/signals/personality-router.ts`,
  `apps/server/src/redis/client.ts` (add `STREAM_EXECUTION_INTENTS`)
- After `passingIntents[]` is built (step 8), `XADD` to `execution.intents`
  **only** the intent whose `personalityId` matches the configured execution
  personality
- Config: `EXECUTION_PERSONALITY_NAME` resolved to an id once at startup
  (the DB id is a UUID; a name like `Clockwork` is what a human can audit).
  Unset → feature entirely off, no emit, no behaviour change.
- Acceptance: every existing `personality-router` test still passes unchanged;
  new test asserts (a) emit happens only for the configured personality,
  (b) simulated paper trades still open for **all** passing personalities
  regardless of emit, (c) unset config emits nothing
- Depends on: nothing (can land before T-70)

**T-72 — Approval-gate consumer**
- Create: `apps/server/src/execution/approval-gate.ts`
- Add `@trading/notify` to `apps/server`'s dependencies
- `recoverPending()` at start, then `streamConsume()` on `execution.intents`,
  consumer group `approval-gate`
- Per intent: INSERT `execution_approvals` (`pending`,
  `expires_at = now + EXECUTION_APPROVAL_EXPIRY_MINUTES`), send a
  `Notification` with two `Action`s — `appr:<id>` / `rej:<id>` — then persist
  the returned `message_id`
- Acceptance: `callback_data` ≤ 64 bytes (Telegram's cap); unconfigured
  Telegram falls through `@trading/notify`'s null-config path (logs, does not
  throw); a crash between INSERT and send leaves a `pending` row that the
  sweep expires rather than a silently lost intent
- Depends on: T-70, T-71

**T-73 — Telegram webhook route**
- Create: `apps/server/src/server/routes/telegram-webhook.ts`; register in
  `apps/server/src/server/index.ts`
- `POST /api/telegram/webhook`, **no** access-gate middleware (owner-only, same
  shape as `routes/fyers-auth.ts`)
- Verify `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`
  with a timing-safe compare → else 401
- Verify `callback_query.from.id === TELEGRAM_OWNER_USER_ID` → else
  `answerCallbackQuery` with a refusal and return 200 (do not leak existence)
- Resolve atomically: `UPDATE execution_approvals SET status = $1, resolved_at
  = now() WHERE id = $2 AND status = 'pending' RETURNING *` — zero rows means
  already resolved, expired or double-tapped, and is a no-op, not an error
- Re-check `expires_at` at tap time (Telegram never expires a button itself)
- Always `answerCallbackQuery` (else the client spinner hangs), then
  `editMessageText` so the buttons disappear and the outcome shows
- Acceptance: tests for wrong secret, wrong user id, double-tap, tap-after-
  expiry, and the happy path
- Depends on: T-70

**T-74 — `repository_dispatch` caller**
- Create: `apps/server/src/execution/github-dispatch.ts`
- `POST /repos/{owner}/{repo}/dispatches`, `event_type: activate-strategy`,
  `client_payload: { approval_id, signal_id, personality_id, strategy_params }`
- Token from `GH_DISPATCH_TOKEN` (Railway env, **not** an Actions secret —
  `apps/server` is the caller, not a workflow). Absent → dry-run log only.
- Non-2xx or network failure → set `dispatch_failed` and edit the Telegram
  message to say so; only a 2xx sets `approved`
- Acceptance: tests for success → `approved`, failure → `dispatch_failed`,
  missing token → dry-run and no state change
- Depends on: T-73, 3.1.0d
- **Security note:** this is the first credential in the repo that can make
  GitHub *do* something rather than read. Scope it to `actions: write` on this
  one repo and nothing else.

**T-75 — Expiry sweep**
- Modify: `apps/server/src/execution/approval-gate.ts`
- Periodically mark `pending` rows past `expires_at` as `expired` and edit
  their Telegram messages to drop the buttons
- Acceptance: an expired row cannot subsequently be approved; the sweep is
  idempotent and safe to run concurrently with a tap (same atomic-UPDATE guard)
- Depends on: T-73

**T-76 — Webhook registration + ops**
- Create: a `telegram:register` script calling `setWebhook` with
  `secret_token` and `allowed_updates: ['callback_query']`
- Modify: `.env.example`, `.claude/project/technical.md`
- New env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_WEBHOOK_SECRET`,
  `EXECUTION_PERSONALITY_NAME`, `EXECUTION_APPROVAL_EXPIRY_MINUTES`,
  `GH_DISPATCH_TOKEN`
- Acceptance: re-running the script is idempotent; `.env.example` documents
  every variable above; `technical.md` gains the approval-gate convention
- Depends on: T-73

### 3.2 Playwright strategy activation

Consumes the `repository_dispatch` T-74 fires. **Must land before the gate is
anything but a dry run.**

| # | Task | Who |
|---|---|---|
| 3.2.1 | New `.github/workflows/activate-strategy.yml` with a `repository_dispatch` trigger, mirroring `daily-broker-login.yml`'s container/timeout/concurrency shape | claude |
| 3.2.2 | **Read-back assertion** — scrape strategy name + params from the DOM and assert they match the command before clicking. Never click on position alone. | claude |
| 3.2.3 | Dry-run default — `ACTIVATE_ENABLED` absent = log only | claude |
| 3.2.4 | Kill switch + daily cap | claude |
| 3.2.5 | Post-act reconciliation — re-read AlgoTest state, alert on divergence | claude |
| 3.2.6 | Decide where the real strategy params come from: a checked-in DSL file (mirroring `option-backtesting`'s YAML strategies) vs hardcoded "2 lots, ATM straddle". They are **not** derivable from `personality_configs`. | owner |
| 3.2.7 | All new locators go in `packages/broker-login/src/selectors.ts` | claude |

### 3.3 Measure the signal — the gate before anything fires for real

Probability scores are still uncalibrated, so the edge is unmeasured. **Do not
enable live execution until this shows one.**

| # | Task | Who | Notes |
|---|---|---|---|
| 3.3.0 | Audit that M4 retrospection is actually complete, not just present | claude | `overview.md` says of T-34–T-38 / T-40–T-42: *"this records the modules' presence, not an audit of their completeness."* Every calibration item below builds on those numbers being right. Verify before trusting them. |
| 3.3.1 | Ingest realised P&L as a benchmark series alongside Clockwork | claude | Depends on 2.8. |
| 3.3.2 | Calibrate the probability scores | claude | Fit isotonic/Platt against realised outcomes; Brier scores already land in `retrospection_results.signal_brier_score`. Case + cost: roadmap Ideas #1. |
| 3.3.3 | Reconcile realised P&L against paper P&L | claude | The whole point of closing the loop. Roadmap Ideas #2. |
| 3.3.4 | Feed real fills into the backtest fill model | claude | Roadmap Ideas #3. |
| 3.3.5 | **Gate:** do not start 3.4 until the signal shows a measured edge | owner | |

### 3.4 Live execution (hard-gated behind 3.3)

| # | Task | Who |
|---|---|---|
| 3.4.1 | Answer AlgoTest Q4 — is there a broker re-login endpoint? DevTools → Network → Fetch/XHR while clicking "Re-login" on a broker card. A redirect to the broker's domain means Playwright stays; an XHR to AlgoTest means the browser bot can eventually be deleted. | owner |
| 3.4.2 | One strategy, minimum lots, daily cap | claude |
| 3.4.3 | Kill switch tested **before** the first live fire | owner |
| 3.4.4 | Reconciliation: AlgoTest position vs our intent, every fire | claude |
| 3.4.5 | Log every approve/reject — this is a labelled dataset | claude |

### 3.5 Repo hygiene

| # | Task | Who | Notes |
|---|---|---|---|
| 3.5.1 | Authorize the AlgoTest MCP connector | owner | Not optional: `packages/option-backtesting` ingests option bars *through MCP*. Without it the nightly ingest cannot run. |
| 3.5.2 | Check the nightly ingest Routine is still alive | owner | M-5 bound it to a session rather than fresh-per-fire (this org cannot grant MCP connectors to fresh-session Routines). A session-bound Routine dies with its session. Verify or rebind. |
| 3.5.3 | Fix the dashboard type error and enforce `typecheck` in CI | claude | One pre-existing error keeps the whole dashboard out of CI typecheck. Roadmap Ideas #6. |
| 3.5.4 | Fix `personality-router`'s unreclaimed pending messages | claude | `personality-router.ts:402` claims XAUTOCLAIM reclaims failed messages. It does not — `recoverPending()` has no caller for that consumer group, so a crash mid-signal strands the message forever. `position-monitor.ts:253` has the correct pattern. |
| 3.5.5 | Fail CI on undeclared dependencies | claude | Four latent bugs surfaced during the merge; nothing stops a fifth. Roadmap Ideas #5. |
| 3.5.6 | Guard against documentation drift | claude | Roadmap Ideas #9. |
| 3.5.7 | Run E2E against a real backend | claude | Roadmap Ideas #7. |

### 3.6 Later milestones — not started, not sequenced

Acceptance detail for every `T-` number below is in `docs/roadmap.md`.

- **M5 / Phase 2** — S/R signal detection engine, Levelhead personality,
  BankNifty + Sensex expansion, Bayesian optimisation
- **M6 / Phase 3–4** — strategies 2 & 3, genetic algorithms,
  microstructure-aware slippage, reinforcement learning, live-trading
  readiness assessment
- **T-58** — per-regime statistical reporting is only *partly* covered.
  `option-backtesting` M-5 added regime bucketing, but it is bucketing for
  analysis, not a live strategy-DSL condition.

### 3.7 Not committed to

Ideas grounded in this codebase, each carrying its own case against. Full
reasoning in `docs/roadmap.md` → Ideas. **Nothing here starts without first
beating something above it.**

| Idea | One-line case against |
|---|---|
| Make regime a live strategy-DSL condition (#8) | Look-ahead risk; the bucketing that exists is honest, a live condition may not be |
| Revisit Turborepo (#10) | Only on stated triggers — build times are not the bottleneck today |

*(Ideas #1–#7 and #9 are already promoted into 3.3 and 3.5 above.)*

---

## Reference — where detail lives

| Document | What it holds now |
|---|---|
| `docs/algotest-execution.md` | The verified AlgoTest API contract (do not re-derive), the decision log, and the contract-notes cutover runbook with rollback |
| `docs/roadmap.md` | The T-number task catalogue — what each covers, depends on, and what "done" meant — plus the full case for and against each uncommitted idea |
| `.claude/project/overview.md` | What is **built** (Implementation Phases). This file holds what is **left** |
| `docs/epics.md` | Permanent delivery record. Never deleted, never a TODO |
| `docs/architecture.md`, `product.md`, `setup.md`, `testing.md` | Reference specs. No status, no tasks |
