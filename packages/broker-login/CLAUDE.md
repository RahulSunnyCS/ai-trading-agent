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
npm run stop-button -- --plan             # BL-143: what the Telegram stop would do now (ledgers only, no login)
npm run stop-button -- --dry-run --fixture fixtures/stop-dry-run.json   # plus each call it would make (none sent)
npm run stop-button -- --clear-hold       # lift the stop hold (Telegram's Resume does the same)
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

## Automation settings (BL-140)

`src/automation-settings.ts` reads the dashboard's Settings › Automation, which the scheduler writes to
`automation-settings.json` (`SCHEDULER_STATE_DIR`). With no file yet it uses today's setup. What follows it:

- **Uploads:** `strategy-upload.ts --from-settings` (every list AlgoTest's blocks choose) and
  `quantiply-upload.ts --broker <b> --from-settings` (that Quantiply account's list). A block with upload off is
  left untouched.
- **Logins:**
  - `dispatch.ts` does not dispatch with logins off.
  - The workflow's 08:15 backstop skips on `BROKER_LOGIN_ENABLED=off`.
  - `ONLY=none` skips the AlgoTest brokers.
  - `QUANTIPLY_BROKERS` listing `finvasia` logs Quantiply · Shoonya in after the AlgoTest logins
    (`runQuantiplyShoonyaIsolated`, one attempt, its own report line, never the exit code).
- **Deploy:** `strategy-deploy.ts --apply` also needs the deploy master switch on;
  `quantiply-deploy.ts --mode enable --apply` needs it and the account's row uploading a list
  (`quantiplyDeploy`), and takes that row's list as its picks.

The scheduler sets the repository variables on every save. `.env` switches (`ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD`,
`ALGOTEST_DEPLOY`, `QUANTIPLY_DEPLOY`) still need `on`.

## Quantiply algos: upload (BL-139)

- `src/quantiply-upload.ts` (+ pure `src/quantiply-plan.ts`, API client `src/quantiply-api.ts`) puts the day's
  rotation picks into a Quantiply account as algos (`--broker angelone` = app.quantiply.angelone.in, ledger
  `ledger.jsonl`; `--broker finvasia` = quantiply.shoonya.com, logged in by `src/quantiply-shoonya.ts`, ledger
  `ledger-finvasia.jsonl`; hosts in `QUANTIPLY_SITES`) through Quantiply's own API, the calls its web app makes
  (`docs/algotest-execution.md`, "Quantiply algos through its API").
  - It logs in with `quantiplyLogin` (Angel One, TOTP) in a browser, reads the web app's JWT from local storage,
    closes the browser, and calls the API with `authorization: Bearer <JWT>`. The token is registered as a secret
    and never logged.
  - Quantiply keeps one algo per weekday, so the ledger (`TRADING_DATA_ROOT/rotation/quantiply/ledger.jsonl`) is
    keyed by algo id. Only ids in it are ever deleted, and only when Quantiply shows them finished and not enabled
    (an algo enabled for today only after 15:30 IST, when its session is over).
  - Every created algo is read back (`GET /algos/:id`) and compared field by field (`readBackDiffs`), its
    weekday included; the manifest's weekday must match its date.
  - A create that errors on this side is checked against a fresh list: a new algo of that name on the day is
    taken over (owned, read back) rather than left unowned. The ledger is checked writable before any change;
    if a row cannot be written, the run stops and the message carries the row to add by hand.
  - `--apply` needs `QUANTIPLY_UPLOAD=on`; Telegram type `broker.quantiply`. It never enables (deploys) an algo.
  - It reads `latest-core.json`, written by `obt rotation quantiply-export`.
  - The login, the refused-login hold and the token are `src/quantiply-session.ts`, shared with the deployer.

## Quantiply algos: enable and disable (BL-139 Phase 4)

`src/quantiply-deploy.ts --broker angelone|finvasia --mode enable|disable|check [--day D] [--emergency] [--apply]` (+ pure
`src/quantiply-deploy-plan.ts`) switches the uploader's algos on and off: `PUT /algos/:id/enable|disable`, the web
app's row switch (`docs/algotest-execution.md`). An enabled algo trades the real account on its weekday, every
week, until disabled.

- Only algos in that account's uploader ledger for the session are touched (`--day`; default for enable: today
  before 15:30 IST on a trading day, else the next trading day; for disable and check: today): the create row's
  `day` is the session, or it is an earlier copy on the session's weekday with the pick's content that the
  uploader kept (`ownedForSession`).
- Enable takes the session's picks from the export (`latest-<book>.json`, the account's list); for today it needs
  the recorded picks. Each algo must be on the session's weekday (Quantiply's and the ledger's), not enabled,
  finished, with the export's content (the ledger sha, not a `mismatch:` row, and a fresh `readBackDiffs`), and a
  broker that is unset (then set to the `GET /brokers` account whose `clientId` is the `.env` login, read back) or
  that account. For today, never within 90 s of its start (TOO LATE, that algo only, checked again before each
  call, after the broker call and its full read-back). Never one this session's deploy ledger already shows
  switched on or off: an algo the owner switched off by hand stays off. An owned algo of the session that is
  ENABLED but no longer a pick (09:16 dropped it) or fails any check is switched off if it has not started,
  otherwise reported as ENABLED; a failed check is never reported as just "not enabled". A broker that is set in
  a shape the tool does not know counts as another account: `PUT {broker}` is only ever sent to an unset one.
