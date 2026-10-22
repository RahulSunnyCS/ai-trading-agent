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
| **B. Broker OAuth (Finvasia / Angel One)** | Browser handshake on the broker's domain | `algo-automation` (Playwright) | daily, 08:15 IST, **live only** |

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

### 7. Saved strategies and live deploys through the website (BL-137 / BL-138, 2026-10-19)

AlgoTest support confirmed by phone (2026-10-19) that automating one's own account through the website is
fine. Everything below was read off the site at desktop width (1440 x 900); below about 500 px the site switches
to a phone layout with no "Save Strategy" button.

**Import and save (`/backtest`).** "Import .algtst" is a hidden `<input type=file accept=".algtst,.json">`;
setting a file fills the builder ("Strategy imported successfully") and nothing is saved. The name comes from
the file's `name`. "Save Strategy" (bottom bar) opens "Save New Strategy" with that name filled in; "Done"
saves it through `api.algotest.in/strategy` ("Strategy Saved"), and the bar then shows Update / Save As New.
"Export .algtst" downloads the saved strategy. The saved list is Saved Strategies › MY STRATEGIES (its ⋮ menu:
Add to folder, Delete); the page itself reads it from `GET api.algotest.in/strategies`, an array of
`{_id, name, folder, archived, template}`.

**Delete (2026-10-20).** The web app deletes with `DELETE api.algotest.in/strategy/<_id>` (its bundle:
`SP.delete("/strategy/" + id)`). Its API client sends the session cookies (`withCredentials`) and the CSRF
header `X-CSRF-TOKEN-ACCESS`, copied from the `csrf_access_token` cookie. Strategies saved outside a folder
(`folder: null`, every one the uploader saves) are not listed in the sidebar at all, so the uploader never
clicks: it makes that call for the `_id` it recorded at upload, then lists again (`strategy-delete.ts`).
`GET /strategies` without the CSRF header answers 401 "Missing CSRF token".

**Live (`/live`, "Algo Trade").** Header: "Broker Login n/m", "n/6 Strategy Deployed" (6 at once on the
owner's plan), Auto Activation, Auto restart paused executions. Deploys are allowed only **08:00–15:40 IST**
("Strategies can only be deployed during 08:00 IST to 15:40 IST"). Two sections:

- **Activation:** one row per saved strategy: status ("Setup Pending" → "Ready to deploy"), "n Deployed", the
  execution days (M–Su, "-" when none), and the buttons "Setup Execution" (then "Edit Execution") and
  "Activate".
- **Deployed Strategies:** one card per deploy: "Deployed on 19 OCT 26 · Intraday · <name> · NIFTY ·
  Open Pos: n · RUNNING · ₹ MTM · <broker - account>", with Switch to manual / Square Off / View Trades; the
  section has "Switch all to manual" and "Square off all". Filters: Running, Paused, Sq Off, Error, Manual.

**Setup Execution** opens a sheet "Edit execution for <name>":

| Field | Seen (default) |
|---|---|
| Notice | limit and SL-limit orders are watched for 50 s; still open → cancelled and the strategy marked Error |
| Notice | for MIS orders the exit time must be strictly before 15:24; the rotation exits at 15:28, so NRML |
| Quantity Multiplier | 1 |
| Auto Sq Off on Margin Error | on |
| Trade monitoring | on LTP / **on Candle Close** |
| Strategy execution time | the strategy's entry time (11:37:00 for the owner's Widesl file) |
| Per leg (Leg 1, Leg 2, "Copy To Legs") | NRML/MIS **NRML**; Tgt/SL ref price Traded/**Trigger**; delay entry 0 s; entry and exit order type **Limit**/MPP; buffer type **Points**/%; trigger buffer 0; limit buffer 3; monitoring **Continuous**/Delayed, frequency 5 s |
| Execution days | Weekdays / DTE; M T W Th F Sa Su, **none ticked** |
| Buttons | Cancel · "Setup Execution Settings" |

**Read-only calls the /live and /broker pages make (BL-143, seen 2026-10-20 15:13 IST; GETs only, with the
session cookies and the CSRF header).** The trade monitor (`packages/broker-login/src/trade-monitor.ts`) uses
the first two:

