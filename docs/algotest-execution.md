# AlgoTest execution loop

Everything about the in-flight work to close the loop: a signal from this agent
triggers a real strategy on AlgoTest, and the resulting contract note comes back
as realised P&L to measure the signal against.

Three documents used to cover this — the plan, the owner's action list and the
cutover runbook. They were always read together, so they are one file now.

- [Plan, API contract and decision log](#plan)
- [Pending actions — blocked on the repo owner](#pending)
- [Runbook — contract-notes cutover](#runbook)

---

<a id="plan"></a>

## AlgoTest Execution Integration — Plan

**Status:** Phase 0 complete. Signals API declined on cost — executing via
Playwright behind a Telegram approval gate. Monorepo merge done.
**Last updated:** 2026-09-19
**Scope:** Personal account only. Not a subscriber-facing product feature.

> Deliberately **not** at repo root as `TODO.md` — that path is reserved by
> `CLAUDE.md` as the generated mirror of `pipeline/tasks/`. This is a
> hand-maintained cross-repo roadmap, not a pipeline artifact.

---

### 1. Goal

Close the loop: `ai-trading-agent` generates a signal → AlgoTest executes it →
the contract note comes back as realised P&L → retrospection measures whether
the signal had an edge.

```
ai-trading-agent ──HTTPS──> AlgoTest Signals API ──> broker ──> orders
       ▲                                                          │
       │                                                          ▼
  retrospection <── realised P&L <── contract-notes <── contract note email
```

**Non-goal:** shipping execution to subscribers. `business.md` states the
product does not execute real trades. That stays true because live mode is
gated by an env var never set in the subscriber deployment.

---

### 2. Verified API contract (Phase 0 output — do not re-derive)

Source: official SDK, `Algo-Test/algotest-api-trading`, folder `signal-api-demo-1`.

#### Auth — pure HTTP, no browser

Base URL: **`https://api.algotest.in`** (confirmed).

```
POST https://api.algotest.in/login
body:    { "phoneNumber": "+91XXXXXXXXXX", "password": "..." }
returns: cookies csrf_access_token, access_token_cookie
then:    header X-CSRF-TOKEN-ACCESS: <csrf>
         header Authorization:       <jwt>
```

#### Execution
```
POST {base}/webhook/custom-position/execution/start/paper
POST {base}/webhook/custom-position/execution/start/live?broker_id={broker_id}
POST {base}/webhook/custom-position/execution/square-off/{position_id}
  → 200 returns position_id (or id). PERSIST IT — required to square off.
```

#### Payload shape
The strategy definition travels **in the request body**. This is *not*
"activate a saved AlgoTest strategy" — it is "create a custom position from
this payload". Strategy config therefore lives in our repo, version-controlled.

The SDK's demo payload is a short ATM weekly straddle on SENSEX — i.e. exactly
what `src/trading/paper-trade-executor.ts` simulates. Mapping from
`PersonalityConfig` is close to mechanical.

```jsonc
{
  "access_token": "<see open question Q2>",
  "alert_name": "SENSEX_14:41",
  "exit_time": "2026-09-19T15:15",        // required; built-in EOD square-off
  "strategy": {
    "Ticker": "SENSEX",
    "Legs": [
      { "PositionConfig": {
          "PositionType": "PositionType.Sell",
          "Lots": 2,
          "LegStopLoss": { "Type": "LegTgtSLType.Percentage", "Value": 50 },
          "LegTarget":   { "Type": "None", "Value": 0 },
          "LegTrailSL":  { "Type": "None", "Value": {} },
          "ExpiryKind":  "ExpiryType.Weekly",
          "EntryType":   "EntryType.EntryByStrikeType",
          "StrikeParameter": "StrikeType.ATM",
          "InstrumentKind":  "LegType.CE" },
        "ExecutionConfig": { "ProductType": "ProductType.NRML" } }
      // ...identical leg with "InstrumentKind": "LegType.PE"
    ]
  }
}
```

#### Confirmed facts that shape the design

| Fact | Consequence |
|---|---|
| **No idempotency / no dedupe server-side** | We own it. Persist command ID *before* send; refuse replays. A retried POST = duplicate position. |
| **No retry logic in SDK** | We own backoff. Never blind-retry a start call. |
| **No token refresh in SDK** | Long-running process must re-login on 401. |
| **`broker_id` is live-only** | **Paper needs no broker session at all** → shadow mode does not depend on the Playwright broker-login bot. |
| **`exit_time` is required** | Free EOD auto-square-off safety net. Always set it. |
| **Phone format differs from the UI** | API schema is `^\+91\d{10}$` — the **`+91` prefix is required**. The web form wants bare 10 digits, so `algo-automation`'s `normalizePhone()` (which strips `+91`) must NOT be reused here. Needs its own formatter. |

---

### 3. Open questions — blocking Phase 1

- [x] **Q1 — Base URL: `https://api.algotest.in`** ✅ CONFIRMED 2026-09-19.
      `POST /login` returned HTTP 400 with an AlgoTest `application-user-id`
      header and a schema error naming the `phoneNumber` field — i.e. the
      request reached their application layer and matched the SDK's contract.
- [ ] **Q2 — `access_token` in the payload body.** A *second* credential,
      separate from the login cookies. Demo sets it to the literal `"anything"`.
      Hypothesis: it is the **webhook secret** issued when you create a Signal /
      alert in AlgoTest's Signals UI (endpoints are `/webhook/...`, payload has
      `alert_name` — TradingView-alert shaped). Confirm before live.
- [ ] **Q3 — Session lifetime** of the JWT cookie. Determines re-login strategy.
- [ ] **Q4 — Broker re-login endpoint.** Does AlgoTest expose one? If yes, the
      Playwright bot can be deleted entirely. Not needed before Phase 5.

---

### 4. Phases

#### Phase 0 — Verify ✅ DONE
- [x] Locate official API (Signals API, `Algo-Test/algotest-api-trading`)
- [x] Extract auth flow, endpoints, payload shape
- [x] Confirm idempotency absent → we own it
- [x] Confirm paper needs no `broker_id`
- [ ] Confirm Q1–Q3 from live docs *(in progress — user)*
- [ ] Authorize the AlgoTest MCP connector

#### Phase 1 — Monorepo merge ✅ DONE
- [x] `git subtree` `algo-automation` → `packages/broker-login` (14 commits preserved)
- [x] `git subtree` `trade-analytics` → `packages/contract-notes` (47 commits preserved)
- [x] Bun workspaces; workflow moved to root `.github/workflows/`
- [x] Path-filtered CI + `broker-login-ci.yml` so the package still gets checked
- [x] Dropped `package-lock.json` and the stray root `yarn.lock`
- [x] `playwright` added to `trustedDependencies` (else Bun skips the browser postinstall)
- [x] Declared four dependencies that were imported but never listed — they had
      only ever resolved through hoisting: `fastify-plugin`, `ws` (root),
      `google-auth-library` (contract-notes), and `tsconfig` types `bun-types` → `bun`

##### Handover before either cron is enabled

Both daily workflows ship with their `schedule:` commented out, and GitHub only
fires schedules from the default branch (`main`), so nothing runs twice
today. The cutover sequence, the 15 repository secrets that do **not** migrate,
and the rollback path are in
**[the runbook below](#runbook)**.

##### Toolchain: bun pin verified ✅

CI pins bun `1.2.x`; the lockfile was generated with `1.3.11`. Tested directly
by installing 1.2.21 from npm and running CI's exact sequence:
`bun install --frozen-lockfile` succeeds, leaves `bun.lock` untouched (so
`git diff --exit-code bun.lock` passes), and typecheck, the 956 root unit tests
and the 113 contract-notes Jest tests all pass under it. **No pin change needed.**

Worth knowing: 1.2 hoists and 1.3 isolates, so the two produce different
`node_modules` layouts from the same lockfile. The repo works under both now
only because the four previously-undeclared dependencies were made explicit —
under 1.2's hoisting they would still be silently resolving by accident.

#### Phase 2 — Telegram approval gate  ← NEXT
The human decides; the machine executes. No unattended trading yet.

- [ ] Signal fires → Telegram message with an **inline keyboard button**
- [ ] **Never a clickable URL** — Telegram pre-fetches links for previews and
      would trigger the trade before you tap it. `callback_query` only: no
      public endpoint, no preview crawler.
- [ ] Verify `callback_query.from.id` against our own Telegram user ID
- [ ] Single-use: mark the command consumed on first tap; second tap no-ops.
      This is the idempotency layer, sited at the human gate where it is cheapest.
- [ ] Expiry: refuse a signal older than N minutes (a stale momentum entry is a
      different trade)
- [ ] Edit the message after action so the button disappears and the outcome shows
- [ ] On approval → `repository_dispatch` → `activate-strategy.yml`

#### Phase 3 — Playwright strategy activation
- [ ] Add `repository_dispatch` trigger to a new `activate-strategy.yml`
- [ ] **Read-back assertion**: scrape strategy name + params from the DOM and
      assert they match the command *before* clicking. Never click on position alone.
- [ ] Dry-run default (`ACTIVATE_ENABLED` absent = log only)
- [ ] Kill switch + daily cap
- [ ] Post-act reconciliation: re-read AlgoTest state, alert on divergence
- [ ] All locators in `packages/broker-login/src/selectors.ts` — single-file fix
      when AlgoTest redesigns

#### Phase 4 — Measure the signal *(the real prerequisite for live — runs in parallel)*
- [ ] T-51 backtest runner
- [ ] M4 retrospection engine (T-34–T-38, T-40–T-42)
- [ ] `realised-pnl.schema.json` contract emitted by `trade-analytics`
- [ ] Ingest realised P&L as a benchmark series alongside Clockwork
- [ ] **Gate:** do not proceed to Phase 5 until the signal shows a measured edge

#### Phase 5 — Approve-then-act
- [ ] Telegram card on signal → tap to approve → fire
- [ ] Reuse `sendTelegram` from `algo-automation/src/notify.ts`
- [ ] Log every approve/reject — this is a labelled dataset

#### Phase 6 — Live (gated)
- [ ] Answer Q4; wire broker session (see below)
- [ ] One strategy, minimum lots, daily cap
- [ ] Kill switch tested **before** first live fire
- [ ] Reconciliation: AlgoTest position vs our intent, every fire

#### Parallel track — repo hygiene (independent of all the above)
- [ ] Delete stray `yarn.lock` in this repo (violates our own Bun-only rule)
- [ ] Rename Shoonya/Finvasia to one name across repos
- [ ] `trade-analytics`: CJS → ESM
- [ ] Merge `algo-automation` + `trade-analytics` → `trading-ops` monorepo
- [ ] "Related Systems" block in each repo's `CLAUDE.md`

---

### 5. Broker login — scope

Two different logins. Do not conflate:

| | Mechanism | Owner | When |
|---|---|---|---|
| **A. AlgoTest platform login** | `POST /login`, HTTP | `algotest-client` (this repo) | every process start |
| **B. Broker OAuth (Shoonya / Angel One)** | Browser handshake on the broker's domain | `algo-automation` (Playwright) | daily, 08:35 IST, **live only** |

B stays in Playwright: Angel One requires an OAuth consent redirect against
AlgoTest's redirect URL, and Finvasia redirects to its own login page. Neither
exposes a headless path.

**Triggering a relogin from here does not require a monorepo.**
`daily-broker-login.yml` already has `workflow_dispatch`; add
`repository_dispatch` and fire it with one authenticated POST to the GitHub API.
Even in a shared repo, a Bun process cannot synchronously drive a Playwright
browser inside a GitHub Action — the trigger is an RPC either way.

---

### 6. Decision log

| Decision | Rationale |
|---|---|
| Use AlgoTest's API, not Playwright, for execution | Removes the entire selector-drift risk class; latency drops from minutes to ms |
| Keep `algo-automation` separate from this repo | Real-money trigger stays small and auditable; this repo holds Razorpay keys and ships to subscribers |
| Merge only `algo-automation` + `trade-analytics` | Same runtime, same brokers, same release model. `ai-trading-agent` is Bun + 15× the size |
| Paper-first, live behind an env var | `broker_id` is live-only, so paper costs nothing and risks nothing |
| Strategy config in our repo, not AlgoTest | The API takes the definition in-body anyway; version-controlled beats UI-defined |
| Don't go live before Phase 4 | Probability scores are not calibrated (`technical.md`); backtest runner isn't built |
| **Signals API declined** | ₹1,299/mo (₹4,999/6mo). TradingView Essential turned out *not* to be required — `ai-trading-agent` is the signal source, so TradingView never enters the flow. Cost still judged not worth it at this stage. Revisit if Playwright upkeep exceeds it. |
| **Playwright + Telegram approval gate** | Keeps a human in the loop while the signal is uncalibrated, and exercises the automation under supervision before it ever runs unattended |
| **Monorepo: `algo-automation` → `packages/broker-login`** | Owner's call. Isolation replaced in-repo: GitHub Environments with scoped secrets + required reviewers, CODEOWNERS on the package, path-filtered CI |


---

<a id="pending"></a>

## Pending actions

Everything currently waiting on **you** — things I cannot do from a session:
create secrets, click through a UI, read your Google Sheet, authorize a
connector, or verify a Routine is alive.

Nothing here is urgent today. Both daily crons are disabled in this repo and
`trade-analytics` still runs unchanged, so the existing pipeline is intact.

Last updated: 2026-09-19 (after the option-backtesting reconciliation)

---

### 0. Repo shape — read this first

Two monorepo restructures were reconciled onto the `option-backtesting` layout:

```
apps/server              @ata/server    — Fastify/Bun backend (was src/)
apps/dashboard           @ata/dashboard — React/Vite
packages/broker-login    Node 20 + Playwright   (was algo-automation)
packages/contract-notes  Node 20 + CJS + Jest   (was trade-analytics)
packages/option-backtesting  Python 3.12 + uv   (not a Bun workspace)
```

Local setup needs **four** toolchains: `bun`, `node@20`, `qpdf`
(contract-notes PDF decryption) and `uv` (the Python package).

---

### 1. Blocking — nothing in the monorepo runs until this is done

- [ ] **Create 15 repository secrets on `RahulSunnyCS/ai-trading-agent`.**
      They do not migrate with the code. Values are in each source repo's
      Settings → Secrets and variables → Actions.

      From `trade-analytics` (5):
      `BROKER_ACCOUNTS_JSON`, `GOOGLE_CREDENTIALS`, `GOOGLE_SHEET_ID`,
      `SHEET_GID`, `SHEET_NAME`

      From `algo-automation` (10):
      `ALGOTEST_PHONE`, `ALGOTEST_PASSWORD`, `ANGELONE_CLIENT_CODE`,
      `ANGELONE_MPIN`, `ANGELONE_TOTP_SECRET`, `SHOONYA_CLIENT_ID`,
      `SHOONYA_PASSWORD`, `SHOONYA_TOTP_SECRET`, `TELEGRAM_BOT_TOKEN`,
      `TELEGRAM_CHAT_ID`

- [ ] **Decide where the broker-login ten live.** Recommended: a GitHub
      **Environment** with required reviewers, not plain repository secrets.
      Merging the repos removed the boundary that used to keep broker
      credentials away from the Razorpay keys — an Environment restores it.

- [ ] **Authorize the AlgoTest MCP connector.** No longer optional:
      `packages/option-backtesting` ingests AlgoTest option bars *through MCP*,
      not a REST client — see its `DECISIONS.md`. Without it the nightly ingest
      cannot run. Authorize via claude.ai connector settings, or `/mcp` in an
      interactive session.

- [ ] **Check the nightly ingest Routine is still alive.** M-5 bound it to a
      specific session rather than fresh-per-fire, because this org cannot grant
      MCP connectors to fresh-session Routines. A session-bound Routine dies with
      its session. Verify it still fires, or rebind it.

---

### 2. contract-notes cutover

Full detail and rollback: [the runbook below](#runbook).
Ordered — step 3 is the one that can damage the sheet.

- [ ] **Merge `claude/stock-trading-monorepo-plan-k4zs5t` → `main` in
      `trade-analytics`.** Commit is pushed and waiting. Comments out its cron
      and keeps `workflow_dispatch` as the rollback.
- [ ] **Dispatch "Daily Trading Data Processing" here once** to reseed the
      `row-tracker` artifact (scoped to the old repo; does not migrate).
- [ ] **Check the row it wrote against the sheet** — right after the last real
      trading day, nothing overwritten, columns aligned to `sheetStartColumn`.
      With no artifact, `updateSheet.js` falls back to reading the sheet, and
      this is the only moment that fallback is unverified.
- [ ] **Uncomment `schedule:`** in `.github/workflows/contract-notes-daily.yml`
      and merge to `main`. Crons only fire from the default branch.
- [ ] **Watch one real overnight run** before calling it done.

---

### 3. broker-login cutover

- [ ] **One `workflow_dispatch` run of "Daily broker login"** inside the
      08:15–15:40 IST window. This is also the first live test that
      `setup-bun` works inside the Playwright container — it replaced `npm ci`
      and has not run for real yet.
- [ ] **Uncomment its `schedule:`** and merge to `main` once that passes.

---

### 4. Needed before I can build the Telegram approval gate

- [ ] **Your Telegram numeric user ID.** The gate verifies
      `callback_query.from.id` against it, so that only you can fire a trade —
      not merely anyone who can reach the chat. Get it from `@userinfobot`.
- [ ] **Confirm the bot can receive `callback_query`.** In `@BotFather`, the
      bot needs inline keyboard callbacks enabled (default for private chats).
- [ ] **Decide the expiry window** — how stale may a signal be before the
      button refuses it? Suggestion: 5 minutes.

---

### 5. Open decisions

- [ ] **CODEOWNERS on `packages/broker-login/`** so execution changes always
      get a review.
- [ ] **Archive `trade-analytics` and `algo-automation`** once both cutovers
      have run clean. Archive, do not delete — the old Actions artifacts and
      run history live there.

---

### 6. Parked

- [ ] **AlgoTest Q4 — is there a broker re-login endpoint?** Open DevTools →
      Network → Fetch/XHR, click "Re-login" on a broker card inside the login
      window. A redirect to the broker's domain means Playwright stays; an XHR
      to AlgoTest means the browser bot could eventually be deleted.

**Moot unless you revisit the Signals API** (₹1,299/mo — declined): Q2, the
`access_token` payload field, and Q3, the session lifetime. Both only matter
for the HTTP execution path. Q1 (base URL `https://api.algotest.in`) is
confirmed and recorded.

---

### Not waiting on you — my queue

- **Telegram approval gate** — blocked on §4
- **Playwright strategy activation** — read-back assertion before every click,
  dry-run default, kill switch, daily cap
- **Repo hygiene** — Shoonya/Finvasia under one name, "Related Systems" blocks
  in each `CLAUDE.md`

**Correction to earlier versions of this file:** the measurement layer is not
missing. `apps/server/src/backtesting/` (T-51), `apps/server/src/retrospection/`
(daily metrics, Brier scores, evolution engine), `jobs/eod-retrospection-job.ts`
and `packages/option-backtesting` (feature-complete through M-5) all exist.
What remains before live execution is **running the signals through them** —
probability scores are still not empirically calibrated, so the edge is
unmeasured rather than unmeasurable. T-58 is the genuine partial: the M-5 regime
work is bucketing for analysis, not a live strategy-DSL condition.


---

<a id="runbook"></a>

## Runbook — moving the contract-notes pipeline to the monorepo

The daily contract-note pipeline now exists in two places: the original
`trade-analytics` repo and `packages/contract-notes` here. Exactly one of them
may hold the schedule. Two live copies would process the same gap dates on the
same night, writing duplicate rows to the Google Sheet and advancing
`row_tracker.json` past dates that then become unreachable.

**Current state: safe.** The monorepo copy has its `schedule:` block commented
out, and it sits on a feature branch — GitHub only fires `schedule` triggers
from a repository's **default branch** (`main` here). `trade-analytics`
still owns the cron and keeps running unchanged.

---

### Prerequisite — recreate the secrets

**Repository secrets do not migrate.** Nothing below works until these exist on
`RahulSunnyCS/ai-trading-agent`. Values come from the corresponding repo's
Settings → Secrets and variables → Actions.

From **trade-analytics** (5) — needed by `contract-notes-daily.yml`:

```
BROKER_ACCOUNTS_JSON   GOOGLE_CREDENTIALS   GOOGLE_SHEET_ID
SHEET_GID              SHEET_NAME
```

From **algo-automation** (10) — needed by `daily-broker-login.yml`:

```
ALGOTEST_PHONE          ALGOTEST_PASSWORD
ANGELONE_CLIENT_CODE    ANGELONE_MPIN        ANGELONE_TOTP_SECRET
SHOONYA_CLIENT_ID       SHOONYA_PASSWORD     SHOONYA_TOTP_SECRET
TELEGRAM_BOT_TOKEN      TELEGRAM_CHAT_ID
```

Recommended: put the broker-login ten in a GitHub **Environment** with required
reviewers rather than plain repository secrets, so credentials that can move
real money are not in the same scope as everything else.

---

### Cutover

Do these in order. Steps 2 and 3 are the ones that touch the sheet.

- [ ] **1. Stop the old cron.** Merge the `claude/stock-trading-monorepo-plan-k4zs5t`
      branch of `trade-analytics` into its `main`. That branch comments out the
      schedule and leaves `workflow_dispatch` intact. Confirm on the Actions tab
      that "Daily Trading Data Processing" no longer shows a scheduled run.

      From here until step 4, **no copy is running on a schedule.** That is
      intentional and safe: `checkDates.js` detects missed dates and the next run
      backfills them. Do not leave it in this state for more than a few days.

- [ ] **2. Seed the row-tracker.** The `row-tracker` Actions artifact is scoped to
      `trade-analytics` and does **not** migrate. In this repo, run
      **Daily Trading Data Processing** via `workflow_dispatch` (it runs from any
      branch, so the feature branch is fine).

      With no artifact present, `updateSheet.js` falls back to reading the sheet
      for the next empty row. This is the one genuinely risky moment.

- [ ] **3. Verify before trusting it.** Open the run log and the sheet together:
      - Which row did it write? Is it the row immediately after the last real
        trading day, with no gap and nothing overwritten?
      - Do the per-account 5-column blocks line up with `sheetStartColumn` in
        `BROKER_ACCOUNTS_JSON`?
      - Did the run upload a fresh `row-tracker` artifact?

      If any answer is wrong, go to **Rollback** — do not proceed.

- [ ] **4. Re-enable the schedule here.** Uncomment the `schedule:` block in
      `.github/workflows/contract-notes-daily.yml`, then merge this branch into
      `main`. The cron will not fire until it is on the default branch.

- [ ] **5. Watch one real overnight run** before considering the migration done.

- [ ] **6. Only then** archive `trade-analytics` and `algo-automation`. Keep them
      archived, not deleted — the old Actions artifacts and run history live there.

---

### Rollback

The old pipeline is untouched and complete.

1. Uncomment the `schedule:` block in `trade-analytics/.github/workflows/daily-cron-job.yml` on `main`.
2. Keep the monorepo copy disabled.
3. If a bad row was written, fix the sheet by hand, then correct the tracker with
   the **Update Last Updated Row** workflow.

Note that `contract-notes-row-tracker.yml` **cannot bootstrap a missing artifact**
— it exits 1 when none exists. Step 2 is the only way to create the first one.

---

### Separately: the broker-login handover

`daily-broker-login.yml` arrived with its schedule already commented out, so
there is nothing to stop in `algo-automation`. Before enabling it here:

- [ ] Secrets in place (the ten above)
- [ ] One successful `workflow_dispatch` run inside the 08:15–15:40 IST window —
      this is also the first test that `setup-bun` works inside the Playwright
      container, which replaced `npm ci`
- [ ] Then uncomment its `schedule:` block and merge to `main`