- Disable switches off the session's owned algos still enabled, and any of an earlier session; only finished ones.
  An algo on today's weekday only after 15:30 IST, unless `--emergency` (the emergency stop: today's pending
  entries too).
- After the calls the list is read again (`verifyToggles`): exactly the intended ids changed and no other algo of
  the tool's; anything else exits 3 and alerts (a change on the owner's own algos is a note). A failed enable stops
  the run there. A disable whose call failed exits 1 (retried) even when something else needs the owner.
- Enabling with `--apply` needs `QUANTIPLY_DEPLOY=on` (checked before logging in), Automated deployment and the
  account's row. Disabling is the safety net and is never gated: it reads no automation settings, and an
  unreadable deploy ledger or line is skipped. A kept copy the deploy ledger shows enabled for a later session
  belongs to that session for disable and check (`enabledSessions`). An enable that failed earlier in the
  session is reported ENABLE FAILED and left off. An account with nothing of the tool's for the
  session is not logged in. Every change is a row in `deploy-ledger[-<broker>].jsonl` beside the ledger.
- Logins go through `quantiply-session.ts`: it waits out the last TOTP window the account typed a code in (a file
  stamp beside the ledger, shared with the uploader), and the deployer retries a refused code once. The ledger
  path (`quantiplyLedgerPath`) is decided there too, for both.

## AlgoTest strategies: upload (BL-137) and deploy (BL-138)

- `src/strategy-upload.ts` (+ pure `src/strategy-plan.ts`) puts the day's rotation picks into AlgoTest as saved
  strategies through the website (AlgoTest support OK'd it by phone, 2026-10-19). `--apply` needs
  `ALGOTEST_UPLOAD=on`, deleting also `--allow-delete` (the `algotest-evening` job passes it since 2026-10-20); it
  only ever deletes what its ledger (`TRADING_DATA_ROOT/rotation/algotest/ledger.jsonl`) says it uploaded, and never
  one deployed on /live or set to repeat on a weekday there. A delete never clicks: `src/strategy-delete.ts` makes
  AlgoTest's own API call (`docs/algotest-execution.md` §7) for the `_id` recorded in the ledger when the strategy
  was uploaded, only if that id is the one strategy listed under its name; it then lists again (through the API): the
  id must be gone and every other strategy still there, or the run stops with exit 3 (no retry, a STOP alert).
  A STOP also writes `STOP` beside the ledger, and every later run holds its deletes until the owner removes it.
  The id comes from the save answer, else from the one new id a fresh listing shows under the name; an upload
  whose id cannot be read is flagged at once. A strategy named by the tool stays the tool's even if the owner edits
  it in place ("Update" keeps its id); rename it to keep it. Uploads before 2026-10-20 had no id: `--record-ids`
  adds it once from the listing (ledger only); it cannot tell a tool upload from the owner's copy of the same
  name, so it was run once, supervised.
- `src/strategy-deploy.ts` (+ pure `src/deploy-plan.ts`) deploys the day's recorded picks on /live. `--apply`
  and `--check` need `ALGOTEST_DEPLOY=on`. It stops at anything "Activate" opens that it has not seen.
- Their locators are `strategyPage` and `livePage` in `src/selectors.ts`, like every other. Both read
  `latest-<book>.json`, written by `obt rotation algotest-export`. The page contract is in
  `docs/algotest-execution.md` §7. Use a desktop viewport (1440 x 900): below about 500 px AlgoTest hides "Save
  Strategy".

## The stop button (BL-143 Phase 4)

The owner's Telegram "stop everything": switch off AND square off, only after a second confirm tap (owner,
2026-10-20). The listener and the taps are `apps/scheduler/src/stop-button.ts`; this package does the stop.

