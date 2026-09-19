# AlgoTest execution loop

Everything about the in-flight work to close the loop: a signal from this agent
triggers a real strategy on AlgoTest, and the resulting contract note comes back
as realised P&L to measure the signal against.

Three documents used to cover this — the plan, the owner's action list and the
cutover runbook. They were always read together, so they are one file now.

- [Plan, API contract and decision log](#plan)
- [Pending actions → moved to /TODO.md](#pending)
- [Runbook — contract-notes cutover](#runbook)

---

<a id="plan"></a>

## AlgoTest Execution Integration — Plan

**Status:** Phase 0 complete. Signals API declined on cost — executing via
Playwright behind a Telegram approval gate. Monorepo merge done.
**Last updated:** 2026-09-19
**Scope:** Personal account only. Not a subscriber-facing product feature.

> **This file is reference, not a task list.** Every open work item —
> including everything blocked on the repo owner — lives in
> [`/TODO.md`](../TODO.md), the single source of truth. What remains here is
> the knowledge that would be expensive to re-derive: the verified API
> contract, the decision log, and the cutover runbook.

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

### 3. Open questions — AlgoTest API

- **Q1 (answered) — Base URL: `https://api.algotest.in`** ✅ CONFIRMED 2026-09-19.
`POST /login` returned HTTP 400 with an AlgoTest `application-user-id`
header and a schema error naming the `phoneNumber` field — i.e. the
request reached their application layer and matched the SDK's contract.
- **Q2 (open) — `access_token` in the payload body.** A *second* credential,
separate from the login cookies. Demo sets it to the literal `"anything"`.
Hypothesis: it is the **webhook secret** issued when you create a Signal /
alert in AlgoTest's Signals UI (endpoints are `/webhook/...`, payload has
`alert_name` — TradingView-alert shaped). Confirm before live.
- **Q3 (open) — Session lifetime** of the JWT cookie. Determines re-login strategy.
- **Q4 (open, tracked in [`/TODO.md`](../TODO.md) §3.4.1) — Broker re-login endpoint.** Does AlgoTest expose one? If yes, the
Playwright bot can be deleted entirely. Not needed before Phase 5.

---

### 4. Phases

**Open work items for every phase now live in [`/TODO.md`](../TODO.md).**
This section used to carry the phase checklists; they were split across three
documents and drifted. The phase *shape* is unchanged and is summarised here
for context only — status is not tracked in this file.

| Phase | What it is | Where it is tracked |
|---|---|---|
| 0 — Verify | Locate the API, extract auth/endpoints/payload, confirm no idempotency | Done; output is §2 above |
| 1 — Monorepo merge | `git subtree` both repos in, Bun workspaces, path-filtered CI | Done; see `.claude/project/overview.md` |
| 2 — Telegram approval gate | Signal → inline-keyboard card → verified tap → `repository_dispatch` | TODO.md §3.1 (task contracts T-70…T-76) |
| 3 — Playwright activation | `activate-strategy.yml`, read-back assertion, dry-run default, kill switch | TODO.md §3.2 |
| 4 — Measure the signal | Calibration, realised-vs-paper reconciliation. **Gates phase 5.** | TODO.md §3.3 |
| 5 — Approve-then-act | The same loop, pointed at a signal that has shown an edge | TODO.md §3.3–3.4 |
| 6 — Live (gated) | One strategy, minimum lots, daily cap, kill switch tested first | TODO.md §3.4 |

---

### 5. Broker login — scope

Two different logins. Do not conflate:

| | Mechanism | Owner | When |
|---|---|---|---|
| **A. AlgoTest platform login** | `POST /login`, HTTP | `algotest-client` (this repo) | every process start |
| **B. Broker OAuth (Finvasia / Angel One)** | Browser handshake on the broker's domain | `algo-automation` (Playwright) | daily, 08:35 IST, **live only** |

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

## Pending actions → moved

**Everything blocked on the repo owner now lives in [`/TODO.md`](../TODO.md)**,
ordered by priority and marked `owner` / `claude` per item. It is not
duplicated here.

What stayed in this file, because it is reference rather than a task:
the verified API contract (§2), the open API questions (§3), the broker-login
scope distinction (§5), the decision log (§6), and the cutover runbook below.

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
Progress is tracked in [`/TODO.md`](../TODO.md) → Priority 2, not here — this
is the *procedure*, not the checklist.

**1. Stop the old cron.** Merge the `claude/stock-trading-monorepo-plan-k4zs5t`
branch of `trade-analytics` into its `main`. That branch comments out the
schedule and leaves `workflow_dispatch` intact. Confirm on the Actions tab
that "Daily Trading Data Processing" no longer shows a scheduled run.

From here until step 4, **no copy is running on a schedule.** That is
intentional and safe: `checkDates.js` detects missed dates and the next run
backfills them. Do not leave it in this state for more than a few days.

**2. Seed the row-tracker.** The `row-tracker` Actions artifact is scoped to
`trade-analytics` and does **not** migrate. In this repo, run
**Daily Trading Data Processing** via `workflow_dispatch` (it runs from any
branch, so the feature branch is fine).

With no artifact present, `updateSheet.js` falls back to reading the sheet
for the next empty row. This is the one genuinely risky moment.

**3. Verify before trusting it.** Open the run log and the sheet together:
- Which row did it write? Is it the row immediately after the last real
  trading day, with no gap and nothing overwritten?
- Do the per-account 5-column blocks line up with `sheetStartColumn` in
  `BROKER_ACCOUNTS_JSON`?
- Did the run upload a fresh `row-tracker` artifact?

If any answer is wrong, go to **Rollback** — do not proceed.

**4. Re-enable the schedule here.** Uncomment the `schedule:` block in
`.github/workflows/contract-notes-daily.yml`, then merge this branch into
`main`. The cron will not fire until it is on the default branch.

**5. Watch one real overnight run** before considering the migration done.

**6. Only then** archive `trade-analytics` and `algo-automation`. Keep them
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

1. Secrets in place (the ten above).
2. One successful `workflow_dispatch` run inside the 08:15–15:40 IST window —
   this is also the first test that `setup-bun` works inside the Playwright
   container, which replaced `npm ci`.
3. Then uncomment its `schedule:` block and merge to `main`.

Tracked in [`/TODO.md`](../TODO.md) → Priority 1.

