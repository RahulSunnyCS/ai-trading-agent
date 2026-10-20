# BL-139 — Rotation Core picks to Quantiply (Angel One): add them through its own API, deploy built but off

| | |
|---|---|
| **Priority** | P1 — the owner trades the Core picks with real money every day and sets them up on Quantiply by hand |
| **Status** | In progress: Phases 1–3 merged (#266), and the live upload is tested. It waits for `QUANTIPLY_UPLOAD=on`. Phase 4 (enable / disable over the API) is built but off until `QUANTIPLY_DEPLOY=on`; its first `--apply` is the owner's. Follow-ups from the #266 review are in #268 |
| **Type** | feature |
| **Area** | options + broker-login |
| **Created** | 2026-10-19 |
| **Depends on** | BL-137 (rotation export, picks, the evening/top-up planner and its ledger), BL-138 (deploy, built but off), the Quantiply login (#261, #262) |
| **TODO.md row** | §3.32 |

## Context

The owner, 2026-10-19: "we also need to automate adding the core adaptive strategies dynamically to
quantiply.angelone also".

- **BL-137** does this for AlgoTest:
  - `obt rotation algotest-export` turns the picks into `.algtst` files;
  - `strategy-upload.ts` uploads them:
    - in the evening it replaces the strategies with tomorrow's predicted picks;
    - at 09:16 it adds only the picks that changed;
    - a dropped pick stays until the evening.
  - It keeps a ledger, so it only ever deletes strategies it uploaded itself.
- **BL-138** deploys them on AlgoTest. It is built, but off until `ALGOTEST_DEPLOY=on`.
- **Quantiply** (`app.quantiply.angelone.in`) is Angel One's algo platform.
  - The daily 08:00 broker-login run already logs in to it through Angel One's SmartAPI page (`src/quantiply.ts`, `QUANTIPLY_LOGIN=on`).
  - Its strategies are built in a form. There is no import file (owner, 2026-10-19), but saving one
    calls Quantiply's own API, and the tool can make the same call.
  - BL-118 records that Quantiply paused algo services on 31 March 2026 for SEBI's retail algo framework. The owner uses it now, so they are back for the owner's account.
- Nothing yet reads or writes Quantiply's algo list or its form.

## Goal

- Every evening after the 16:00 result, the Core book's predicted picks for tomorrow are on Quantiply.
- At 09:16 any changed pick is added.
- Each strategy is named `Core · <variant>` and matches the strategy YAML field by field.
- No strategy the tool did not add is ever touched.
- One Telegram message is sent per run.
- Deploying is built but stays off unless the owner turns it on.

## Out of scope

- The T1 book: T1 stays on AlgoTest (owner, 2026-10-19). Adding it later is just a book choice.
- Placing orders from this repo. Quantiply places them on the owner's own Angel One account once the owner deploys.
- Quantiply's Custom Scripts webhook signals (BL-118 context).

## Answers (owner, 2026-10-19)

| Question | Answer |
|---|---|
| How is a strategy added on Quantiply today? | Built by hand in its form (no import file) |
| When should the picks reach Quantiply? | Same schedule as AlgoTest: evening replace with tomorrow's predicted picks, 09:16 add only what changed; dropped picks stay until the evening |
| Should the tool also deploy them? | Build deploy too, but off (like BL-138) |
| Which lists? | Core only; T1 stays on AlgoTest |

## Plan

### Phase 1 — Capture Quantiply's own API calls (with the owner)

Route (owner, 2026-10-19): when a strategy is saved, Quantiply's web app calls its own API. The tool
captures that call and repeats it with a JSON body built from our YAML, rather than filling the form.
That is faster, and more reliable than clicking through the form. The form stays the fallback, used
only if the API cannot be used.

- **Tasks:**
  1. The owner logs in to Quantiply and builds one Core strategy by hand while the network traffic is
     recorded. The recorder is the browser pane's network log, or a recorder like BL-137's
     `scripts/record-strategies.ts`:
     - it captures request and response bodies to `api-prod.quantiply.angelone.in`;
     - it redacts the Authorization header, cookies and tokens;
     - it keeps its output in the git-ignored `_rec/`.
     Pick a strategy that uses as many features as possible: SL %, trailing, re-entry,
     closest premium and overall MTM SL.
  2. Capture, for each call, the method, path, body shape and the response:
     - **create**: the save of a new algo;
     - **list**: the algo list, which also serves as the read-back;
     - **get**: one algo;
     - **update** and **delete**;
     - **deploy** and its undeploy, recorded only. They are not replayed until Phase 4 is switched on.
  3. Find how the API authenticates:
     - the header or cookie it needs;
     - where that comes from after the Angel One login (local storage, a cookie, a token response);
     - how long it lasts, and whether one login in the morning covers the 09:18 and evening runs.
  4. Map each body field to the YAML: legs, buy/sell, CE/PE, strike choice (ATM±n, closest premium),
     expiry, lots, leg SL % and points, trailing, re-entry, entry and exit times, range-breakout entry,
     overall MTM SL. For each field, note its enum values exactly as Quantiply sends them.
  5. Check Angel One's and Quantiply's terms on calling their API this way, as was done for AlgoTest,
     and record the owner's decision.
- **Deliverables:**
  - the API contract, recorded as a section "Quantiply algos through its API" in
    `docs/algotest-execution.md`. It covers the endpoints, the auth, the body schema and the enums;
  - the captured bodies, with all secrets removed, as test fixtures;
  - the list of Core YAML features the API cannot express.
- **Done when:** for each of the 12 Core-298 shapes, one of these holds:
  - every field the YAML sets has a body field mapped to it, confirmed by a strategy the owner built by hand;
  - or it is listed as unmappable, with the reason.

### Phase 2 — Export the Core picks as Quantiply create bodies

- **Tasks:**
  1. `to_quantiply(spec) -> Export(name, body)` builds the create body from the same
     `StrategySpec` as `to_algtst`.
     - It raises `Unmappable` for anything Phase 1 found missing; it never guesses.
     - Leg and strategy ids are made the way the web app makes them, or left out if the server assigns them.
  2. `obt rotation quantiply-export [--day] [--preview] [--next]` (Core only):
     - it reuses BL-137's `recorded_picks` / `preview_picks` and its manifest;
     - it writes under `TRADING_DATA_ROOT/rotation/quantiply/<day>/core`, with a
       `latest-core.json` pointer.
  3. Tests:
     - every Core-298 variant either maps or refuses with a named reason;
     - the bodies match the fixtures the owner made by hand in Phase 1, compared field by field
       with ids, timestamps and key order ignored, like `comparable()`.
- **Done when:** today's Core picks export, and each body equals the body Quantiply saved for the owner's
  hand-built copy of the same variant.

### Phase 3 — Add and replace on Quantiply (`quantiply-upload.ts`)

- **Tasks:**
  1. Get a session:
     - Log in the way `src/quantiply.ts` does, in its own browser context. Take only the
       auth value Phase 1 found, then close the browser.
     - The token is held in memory and registered with `registerSecret`. It is never logged,
       written to disk or sent in Telegram.
     - If the token lasts, reuse the morning login instead of logging in again.
     - Angel One's TOTP rule holds across processes: two codes from one 30-second window are never
       typed (`angelTotp`).
  2. Reuse `strategy-plan.ts`'s `plan()` for the two modes:
     - evening: keep, delete, upload;
     - top-up: upload only, and report changed and not-today picks.
     The list call supplies the existing names. The upload gets its own ledger,
     `rotation/quantiply/ledger.jsonl`, and the `Core · ` prefix. It deletes only names the ledger
     says it added, and never a deployed algo.
  3. POST each create body, then GET the algo back and compare it with what was sent.
     - A mismatch is recorded and alerted, and that algo is never deployed.
     - Any response other than 2xx with the expected shape stops the run. Nothing is retried blind.
     - Gate: `--apply` needs `QUANTIPLY_UPLOAD=on`; without it the run is a dry run that only reads the list.
  4. Add the scheduler jobs `quantiply-evening` (after AlgoTest's 16:40) and `quantiply-topup` (09:18),
     with retries like the AlgoTest jobs. Each run sends one Telegram message (`broker.quantiply`).
- **Done when:**
  - a supervised `--apply` evening run and a top-up run leave exactly the Core picks on Quantiply;
  - each read-back matches;
  - the owner's own algos are untouched.

### Phase 4 — Deploy (built, off)

Rewritten 2026-10-20 for the API route: deploying a Quantiply algo is switching it on (`enabled`), which trades on
its weekday every week until it is switched off.

- **Tasks:**
  1. Read the enable / disable call from the web app's own JavaScript (no call sent) and record it in
     `docs/algotest-execution.md`.
  2. `quantiply-deploy.ts --broker <b> --mode enable|disable|check [--day] [--apply]` + pure
     `quantiply-deploy-plan.ts`:
     - only the uploader's algos (its ledger) for the session, on the session's weekday, each read back against its
       export, set to the account's own broker if the upload left it unset;
     - never within 90 s of an algo's start (TOO LATE, that algo only);
     - after the calls, the list is read again: exactly the intended algos changed, nothing else; otherwise stop,
       alert, exit 3;
     - disable after the session, so nothing runs again next week.
  3. Gate it behind `QUANTIPLY_DEPLOY=on`, the deploy master switch and the account's row, and leave it off.
  4. Jobs: `quantiply-disable` 15:40, `quantiply-deploy` 16:55 (after the evening upload), `quantiply-deploy-topup`
     09:21 (after the top-up), one `quantiply` group with the uploads.
- **Done when:** a dry run against the live account lists the right picks, and the owner has watched one supervised
  run (only if they choose to turn it on).

## Risks

- **The API is undocumented.** Quantiply can change it without notice. The read-back catches a field it
  ignored, and an unexpected response stops the run with an alert. The form is the fallback if the API
  is ever closed to us.
- **The token is a live credential to the owner's Angel One algos.** It is kept in memory only and
  redacted from every log, report and fixture. The repo is public.
- **Gaps in Quantiply's model.** Range breakout, closest premium, re-entry at cost or overall MTM SL may be missing. An unmappable pick is reported and left for the owner, never uploaded in a near-enough form.
- **Angel One login rate.** The 08:00, 09:18 and 16:4x runs each log in through Angel's TOTP. If Quantiply keeps its session, reuse a stored session instead of logging in again (Phase 1 checks this).
- **Speed at 09:16.** A 09:17 pick changed at 09:16 has about a minute. One API call takes seconds,
  but the login does not. A top-up that would miss a 09:17 entry says so in its message rather than
  racing.

## Open questions

- How many lots per Core strategy on Quantiply? Today's evidence: the owner trades 3 Core strategies; the AlgoTest uploads are 1 lot each.
- Does Quantiply allow more algos than are deployed at once? The evening upload adds tomorrow's picks while today's may still be listed.

## Log

- 2026-10-20 — Review of #273, fixed on the branch:
  1. An algo this session already switched on or off (the deploy ledger) is never switched on again: an owner who
     switched it off by hand keeps it off.
  2. An ENABLED algo that fails a check (content, not read, weekday, broker, a duplicate) is switched off if it has
     not started, otherwise reported as ENABLED; never "not enabled".
  3. Disable is the safety net: it runs whatever `QUANTIPLY_DEPLOY` and the deploy switch say.
  4. The scheduler group never kept two logins out of one TOTP window. A file stamp of the last window per account
     does now, and the deployer retries a refused code once.
  5. TOO LATE is checked right before the enable call. After the broker call the algo is read back in full.
  6. A broker in an unknown shape counts as another account; `PUT {broker}` only goes to an unset one.
  7. Today's algos are switched off only after 15:30, unless `--emergency` (the emergency stop).
  8. A copy the uploader kept from an earlier week (same content) counts as the session's; an uploaded algo on the
     wrong weekday is no longer also "not uploaded".
  9. A retryable disable failure exits 1, so the 15:40 retries run.
  Nits: one ledger path and `readJson` for uploader and deployer, a crash alerts, the verify ignores the owner's own
  algos. Open, for the owner: enabling the evening preview at 16:55 (BL-138 deploys only the recorded picks).

- 2026-10-20 — Phase 4 built (owner, 2026-10-20: "Quantiply can already create the day's Core picks as algos, but it
  never enables (deploys) them; the owner enables by hand. Build the deploy step, mirroring AlgoTest's: off by
  default, two switches"):
  - The call, from the web app's bundle (`main.c34824e5.js`, fetched with curl): the row switch sends
    `PUT /algos/:id/enable` or `/disable` with no body and counts `status: "success"`. The bulk bar sends
    `PUT /algos/bulk/action/enable|disable` with `{algoIds}` and reads `{id, success}` per id. The broker menu sends
    `PUT /algos/:id` with `{broker}`, its options from `GET /brokers`. Recorded in `docs/algotest-execution.md`.
    Nothing was sent.
  - `src/quantiply-deploy.ts` + `quantiply-deploy-plan.ts` (16 tests); the login moved to `src/quantiply-session.ts`,
    shared with the uploader. Jobs `quantiply-disable` 15:40, `quantiply-deploy` 16:55, `quantiply-deploy-topup` 09:21.
  - Dry run on the live account for Wednesday 21 Oct: enable `Core · S_ditm1_1202` (12:02), `Core · S_p250_1317`
    (13:17) and `Core · S_p250_1302` (13:02), each with its broker to set; the disable plan shows all three disabled.
  - Two choices made here: the 09:21 run also switches off an enabled algo that 09:16 dropped (if it has not
    started), and the 15:40 disable with Automated deployment off changes nothing but alerts.
  - Open: the owner's first `--apply` (test: enable then disable Wednesday's three on the 20th, a holiday).

- 2026-10-19 — A second review of #266 (by the merging session) found three bugs. They are fixed in #268:
  1. A refused login is never retried: exit 3 is in `noRetryExitCodes`, and a hold blocks logins until the `.env` credentials change.
  2. Persistent problems (a conflict, a held-back delete, a read-back that differs) exit 3, so they are not re-run hourly.
  3. The top-up flags an ENABLED algo that 09:16 dropped ("it WILL TRADE").

  Still open from that review: the terms and compliance decision (Phase 1 task 5) is not recorded yet; it is the owner's call.
- 2026-10-19 — Code review on PR #266 (10 findings). Findings 1–5 fixed:
  1. An enabled algo for today is deleted only after 15:30 IST.
  2. A create that errors adopts a new same-name algo found by a re-list.
  3. The ledger is checked writable first; a failed row write stops the run with the row to add by hand.
  4. Failed deletes are keyed by algo id.
  5. The read-back checks the algo's weekday, and the manifest's weekday must match its date.

  Findings 6–10 (login reuse, duplicated helpers, dead unconfirmed plumbing) are left as they are.
- 2026-10-19 — First real upload, by the owner with `--apply` (at 17:25 IST, ledger in a scratch file):
  - It created `Core · S_ditm1_1202`, `Core · S_p250_1317` and `Core · S_p250_1302` for Wednesday 21 Oct.
  - Each was read back `identical`.
  - Quantiply's Wednesday list shows them disabled, with no broker, at the right times.
  - The three create rows were copied to `TRADING_DATA_ROOT/rotation/quantiply/ledger.jsonl`, so the scheduled runs own these algos.
  - The run printed its plan twice; fixed.
- 2026-10-19 — First dry run (the owner, in a terminal), against Wednesday 21 Oct's preview picks:
  - The run logged in through Angel One, took the token and read the list over the API.
  - Plan: create `Core · S_ditm1_1202`, `Core · S_p250_1317`, `Core · S_p250_1302`. Nothing was changed.
  - The owner's own browser session stayed logged in, so a scripted login does not sign it out.
  - Algos created without a broker show "Select Client ID / Broker" and are disabled. The owner's enabled algos carry their Angel One account (the create call's optional `broker`). Uploads leave the broker unset, and the owner picks it when deploying; Phase 4 must set it before enabling.
- 2026-10-19 — Owner: Quantiply can also delete in a batch. Its web app sends `DELETE /algos/bulk/action/delete` with `{algoIds: [...]}`; the call was read from the app's code, but its request was never captured.
  - The uploader keeps the captured one-by-one `DELETE /algos/:id`. An evening deletes only a few algos, and each delete gets its own ledger row and result.
  - Switch to the batch call only if the evening grows (for example when T1 joins) or Quantiply limits request rates. Capture one batch delete first.
- 2026-10-19 — Phase 3 built:
  - The trail in points is confirmed. The owner's `test1` saved `PER_POSITION_POINT` trailing beside a percent stop (fixture `trail_points.json`). No mapping is left unconfirmed.
  - `src/quantiply-upload.ts`, `quantiply-plan.ts` and `quantiply-api.ts` in `packages/broker-login`:
    - logs in through Angel One in a browser, takes the web app's JWT (`authorization: Bearer`) and closes the browser;
    - lists, creates, reads back and deletes over the API;
    - the ledger is keyed by algo id;
    - evening deletes only the tool's algos that are finished and not enabled for a later day.
  - Jobs: `quantiply-evening` 16:45 and `quantiply-topup` 09:19 (a minute clear of the pick's Angel One work). Off until `QUANTIPLY_UPLOAD=on`.
  - Not yet run against Quantiply. Still to do:
    - the owner's dry run;
    - whether a scripted login signs out the owner's own browser session.
  - The owner's two test algos (`test` Tue, `test1` Mon) are still in Quantiply, for the owner to delete.
- 2026-10-19 — Phase 2 built:
  - `legwise/quantiply.py` (`to_quantiply`, `comparable` for the read-back) and `rotation/quantiply_export.py` + `obt rotation quantiply-export` (Core only).
  - Execution settings are copied from the owner's `N_ITM1_SL21_3000` (owner's choice): limit orders with buffer 3, product D, SL limit 1, exit delay 3 s.
  - All 298 Core variants map. Only `N_buy` / `S_buy` use a trail in points, which is never yet seen saved, so they are marked unconfirmed.
  - 25 tests against the captured fixtures.
  - The exit time is the YAML's (15:28:00); the owner's own algo uses 15:28:50.
- 2026-10-19 — Phase 1 captured with the owner in the browser pane:
  - The calls: create (`POST /algos`, one algo per weekday, not enabled), list (`/algos/day-wise`), read (`GET /algos/:id`) and delete (`DELETE /algos/:id`).
  - Auth: a 9-hour JWT kept in the app's local storage.
  - Every Core feature maps: strike, closest premium, SL %, trailing %, re-entry at cost, range breakout and MTM SL. Trailing in points is unconfirmed.
  - The contract is in `docs/algotest-execution.md`, and the fixtures are in `tests/fixtures/quantiply/`.
  - Only one DELETE was seen (the Tue copy); the Mon copy's delete is unconfirmed.
  - Still open:
    - market or limit orders;
    - one login per run or a reused token;
    - the enable (deploy) call, not sent.
- 2026-10-19 — route changed (owner): capture the create call the web app makes and POST it, rather than
  filling the form. Phases 1–3 rewritten; the form is the fallback.
- 2026-10-19 — created from the owner's request. Questions answered: built in the form, AlgoTest's schedule, deploy built but off, Core only.
