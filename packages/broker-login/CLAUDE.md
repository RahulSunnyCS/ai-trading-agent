# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

## Related Systems

This package was merged into the `ai-trading-agent` monorepo from the
standalone `RahulSunnyCS/algo-automation` repo via `git subtree` (history
preserved) on 2026-09-19. The merge is not yet a cutover:

- **`algo-automation` (standalone repo)** has no daily cron itself (the
  workflow that runs this daily is `.github/workflows/daily-broker-login.yml`
  in whichever repo is live) — check that repo directly for its current
  schedule state before assuming this package's disabled schedule is the
  only one.
- **This package** (`packages/broker-login`) is where new work lands. Its
  daily workflow (`.github/workflows/daily-broker-login.yml` at this
  monorepo's root) is live. Since 2026-10-05 the owner's laptop starts it at
  08:00 IST trading days via `src/dispatch.ts` (`apps/scheduler`, BL-012), because the
  workflow's own cron
  arrived hours late; that cron is now only a backstop.

Its sibling package in this monorepo is `packages/contract-notes` (merged
from the standalone `trade-analytics` repo the same way, same cutover
status) — see that package's own `CLAUDE.md`.

For the deep technical context (architecture, TOTP conventions, testing,
gotchas) see the monorepo root's `.claude/project/technical.md` — this file
stays a short orientation pointer rather than duplicating that.

## What this package does

A Playwright job that logs Angel One and Finvasia into AlgoTest each
morning via TOTP (`generateTotp`/`freshTotp` from `@trading/broker-identity`
— see that package for the shared RFC 6238 implementation). The broker OAuth
handshake happens on the broker's own domain, so it cannot be done over
plain HTTP; every DOM locator lives in `src/selectors.ts` so a redesign on
AlgoTest's or a broker's side is a single-file fix.

With the `QUANTIPLY_LOGIN` repository variable `on` (default off), the same
run also logs in to **Quantiply**, Angel One's algo platform
(`app.quantiply.angelone.in/auth?resume=/algos` → "Login / Sign Up" → Angel's
SmartAPI publisher login, the same page and `angelOneForm` selectors as the
AlgoTest Angel One login → back on Quantiply outside `/auth`, normally
`/algos`). It uses only the `ANGELONE_*` secrets and runs in its own browser
context (so Angel's session cookies can't change what AlgoTest's Angel One
login sees), never traced, capped at 5 minutes. It runs **first** only while it
can finish before AlgoTest's 08:16 window (the 08:00 dispatch: it uses minutes
the window guard would sleep); on a later or guard-skipped run it runs **after**
the AlgoTest logins, so it never delays them (`src/run-plan.ts`). Its result is
its own line in the Telegram report (`Quantiply · Angel One`; AlgoTest lines
become `AlgoTest · …`). A Quantiply config problem (a bad `QUANTIPLY_LOGIN`
value, or blank `ANGELONE_*` while AlgoTest's Angel One login is off) is only
its FAIL line; the AlgoTest logins still run. In Actions, main.ts writes
Quantiply's status to the "Log in brokers" step's output and a separate
"Quantiply login" step fails the job, so "Log in brokers" stays AlgoTest's own
result: the cron backstop skips once it succeeded, and never logs in to
Quantiply once any run happened that day; the morning summary names which part
failed. Turn on with `gh variable set QUANTIPLY_LOGIN --body on`; a manual
dispatch can override it with the `quantiply` input.

## Commands

```bash
npm install          # or: bun install from the monorepo root

npm run login         # tsx src/main.ts — the real daily job (needs live credentials + the 08:15-15:40 IST window)
npm run test-login     # tsx scripts/test-login.ts — connectivity + selector health check, any time of day, no broker secrets needed
npm run check         # tsx scripts/check.ts — RFC 6238 vectors, error classification, redaction, live TOTP codes + Telegram preflight (refuses to run in CI)
npm run record        # tsx scripts/record.ts — interactive flow recorder for capturing new selectors
npm run fyers-token   # tsx src/fyers.ts — headless Fyers login for the momentum weekly job; writes a 0600 token file (FYERS_TOKEN_FILE), never prints it
npm run dispatch      # tsx src/dispatch.ts — triggers the GitHub workflow via `gh` (the scheduler's 08:00 job); DRY_RUN=1 only checks gh auth
npm run test          # node:test unit tests: browser-free helpers (Fyers auth, dispatch rules, config gating, report, Quantiply rules) + Chromium against local stand-in pages (overlays, the Quantiply flow; no network)
npm run typecheck
```

## Source layout

- `src/main.ts` — entry point: runs Quantiply (if on) before or after the AlgoTest logins (`run-plan.ts`), waits for the AlgoTest login window, runs each broker's `login()`, sends one Telegram report for both
- `src/brokers/{angelone,finvasia}.ts` — one file per broker, each exporting a `Broker` (see `src/brokers/types.ts`)
- `src/selectors.ts` — every Playwright locator in the package, single-file fix on redesign
- `src/algotest.ts` — the AlgoTest platform login + My Brokers tab helpers (distinct from the broker OAuth handshake)
- `src/config.ts` — env var loading/validation; `Config.finvasia`/`Config.angelone` (the `SHOONYA_*` env var names are intentionally NOT renamed to match — see the comment there)
- `src/totp.ts` — re-export of `@trading/broker-identity`, plus `angelTotp()`: an Angel One code never from a 30-second window this run already typed one from (Quantiply and AlgoTest's Angel One login share the seed)
- `src/secrets.ts` — thin re-export of `@trading/notify`
- `src/diagnose.ts` — screenshot/HTML dump helpers used on failure, each bounded by a timeout (`withTimeout`) so a hung page can't hold the run
- `src/fyers.ts` — Fyers OAuth login (client ID → TOTP → PIN) → access token file; separate from the AlgoTest flow, used by `.github/workflows/momentum-weekly.yml`. Its locators (`fyersLogin` in `src/selectors.ts`) are PROVISIONAL until a real run's diagnostics confirm them
- `src/fyers-auth.ts` — the browser-free half: auth URL, redirect parsing (state-checked), token exchange, error classification (only a TOTP rejection is retried; a wrong PIN never is)
- `src/overlays.ts` — closes notices/modals/announcements that cover AlgoTest or a broker page. `installOverlayHandlers(context)` (called in `main.ts`) adds a Playwright locator handler to every page, including the Finvasia popup, so a covered click closes the notice and retries; `waitVisibleDismissing` is the notice-aware wait Finvasia's login-form step uses. It only clicks explicit close controls (never Escape, never "Cancel", which could refuse a consent screen), screenshots what it closes (`notice-before-dismiss`) and logs the notice's text. Tested against real Chromium in `overlays.test.ts`.
- `src/dispatch.ts` — runs `gh workflow run daily-broker-login.yml` with retries, confirms a run appeared, Telegram alert if not; `src/dispatch-rules.ts` holds the testable weekday 07:45–15:35 IST rule (launchd fires missed jobs on wake)
- `src/notify.ts` — `formatReport()`, the broker-specific Telegram report formatter (transport itself is `@trading/notify`); takes the Quantiply line as an optional third argument
- `src/quantiply.ts` — the Quantiply login (`runQuantiply`, never throws; `quantiplyLogin`). Same-tab or popup, Angel's inline `#login-error` read only while on `smartapi.angelone.in` (angelone.ts's `angel(one|broking)` host test would also match Quantiply's own `*.angelone.in` hosts), success = back on `app.quantiply.angelone.in` outside `/auth` and still there with no "Login / Sign Up" button 4 s later (the same check makes an "already logged in" count); a return to the login screen fails fast. No screenshot or HTML is ever taken of a logged-in Quantiply page (the repo is public and diagnostics are a downloadable artifact). `runQuantiplyIsolated` is the entry point main.ts uses: own context, 5-minute hard limit, never throws. Its locator (`quantiplyPage` in `src/selectors.ts`) was confirmed by a real login on 2026-10-18; on failure the diagnostics artifact holds `fail-quantiply-<step>` screenshots/HTML, plus `quantiply-angel-error`, `quantiply-no-return` or `quantiply-bounced`
- `src/run-plan.ts` — main.ts's pure decisions: whether Quantiply runs first, last or not at all (`quantiplyOrder`), and the exit code (`exitCode`)
- `src/quantiply-rules.ts` — the browser-free half: URLs, the logged-in/Angel-page URL predicates, error classification, the retry rule (wrong PIN: never; TOTP refused: once, next window; anything else: once only if the credentials were not sent yet), `QUANTIPLY_LOGIN` parsing

## AlgoTest strategies: upload (BL-137) and deploy (BL-138)

- `src/strategy-upload.ts` (+ pure `src/strategy-plan.ts`) puts the day's rotation picks into AlgoTest as saved
  strategies through the website (AlgoTest support OK'd it by phone, 2026-10-19). `--apply` needs
  `ALGOTEST_UPLOAD=on`, deleting also `--allow-delete`; it only ever deletes what its ledger
  (`TRADING_DATA_ROOT/rotation/algotest/ledger.jsonl`) says it uploaded, and never one deployed on /live.
- `src/strategy-deploy.ts` (+ pure `src/deploy-plan.ts`) deploys the day's recorded picks on /live. `--apply`
  and `--check` need `ALGOTEST_DEPLOY=on`. It stops at anything "Activate" opens that it has not seen.
- Their locators are `strategyPage` and `livePage` in `src/selectors.ts`, like every other. Both read
  `latest-<book>.json`, written by `obt rotation algotest-export`. The page contract is in
  `docs/algotest-execution.md` §7. Use a desktop viewport (1440 x 900): below about 500 px AlgoTest hides "Save
  Strategy".