| Call | What it answers |
|---|---|
| `GET /brokers` | one entry per linked broker: `broker` (`Broker.Finvasia`, `Broker.AngelOne`), `logged_until` and `margin: {available, updated_ts}` (UTC, no zone: `02:47` = the 08:17 IST broker login). The funds are read at AlgoTest's broker login, not live. The entry also carries `app_keys`; the monitor never reads or logs them |
| `GET /executable-strategies?page=&page_size=&weekday=tuesday` | the Activation rows, each with `multiplier` (the Quantity Multiplier) and `weekdays` |
| `GET /execution/v2/executions?environment=live` | today's deploys (`[]` with none) |

/live's "Total MTM" (and each broker's) is **computed in the page** from the executions and live prices (its
bundle, chunk `2331-*.js`, `overallMTM`), not answered by an API, so the monitor reads the figure off the open
page: the card `[data-testid="broker-mtm"]` whose first line is "Total MTM" (one per broker beside it, labelled
with the broker's alias), its figure a `p.tabular-nums` coloured `text-green-500` when >= 0 and `text-red-500`
when < 0 (a loading-dots element while it computes). Read live 2026-10-20 16:13 IST: `₹ 0`, green. The header also shows "Available Margin" and "Margin Blocked (approx)".

The owner's first live deploy (2026-10-19, `T1 · N_p150-t1s11_0917` on Finvasia) left the days unticked, and the
row shows "-" for every day: **a deploy with no days ticked runs that day only**. Not yet seen: what "Activate"
asks (broker or account choice, a confirmation), and what stopping a deploy before its entry looks like.

**Square off, stop, list (BL-143 Phase 4; read from the /live page's public JavaScript, 2026-10-20).** The page's
chunks (`algotest.in/_next/static/chunks/*.js`, fetched with curl, no login) hold the `/execution` client the
cards' buttons call, on `api.algotest.in` with the same cookies and `X-CSRF-TOKEN-ACCESS` header as the delete:

| Call | In the app | Answer |
|---|---|---|
| `GET /execution/v2/executions?environment=live` | the Deployed Strategies list | an array of executions: `_id`, `name` (the strategy's), `status`, `active_on_server`, … |
| `PUT /execution/v2/square-off/<execution _id>`, no body | a card's **Square Off** ("Are you sure you want to square off this strategy?"); squaring off a selection calls it once per execution | `{msg}`, shown as a toast; the card turns `pending_square_off` |
| `PUT /execution/v2/stop/<execution _id>`, no body | **Cancel Deployment** (before the entry time) and **Switch to manual** (after it: the legs stay open and unmanaged) | `{msg}` |
| `PUT /execution/v2/square-off-all`, body `{execution_type: "live", broker_ids, executions?, portfolio?, signal_execution}` | the section's "Square off all" bulk path | `{msg}` |

Statuses: `StrategyStatus.Live`, `StrategyStatus.Error`, `StrategyStatus.SquaredOff`, `StrategyStatus.Stopped`,
`paused`. The app offers Square Off only when the status is Live or Error **and** `active_on_server` (its
`canSquareOff`); otherwise it offers Restart. The stop button (`packages/broker-login/src/stop-button.ts`) uses
only the list and the per-execution square-off, for the tool's executions (by the uploader's strategy id, a name it
saved, or the `T1 · ` / `Core · ` prefix); never `stop` (switching to manual would leave positions open) and never
the bulk call. It waits while a card shows `pending_square_off` and never calls that "square off by hand"; a
`Stopped` deploy is reported for a check (its legs may be open). Not sent yet: the first is the owner's.

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

**Current state: safe, but on one safeguard instead of two.** The monorepo
copy has its `schedule:` block commented out. It used to *also* sit on a
non-default branch, and GitHub only fires `schedule` triggers from a
repository's default branch — but as of 2026-09-20 everything lives on
`main`, so that second layer is gone. The commented-out `schedule:` is now
the only thing preventing two live copies. `trade-analytics` still owns the
cron and keeps running unchanged.

**Consequence:** uncommenting `schedule:` here takes effect immediately, with
no merge step standing between the edit and a live cron. Do not uncomment it
until the step that says to.

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
**Daily Trading Data Processing** via `workflow_dispatch`.

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
`.github/workflows/contract-notes-daily.yml` and push to `main`. It is live
from that moment — there is no longer a branch boundary in between, so do
this only once step 3 has checked out.

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
3. Then uncomment its `schedule:` block and push to `main`. It goes live
   immediately on push — `main` is the default branch and the only branch.

**Done 2026-09-28.** Run `36373883041` (Mon, 09:06 IST) logged in both brokers;
the schedule (08:15 IST weekdays + 08:45 backstop) went live with the same
change. Getting there needed two container fixes in the workflow — `unzip` for
`setup-bun`, and a global `safe.directory` so the root `prepare` script's
`lefthook install` can run as root.

Tracked in [`/TODO.md`](../TODO.md) → Priority 1.


## Quantiply algos through its API (BL-139, captured 2026-10-19)

Captured from the web app in a browser while the owner saved, opened and deleted algos by hand. The
recorder kept header names only, never values. Fixtures, with the user and broker ids removed:
`packages/option-backtesting/tests/fixtures/quantiply/`.

**Host and auth.** `https://api-prod.quantiply.angelone.in`. Every call sends an `authorization`
header with a JWT. The web app keeps the JWT in `localStorage["quantiply-dashboard-local"].token`
after the Angel One login (`src/quantiply.ts`). The JWT seen was valid for 9 hours from login
(claims `_id, name, clientId, familyContext, iat, exp`). The JWT is a live credential to the owner's
algos: never log it, store it in a file or put it in a fixture.

**Calls seen**

| Call | What it does |
|---|---|
| `GET /algos/config` | days, expiry tags per underlying and weekday, lot sizes (NIFTY 65, SENSEX 20 on 2026-10-19) |
| `GET /algos/day-wise` | the list: one entry per weekday (`MON`…`SUN`, `ELSE`) with `active` and `algos` (summaries: `_id`, `name`, `day`, `enabled`, `status` such as `NOT_RUNNING` or `TRADE_CLOSED`; no configuration) |
| `GET /algos/:id` | one algo, full `configurations` (the read-back) |
| `POST /algos` | create: body `{code, name, day: [..], configurations}`. Answers 201 with `data`: **one algo per weekday in `day`**, each `enabled: false`, with the server defaults filled in |
| `DELETE /algos/:id` | delete one algo (one weekday's copy): `{"message":"Deleted successfully"}` |

The header is `authorization: Bearer <JWT>` (the web app's API client sets it so). In the app's
code but not yet seen: `DELETE /algos/bulk/action/delete` with `{algoIds}`, `/algos/bulk/action/{clone,
edit,mtm-edit,TERMINATE,SQ_OFF_TERMINATE}`, `/algos/clone`, `/algos/types`.

**Enable, disable, broker (BL-139 Phase 4; read from the web app's own JavaScript, 2026-10-20).** The
public bundle (`app.quantiply.angelone.in/static/js/main.c34824e5.js`; Shoonya's
`quantiply.shoonya.com/static/js/main.b6ba1293.js` has the same calls, against
`api-prod.quantiply.shoonya.com`) was fetched with curl, no login. An algo is deployed for its
weekday, **every week**, while `enabled` is true.

| Call | In the app | How the app reads the answer |
|---|---|---|
| `PUT /algos/:id/enable`, `PUT /algos/:id/disable`, **no body** | `toggleAlgo(id, "enable"\|"disable")`, the switch on each algo row; no confirmation, no other call around it | done when the JSON's `status` is `"success"`; it then sets that row's `enabled` locally and shows "Algo enabled successfully". An HTTP error's `message` is shown |
| `PUT /algos/bulk/action/enable`, `.../disable`, body `{algoIds: [..]}` | `bulkActionEnable` / `bulkActionDisable`, the bulk bar | `data` is one entry per id, `{id, success, message}`; `success: false` ones are reported "Error occured in n algos" |
| `PUT /algos/:id`, body `{broker: <broker account id>}` | `updateBroker`, the "Select Client ID / Broker" menu; read-only once a broker is set | `data` is the updated algo |
| `GET /brokers` | the menu's options: each account's `id` (the value sent as `broker`), `clientId`, `status` (`"disabled"` greyed) | |

**Square off & terminate (BL-143 Phase 4; same bundles, read 2026-10-20).** Both web apps (Angel One's
`main.c34824e5.js`, Shoonya's `main.b6ba1293.js`) have the same calls:

| Call | In the app |
|---|---|
| `PUT /algos/:id/action/SQ_OFF_TERMINATE`, no body | `sqOffAll(id)`: the row's "Square off all positions & Terminate algo" icon, after a confirm dialog. Shown only while the algo's `status` is `TRADE_ACTIVE`. The app does not read the answer (no error = done) |
| `PUT /algos/:id/action/TERMINATE`, no body | `terminate(id)`: "Terminate algo" (positions left open), same row |
| `PUT /algos/bulk/action/SQ_OFF_TERMINATE`, body `{algoIds}` | `bulkActionSquareOffTerminate` |
| `PUT /algos/broker/:brokerId/action/SQ_OFF_TERMINATE` | `clientWiseSqOffTerminate`: every algo of one broker account, the owner's own included |
| `PUT /algos/:id/positions/:positions/action/SQ_OFF_POSITION` | `exitSelectedLegs` |

Statuses seen in the app: `NOT_RUNNING`, `READY`, `TRADE_ACTIVE`, `TRADE_CLOSED`. The stop button squares off and
terminates the tool's `TRADE_ACTIVE` algos one id at a time (never the account-wide call: it would close the
owner's own algos too) and switches off its enabled ones; it confirms by listing again. Not sent yet.

The deployer (`packages/broker-login/src/quantiply-deploy.ts`) uses the per-algo switch, one id at a
time, so each answer belongs to one algo, and the broker call for an algo the upload left without
one (its account is the `GET /brokers` entry whose `clientId` is the `.env` login). None of these
has been sent yet: the first `--apply` is the owner's.

The uploader (`packages/broker-login/src/quantiply-upload.ts`) logs in through Angel One in a
browser, takes this token, closes the browser and uses `GET /algos/day-wise`, `POST /algos`,
`GET /algos/:id` (the read-back) and `DELETE /algos/:id`.

**Live MTM (BL-143; read from the bundle 2026-10-20).** `GET /algos/day-wise` gives each algo's `multiplier`,
`status` and broker, but no MTM. The app's MTM column (`pnl`) comes over its socket.io connection
(`wss-prod.quantiply.angelone.in`): one CSV string per algo update, `<algo id>,,,,<pnl>,<error flags>,,<waiting>,<waitingWT>`
(the SUBSCRIBE_LITE_POSITION_UPDATES reducer splits it on commas). The trade monitor keeps the app open on
/algos and reads those frames as they arrive (`pnlFromSocketFrame`); it sends nothing on the socket. Not yet
seen with an algo running: no algo of the owner's traded on 2026-10-20. The app also has `GET /pnl-chart/algo`
(`graphLevel=account|broker|algo`, `from`, `to`), not used.

**Body: `code: "OPTIONS_SPREADS_LEGS"`, `configurations`**

| YAML (legwise) | Quantiply |
|---|---|
| `entry_time` / `exit_time` | `startTime` / `endTime` `"HH:MM:SS"` |
| `square_off: partial` | `legsAction: "SQ_OFF_LEG"` |
| `overall.stop_loss_inr: N` | `stoploss: {type: "TOTAL_AMOUNT", value: -N, action: "SQ_OFF_ALL"}` |
| leg `position: sell / buy` | `transactionType: "S" / "B"` |
| leg `option_type` | `side: "CE" / "PE"` |
| leg `expiry: weekly` | `expiryTag: "CURRENT_WEEK"` |
| leg `lots: n` | `quantity: n` (lots); the algo's `configurations.multiplier` is not in the export or the web app's own create request (Quantiply saves `1`); BL-140 Phase 4: the uploader adds it at the account row's 2-10 value (`quantiply-plan.ts` `withMultiplier`), and the read-back (`readBackDiffs`) shows whether Quantiply saved it; **never tried live above 1** |
| `strike_type: ATM / ITMn / OTMn` | `selectionType: "STRIKE"`, `strike: "ATM" / "ITM_n" / "OTM_n"` |
| `closest_premium: P` | `selectionType: "PREMIUM"`, `premium: {type: "PREMIUM_CLOSE_TO", value: P, specificStrikeSelection: false}` |
| `stop_loss: {percent: p}` | `stoploss: {type: "PER_POSITION_PERCENT", value: -p}` |
| `stop_loss: {points: p}` | `stoploss: {type: "PER_POSITION_POINT", value: -p}` |
| `trail_sl: {percent: [x, y]}` | `trailingStoploss: {type: "PER_POSITION_PERCENT", moveBy: x, trailBy: y}` |
| `trail_sl: {points: [x, y]}` | `trailingStoploss: {type: "PER_POSITION_POINT", moveBy: x, trailBy: y}`, beside a percent stop (the owner's `test1`, saved 2026-10-19) |
| `reentry_on_sl: {mode: cost, count: n}` | `isReEntryEnabled: true`, leg `reEntry: {type: "RE_ENTRY_COST", repeat: n}` |
| `range_breakout: {until: T, side: high/low, source: instrument}` | `isORBEnabled: true`, `orbEndTime: T`, leg `orb: {type: "ORB_INSTRUMENT", entryAt: "HIGH"/"LOW"}`; the range starts at `startTime` |

Execution settings with no YAML counterpart, as on the owner's own algos (N_ITM1_SL21_3000):
`product: "D"`, limit orders (`entryOrderType: "L"`, buffer `FIXED_VALUE` 3, timeouts 5 / 4 s),
SL limit buffer 1, `stoplossOrderPlacement: "LATER"`, exit delay 3 s, `errorAutoSquareOff: true`.
The algo the owner built for the capture used market orders (`"M"`) instead.

<a id="live-results"></a>

## Live results: per-strategy P&L and fills (BL-141, read 2026-10-20)

Found in both web apps' public JavaScript (fetched with curl, no login), then confirmed with a few
GET calls after a real login (2026-10-20, a market holiday, reading Monday 2026-10-19). Nothing
but GET was sent. Fixtures, every id replaced: `packages/option-backtesting/tests/fixtures/live/`.
`packages/broker-login/src/live-capture.ts` (the 15:40 `live-capture` job) makes these calls;
`live-capture-plan.ts` parses them.

**AlgoTest** (`api.algotest.in`; the site login, session cookies + `X-CSRF-TOKEN-ACCESS` from
`csrf_access_token`, as for §7). The app's API client (`SP`, `withCredentials`, the CSRF header) has
a second base for orders, `orders.algotest.in` (`fw`), and a third for prices.

| Call | What it answers |
|---|---|
| `GET /execution/v2/executions?environment=live&is_signal=false` | the /live "Deployed Strategies" cards: an array of executions (today's, until the day is over; `[]` on the holiday) |
| `GET /execution/v2/exited-executions?start_date=YYYY-MM-DDT00:00&end_date=YYYY-MM-DDT23:59&environment=live&is_signal=false` | past trades for the range (the page sends the day's minute 0 and 1439, IST; its UI allows only days before today and 7 days back). The same execution shape |
| `GET /execution/v2/execution-info/<execution _id>` | one execution with its settings: `config.ExecutionConfig.LotMultiplier` (the Quantity Multiplier), `LegsConfig` (order types, buffers, product), plus `trades`, `ongoing_trade`, `notifications` |
| `GET /execution/v2/execution-strategy/<execution _id>` | the strategy as deployed (legs, entry and exit indicators) |
| `GET orders.algotest.in/today-orders`, `/data/monitored-orders-and-trades`, `/data/orders-and-trades?user_tags=…` | the order book (`[]` on the holiday); `manual-trades` rows. Not used |

An execution: `_id`, `name` = the saved strategy's name plus ` (n)` (the n-th deploy of it),
`strategy_id` = the saved strategy's `_id` (what the uploader's ledger records), `broker_type`
(`Broker.Finvasia`, `Broker.AngelOne`), `status` (`StrategyStatus.SquaredOff`, `Stopped`, …),
`creation_ts` / `last_activation_ts` / `entry_time` / `exit_time` (IST, no zone), and `legs`: one
per leg and re-entry, `{id, symbol, strike, option, lot_size, quantity, position:
PositionType.Sell|Buy, status (2 = exited), entry_trade, exit_trade, last_saw_price}`, each trade
`{price, quantity, exchange_timestamp, traded_timestamp, trigger_price, underlying_at_trade}`,
quantity in units (65 = one NIFTY lot). A leg that never entered has `entry_trade: null`. There is
no P&L field: the app sums it from the legs (its `XT`), sell = (entry − exit) × quantity, buy the
other way, and that is what the capture records (the 2026-10-19 read is in the BL-141 Log).

**Quantiply** (`api-prod.quantiply.angelone.in`, the uploader's JWT; the same paths on
`api-prod.quantiply.shoonya.com`, not read yet).

| Call | What it answers |
|---|---|
| `GET /pnl-chart/algo?graphLevel=account&from=D&to=D[&after=…]` | the P&L chart: `data` = minute candles `"epoch ms,open,high,low,close"` of the account's MTM; `metaData.totalMTM`, `minMTM`/`maxMTM` (+`At`), and **`lastValues`: one entry per algo run of the period, `{algo: <algo id>, state: <run id>, t, o, h, l, c}`, `c` its closing MTM**. `paging.after` pages. On 2026-10-19 the six `c` added up to `totalMTM` to the paisa |
| `GET /pnl-chart/algo?graphLevel=algo&from=&to=&algoIds[]=…` | the same per algo; answered an error for the ids tried, so not used |
| `GET /pnl-chart/algo?graphLevel=broker&broker=…` and `/pnl-chart/underlying?underlyingName=…` | per client id, per underlying. Not used |
| `GET /algos/day-wise` | names, `multiplier`, `status`, `broker`, `brokerDisplayName`, `brokerClientId` per algo (no `pnl` field once the day's state is reset) |
| `GET /algos/:id` | the algo; `state` is `null` after the overnight reset. While the day's state is there, the web app reads the positions from `state.positions` (a socket.io message `position_updates`, its reducer), shape not seen yet |

**Back-fill and repeated runs (read 2026-10-20, GET only).** Both platforms keep a day's results
after its strategies are deleted: Quantiply's account chart for 13 and 14 Oct still gave every
run of algos that are no longer listed (2 and 3 of them), and they added up to `totalMTM`; AlgoTest's
exited list keeps past deploys (12 to 19 Oct read). A `lastValues` key is the run id (`state`), and an
algo can run twice in a day (15 Oct: 6 runs of 5 algos), so the day's P&L is the sum of its runs.
`exited-executions` for today answers 200 with the day's exited ones (`[]` on the holiday), not an
error. So the capture never needs to hold the evening deletes: a missed day is read later
(`live-capture.ts --day D`, or the next evening's back-fill).

**Deploys that span days.** A /live deploy with execution days ticked keeps one execution across
days, its `legs` growing day by day; the capture counts only the legs whose `entry_trade` is on the
day read.

**What is not seen.** Only the platform + broker rows the automation settings have on (login or
upload) are read; a discretionary trade on an account whose row is off is not captured (turn its
login on, or read it with `--only` after switching it on).

The order book is `POST algos/order-book {brokers}` and the trade report `POST
/reports/download/trade-report` (a blob): both are POSTs, so the capture does not call them. Fills on
Quantiply are therefore read only from `GET /algos/:id`'s `state.positions` on the day, and only
when its fields are plain (`transactionType`, `quantity`, `entryPrice`, `exitPrice`); otherwise
`fills: null`. Slippage % needs fills, so it is AlgoTest-only until a traded day shows that shape.
