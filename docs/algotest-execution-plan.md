# AlgoTest Execution Integration — Plan

**Status:** Phase 0 complete. Signals API declined on cost — executing via
Playwright behind a Telegram approval gate. Monorepo merge done.
**Last updated:** 2026-09-19
**Scope:** Personal account only. Not a subscriber-facing product feature.

> Deliberately **not** at repo root as `TODO.md` — that path is reserved by
> `CLAUDE.md` as the generated mirror of `pipeline/tasks/`. This is a
> hand-maintained cross-repo roadmap, not a pipeline artifact.

---

## 1. Goal

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

## 2. Verified API contract (Phase 0 output — do not re-derive)

Source: official SDK, `Algo-Test/algotest-api-trading`, folder `signal-api-demo-1`.

### Auth — pure HTTP, no browser

Base URL: **`https://api.algotest.in`** (confirmed).

```
POST https://api.algotest.in/login
body:    { "phoneNumber": "+91XXXXXXXXXX", "password": "..." }
returns: cookies csrf_access_token, access_token_cookie
then:    header X-CSRF-TOKEN-ACCESS: <csrf>
         header Authorization:       <jwt>
```

### Execution
```
POST {base}/webhook/custom-position/execution/start/paper
POST {base}/webhook/custom-position/execution/start/live?broker_id={broker_id}
POST {base}/webhook/custom-position/execution/square-off/{position_id}
  → 200 returns position_id (or id). PERSIST IT — required to square off.
```

### Payload shape
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

### Confirmed facts that shape the design

| Fact | Consequence |
|---|---|
| **No idempotency / no dedupe server-side** | We own it. Persist command ID *before* send; refuse replays. A retried POST = duplicate position. |
| **No retry logic in SDK** | We own backoff. Never blind-retry a start call. |
| **No token refresh in SDK** | Long-running process must re-login on 401. |
| **`broker_id` is live-only** | **Paper needs no broker session at all** → shadow mode does not depend on the Playwright broker-login bot. |
| **`exit_time` is required** | Free EOD auto-square-off safety net. Always set it. |
| **Phone format differs from the UI** | API schema is `^\+91\d{10}$` — the **`+91` prefix is required**. The web form wants bare 10 digits, so `algo-automation`'s `normalizePhone()` (which strips `+91`) must NOT be reused here. Needs its own formatter. |

---

## 3. Open questions — blocking Phase 1

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

## 4. Phases

### Phase 0 — Verify ✅ DONE
- [x] Locate official API (Signals API, `Algo-Test/algotest-api-trading`)
- [x] Extract auth flow, endpoints, payload shape
- [x] Confirm idempotency absent → we own it
- [x] Confirm paper needs no `broker_id`
- [ ] Confirm Q1–Q3 from live docs *(in progress — user)*
- [ ] Authorize the AlgoTest MCP connector

### Phase 1 — Monorepo merge ✅ DONE
- [x] `git subtree` `algo-automation` → `packages/broker-login` (14 commits preserved)
- [x] `git subtree` `trade-analytics` → `packages/contract-notes` (47 commits preserved)
- [x] Bun workspaces; workflow moved to root `.github/workflows/`
- [x] Path-filtered CI + `broker-login-ci.yml` so the package still gets checked
- [x] Dropped `package-lock.json` and the stray root `yarn.lock`
- [x] `playwright` added to `trustedDependencies` (else Bun skips the browser postinstall)
- [x] Declared four dependencies that were imported but never listed — they had
      only ever resolved through hoisting: `fastify-plugin`, `ws` (root),
      `google-auth-library` (contract-notes), and `tsconfig` types `bun-types` → `bun`

#### Handover before either cron is enabled

Both daily workflows ship with their `schedule:` commented out, and GitHub only
fires schedules from the default branch (`main-demo`), so nothing runs twice
today. The cutover sequence, the 15 repository secrets that do **not** migrate,
and the rollback path are in
**[`docs/runbooks/contract-notes-handover.md`](../runbooks/contract-notes-handover.md)**.

#### Toolchain: bun pin verified ✅

CI pins bun `1.2.x`; the lockfile was generated with `1.3.11`. Tested directly
by installing 1.2.21 from npm and running CI's exact sequence:
`bun install --frozen-lockfile` succeeds, leaves `bun.lock` untouched (so
`git diff --exit-code bun.lock` passes), and typecheck, the 956 root unit tests
and the 113 contract-notes Jest tests all pass under it. **No pin change needed.**

Worth knowing: 1.2 hoists and 1.3 isolates, so the two produce different
`node_modules` layouts from the same lockfile. The repo works under both now
only because the four previously-undeclared dependencies were made explicit —
under 1.2's hoisting they would still be silently resolving by accident.

### Phase 2 — Telegram approval gate  ← NEXT
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

### Phase 3 — Playwright strategy activation
- [ ] Add `repository_dispatch` trigger to a new `activate-strategy.yml`
- [ ] **Read-back assertion**: scrape strategy name + params from the DOM and
      assert they match the command *before* clicking. Never click on position alone.
- [ ] Dry-run default (`ACTIVATE_ENABLED` absent = log only)
- [ ] Kill switch + daily cap
- [ ] Post-act reconciliation: re-read AlgoTest state, alert on divergence
- [ ] All locators in `packages/broker-login/src/selectors.ts` — single-file fix
      when AlgoTest redesigns

### Phase 4 — Measure the signal *(the real prerequisite for live — runs in parallel)*
- [ ] T-51 backtest runner
- [ ] M4 retrospection engine (T-34–T-38, T-40–T-42)
- [ ] `realised-pnl.schema.json` contract emitted by `trade-analytics`
- [ ] Ingest realised P&L as a benchmark series alongside Clockwork
- [ ] **Gate:** do not proceed to Phase 5 until the signal shows a measured edge

### Phase 5 — Approve-then-act
- [ ] Telegram card on signal → tap to approve → fire
- [ ] Reuse `sendTelegram` from `algo-automation/src/notify.ts`
- [ ] Log every approve/reject — this is a labelled dataset

### Phase 6 — Live (gated)
- [ ] Answer Q4; wire broker session (see below)
- [ ] One strategy, minimum lots, daily cap
- [ ] Kill switch tested **before** first live fire
- [ ] Reconciliation: AlgoTest position vs our intent, every fire

### Parallel track — repo hygiene (independent of all the above)
- [ ] Delete stray `yarn.lock` in this repo (violates our own Bun-only rule)
- [ ] Rename Shoonya/Finvasia to one name across repos
- [ ] `trade-analytics`: CJS → ESM
- [ ] Merge `algo-automation` + `trade-analytics` → `trading-ops` monorepo
- [ ] "Related Systems" block in each repo's `CLAUDE.md`

---

## 5. Broker login — scope

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

## 6. Decision log

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
