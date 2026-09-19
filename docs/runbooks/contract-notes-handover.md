# Runbook — moving the contract-notes pipeline to the monorepo

The daily contract-note pipeline now exists in two places: the original
`trade-analytics` repo and `packages/contract-notes` here. Exactly one of them
may hold the schedule. Two live copies would process the same gap dates on the
same night, writing duplicate rows to the Google Sheet and advancing
`row_tracker.json` past dates that then become unreachable.

**Current state: safe.** The monorepo copy has its `schedule:` block commented
out, and it sits on a feature branch — GitHub only fires `schedule` triggers
from a repository's **default branch** (`main-demo` here). `trade-analytics`
still owns the cron and keeps running unchanged.

---

## Prerequisite — recreate the secrets

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

## Cutover

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
      `main-demo`. The cron will not fire until it is on the default branch.

- [ ] **5. Watch one real overnight run** before considering the migration done.

- [ ] **6. Only then** archive `trade-analytics` and `algo-automation`. Keep them
      archived, not deleted — the old Actions artifacts and run history live there.

---

## Rollback

The old pipeline is untouched and complete.

1. Uncomment the `schedule:` block in `trade-analytics/.github/workflows/daily-cron-job.yml` on `main`.
2. Keep the monorepo copy disabled.
3. If a bad row was written, fix the sheet by hand, then correct the tracker with
   the **Update Last Updated Row** workflow.

Note that `contract-notes-row-tracker.yml` **cannot bootstrap a missing artifact**
— it exits 1 when none exists. Step 2 is the only way to create the first one.

---

## Separately: the broker-login handover

`daily-broker-login.yml` arrived with its schedule already commented out, so
there is nothing to stop in `algo-automation`. Before enabling it here:

- [ ] Secrets in place (the ten above)
- [ ] One successful `workflow_dispatch` run inside the 08:15–15:40 IST window —
      this is also the first test that `setup-bun` works inside the Playwright
      container, which replaced `npm ci`
- [ ] Then uncomment its `schedule:` block and merge to `main-demo`
