# Pending actions

Everything currently waiting on **you** — things I cannot do from a session:
create secrets, click through a UI, read your Google Sheet, authorize a
connector, or verify a Routine is alive.

Nothing here is urgent today. Both daily crons are disabled in this repo and
`trade-analytics` still runs unchanged, so the existing pipeline is intact.

Last updated: 2026-09-19 (after the option-backtesting reconciliation)

---

## 0. Repo shape — read this first

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

## 1. Blocking — nothing in the monorepo runs until this is done

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

## 2. contract-notes cutover

Full detail and rollback: [`runbooks/contract-notes-handover.md`](runbooks/contract-notes-handover.md).
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

## 3. broker-login cutover

- [ ] **One `workflow_dispatch` run of "Daily broker login"** inside the
      08:15–15:40 IST window. This is also the first live test that
      `setup-bun` works inside the Playwright container — it replaced `npm ci`
      and has not run for real yet.
- [ ] **Uncomment its `schedule:`** and merge to `main` once that passes.

---

## 4. Needed before I can build the Telegram approval gate

- [ ] **Your Telegram numeric user ID.** The gate verifies
      `callback_query.from.id` against it, so that only you can fire a trade —
      not merely anyone who can reach the chat. Get it from `@userinfobot`.
- [ ] **Confirm the bot can receive `callback_query`.** In `@BotFather`, the
      bot needs inline keyboard callbacks enabled (default for private chats).
- [ ] **Decide the expiry window** — how stale may a signal be before the
      button refuses it? Suggestion: 5 minutes.

---

## 5. Open decisions

- [ ] **CODEOWNERS on `packages/broker-login/`** so execution changes always
      get a review.
- [ ] **Archive `trade-analytics` and `algo-automation`** once both cutovers
      have run clean. Archive, do not delete — the old Actions artifacts and
      run history live there.

---

## 6. Parked

- [ ] **AlgoTest Q4 — is there a broker re-login endpoint?** Open DevTools →
      Network → Fetch/XHR, click "Re-login" on a broker card inside the login
      window. A redirect to the broker's domain means Playwright stays; an XHR
      to AlgoTest means the browser bot could eventually be deleted.

**Moot unless you revisit the Signals API** (₹1,299/mo — declined): Q2, the
`access_token` payload field, and Q3, the session lifetime. Both only matter
for the HTTP execution path. Q1 (base URL `https://api.algotest.in`) is
confirmed and recorded.

---

## Not waiting on you — my queue

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
