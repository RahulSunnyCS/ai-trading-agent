# Pending actions

Everything currently waiting on **you** — things I cannot do from a session:
create secrets, click through a UI, read your Google Sheet, authorize a
connector, or merge to a default branch.

Nothing here is urgent today. Both daily crons are disabled in this repo and
`trade-analytics` still runs unchanged, so the existing pipeline is intact.

Last updated: 2026-09-19

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
      Your call; say the word and I will wire the workflow to it.

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
      and merge to `main-demo`. Crons only fire from the default branch.
- [ ] **Watch one real overnight run** before calling it done.

---

## 3. broker-login cutover

- [ ] **One `workflow_dispatch` run of "Daily broker login"** inside the
      08:15–15:40 IST window. This is also the first live test that
      `setup-bun` works inside the Playwright container — it replaced `npm ci`
      and has not run for real yet.
- [ ] **Uncomment its `schedule:`** and merge to `main-demo` once that passes.

---

## 4. Needed before I can build the Telegram approval gate (Phase 2)

- [ ] **Your Telegram numeric user ID.** The gate verifies
      `callback_query.from.id` against it, so that only you can fire a trade —
      not merely anyone who can reach the chat. Get it from `@userinfobot`.
- [ ] **Confirm the bot can receive `callback_query`.** In `@BotFather`, the
      bot needs inline keyboard callbacks enabled (default for private chats).
- [ ] **Decide the expiry window** — how stale may a signal be before the
      button refuses it? A momentum-exhaustion entry approved 40 minutes late
      is a different trade. My suggestion: 5 minutes.

---

## 5. Open decisions

- [ ] **Root convenience scripts?** `test:all` / `typecheck:all` wrapping
      `bun run --filter '*'`, so one command covers all three packages. ~4
      lines, no new dependencies. (Turborepo/Nx stay rejected — no
      cross-package dependencies exist and CI runs in seconds.)
- [ ] **CODEOWNERS on `packages/broker-login/`** so execution changes always
      get a review.
- [ ] **Archive `trade-analytics` and `algo-automation`** once both cutovers
      have run clean. Archive, do not delete — the old Actions artifacts and
      run history live there.

---

## 6. Parked

- [ ] **Authorize the AlgoTest MCP connector** (also Notion, PostHog) via
      claude.ai connector settings or `/mcp` in an interactive session. Would
      let me query AlgoTest directly instead of inferring from the SDK.
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

- Phase 2: Telegram approval gate (needs §4 first)
- Phase 3: Playwright strategy activation, with read-back assertion and dry-run default
- Repo hygiene: Shoonya/Finvasia single name, "Related Systems" blocks in each `CLAUDE.md`
- Phase 4: backtest runner (T-51) and the M4 retrospection gaps — still the
  real prerequisite before anything trades live