- `src/stop-button.ts --apply` (started by the listener). It refuses, exit 2 with a `REFUSED: <why>` line the
  listener passes on, unless `STOP_BUTTON=on`, and while another stop runs. Then:
  1. marks the stop as running: `stop-running.json`, `{pid, at}`, beside each hold copy, each created atomically
     (`wx`), removed when the stop ends and on SIGTERM / SIGINT, so a second stop does not start and the loss /
     deploy monitor keeps off the accounts meanwhile. A marker is stale (replaced, never blocking) when its pid is
     dead or this run's, when it is older than 20 minutes or not from today (IST), whatever its pid. A live one is
     refused: "a stop is already running since <date time> IST (pid N). If no report arrives, wait until <HH:MM>
     IST (its marker then lapses), or delete <both marker paths>, and send /stop again". Then it writes the hold and reads it back
     (`src/stop-hold.ts`: `TRADING_DATA_ROOT/stop/HOLD.json` and `<SCHEDULER_STATE_DIR>/stop-hold.json`; either
     holds). If it is saved nowhere, the stop still squares off and switches off, and says first, in its own
     message and at the top of the report, "HOLD NOT SAVED (…): the tool may re-enable or upload after a scheduler
     restart. Stop the scheduler or fix the volume" (sent without holding up the square-offs); the scheduler holds
     in memory meanwhile;
  2. runs each platform in its own path, settled on its own (`settle`, `Promise.allSettled`): a browser that will
     not start fails that platform's section only;
  3. sends the report, a section per platform, in parts under Telegram's 4096 characters (`sendTextChecked`). A
     failed delivery (also of the crash message) sends one short fallback and exits 4. Otherwise exit 0 = all
     confirmed, 3 = something needs the owner. Every step is a line in `TRADING_DATA_ROOT/stop/<day>.jsonl`.
  - A square-off is sent once per id per day, across stops: each run starts from today's stop log
    (`priorSquareOffs`: every `sq_off_terminate` / `square_off` row answered, or with no answer, from
    `stop/<day>.jsonl` and its copy `<SCHEDULER_STATE_DIR>/stop-squareoffs-<day>.jsonl`, kept for an unmounted
    volume) and never sends those again; they are waited on and reported as "sent HH:MM by an earlier stop", and
    one that got no answer keeps its "may have been sent (no answer)" wording. An earlier deploy gone from /live is
    said once, then logged `gone`; it stays in the never-send-again set, and if it is listed again it is "⏳ <name>:
    square-off sent at HH:MM by an earlier stop, AlgoTest lists it Live again: open /live first; do NOT exit at the
    broker while its exit is pending".
  - A square-off call refused outright (a 4xx, or never sent) was not sent: "square off by hand". One with no
    answer (a timeout, a network error, a 5xx) MAY have been sent: "⚠️ square-off may have been sent (no answer):
    … Open <platform> first; exit at the broker only if it shows no pending exit" (`definitelyRefused`,
    `quantiply-api.ts`); if the platform then shows it squaring off it is "square-off sent, still closing".
  - Every list call rides out a blip (3 tries, backing off). If a platform's stop ends on an error anyway, its
    report names every square-off already sent: "square-off already sent for: … Do NOT exit these at the broker".
  - Quantiply, each account: its uploader ledger must be readable. A missing one is "could not tell what is the
    tool's: check Quantiply by hand" (never a green line without a login), unless Settings › Automation gives the
    account no list and no uploads ("not used by the tool"; unreadable settings fail closed). Login through
    `quantiply-session.ts` (the refused-login hold, the TOTP stamp and the per-account login lock every Quantiply
    login takes). Then in bounded passes: square off &
    terminate the tool's `TRADE_ACTIVE` algos (`squareOffTerminate`, `PUT /algos/:id/action/SQ_OFF_TERMINATE`),
    switch off its enabled ones (`READY`, `NOT_RUNNING`, `TRADE_CLOSED`; any weekday), wait for the squared-off
    ones to show finished (later passes keep waiting while one still shows open); an algo that entered meanwhile
    is squared off on the next pass. A sent square-off still `TRADE_ACTIVE` at the end is "square-off sent, still
    closing … do NOT exit these at the broker" (the exports use limit orders), never "by hand". Each call is a
    `mode: 'stop'` row in the account's deploy ledger (`quantiplyDeployLedgerPath`) under today AND the next
    session of the algo's weekday, so no enable switches it back on (`toggledIds` counts `sqoff` rows too).
  - AlgoTest: log in (website), then `GET /execution/v2/executions?environment=live` and
    `PUT /execution/v2/square-off/<id>` for each Live / Error, active-on-server deploy of the tool's (the web app's
    `canSquareOff`), in passes (later passes keep waiting while one still shows squaring off). The tool's: the strategy id the uploader recorded (when the list carries one), a
    name it ever saved, or a `NAME_PREFIXES` prefix (`toolMatcher`). `pending_square_off` is waited on (up to
    60 s a pass) and, if still showing, reported "square-off sent, still closing: do NOT exit at the broker",
    never "by hand". The report reads /live afresh (`algotestOutcome`): only `StrategyStatus.SquaredOff` is done;
    `Stopped` (switched to manual) today is "check: legs may be open"; a refused one still live is "❌ still LIVE:
    square off by hand on AlgoTest /live", and "nothing of the tool's running" only when nothing was tried.
  - What the platform offers no square-off for, or what still shows open, is reported "square off by hand". No
    order is ever placed with a broker directly. The owner's own algos and deploys are named, never touched.
  - Calls and statuses: `docs/algotest-execution.md` (§7 and "Quantiply algos through its API"). Pure rules:
    `src/stop-plan.ts`; the calls against injected clients: `src/stop-run.ts` (tested against stand-in servers).
- The hold lasts until lifted (`--clear-hold`, or Telegram's Resume with its confirm tap; each copy is kept, renamed
  `…-cleared-<time>.json`). While it exists `strategy-deploy.ts`, `strategy-upload.ts`, `quantiply-upload.ts`
  and `quantiply-deploy.ts --mode enable` change nothing with `--apply` (`stopHeld()`), and the scheduler refuses
  their jobs. `quantiply-deploy.ts --mode disable` is never held.
- The Quantiply login lock (`takeLoginLock`, `login-lock-<broker>` beside the ledger): exclusive create with a
  token; a dead or 6-minute-old lock is taken over only under a second exclusive marker (`.takeover`) and only if
  it is still the lock judged stale; a release removes only its own lock. Taken once per login, in `openQuantiply`.
- `NAME_PREFIXES` (`strategy-plan.ts`) is append-only: a rename adds prefixes and keeps the old ones (a test pins
  them), because ownership, the 15:40 disable and the stop all match on it.
- Never tested live: the tests use stand-in servers and fixtures only; `--plan` and `--dry-run` never log in or
  send anything.
