# BL-172 — The morning on the Mac: login, Quantiply MTM SL and enable at 08:00; 09:16 changes only after 09:17; GitHub as backup

| | |
|---|---|
| **Priority** | P1 — the morning logins put the real-money accounts online; two copies of the credentials already cost two refused Shoonya logins (26 and 27 Oct) |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | broker-login / scheduler |
| **Created** | 2026-10-27 |
| **Depends on** | BL-140 (settings), PR 347 (ONLY=none leaves AlgoTest out) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner (2026-10-27): "why do we depend on GitHub for login. We should be self sufficient and do it on our
own via our Mac server. GitHub can be backup."

The morning login runs in GitHub Actions for historical reasons only: `packages/broker-login` came from
the `algo-automation` repo, which had no always-on machine, so its cron in GitHub Actions was the job.
When GitHub delivered that cron hours late, BL-011 (5 Oct) made the laptop's scheduler trigger it at
08:00 (`dispatch.ts` → `gh workflow run`), but the login itself stayed on GitHub's runners. The
scheduler has dispatched it every trading day since 12 Oct.

What depending on GitHub costs:

- **Two copies of every credential.** GitHub's `SHOONYA_PASSWORD` secret was from 28 Sep; the `.env`
  password changed around 23 Oct. GitHub sent the old one twice (26 and 27 Oct, "Wrong Password"),
  two attempts toward a Shoonya lockout, while every laptop job logged in fine.
- **The local guards cannot see it.** The AlgoTest login lock and `login-algotest.last`, Quantiply's
  TOTP-window stamp, login lock and refused-login hold, and the `obt angel` guard live on the Mac; a
  GitHub login bypasses all of them (`packages/broker-login/CLAUDE.md`, trade monitor, "Not covered").
  The 08:00 `angel-login-check` and GitHub's Quantiply · Angel One login share a TOTP seed with no
  shared window stamp.
- **Settings reach it second-hand.** Each Settings › Automation save is copied into five repository
  variables through `gh`; a failed sync leaves GitHub on the old choice.
- **Slower and more exposed.** About a minute of container start and `bun install` every run, the
  diagnostics uploaded as artifacts of a public repository, and a daily run-log commit.

Every other job that logs in to AlgoTest or Quantiply (uploads, deploys, live capture, the trade monitor,
the stop button) already runs on the Mac with `.env`, with the locks above.

Owner, same day, two more for the morning:

- **Enable the Quantiply strategies at 08:00; the 09:16 pick changes only what starts after 09:17**
  (Phase 4; first asked as "do nothing on the 09:16 Telegram pick"). BL-165
  showed the evening's prediction is the real 09:16 pick on 97% of days, with the same return, and the
  09:18 top-up adds nothing measurable. Today the enable is built (`quantiply-deploy.ts`, BL-139 Phase 4)
  but off (`QUANTIPLY_DEPLOY`), scheduled 16:55 for the next session with a 09:21 top-up, and for
  today's session it accepts only the 09:16 recorded picks (`quantiply-deploy.ts` "the session is
  today and needs today's recorded picks"). The owner switches the algos on by hand.
- **Keep Quantiply's MTM SL at the list's portfolio stop, every morning:** Adaptive Tuned (T1)
  ₹9,000, Adaptive Classic (Core) ₹8,000 (the Rotation page's portfolio-stop defaults,
  `DEFAULT_T1_STOP` / `DEFAULT_STOP` in `apps/dashboard/src/lib/portfolioStop.ts`). At 08:00: already
  that figure, nothing to do; otherwise set it. In settings v6 Quantiply · Shoonya uploads T1 and
  Quantiply · Angel One Core, so ₹9,000 and ₹8,000 respectively; the figure follows the row's list.

## Goal

The 08:00 login runs on the Mac, from `.env` and `automation-settings.json`, through the same locks and
holds as every other login. GitHub runs it only when the Mac did not: the laptop off or asleep past the
login window, or a local failure a second attempt elsewhere could fix (never a refused password or PIN).

Right after the login, on the Mac: each Quantiply account that uploads a list has its MTM SL at that
list's portfolio stop, and last evening's uploaded algos for today are switched on. The 09:16 pick
changes only strategies that start after 09:17 (Phase 4).

## Out of scope

- The Fyers token (its login page has a human check; it stays the dashboard's Login button).
- Hosting the scheduler elsewhere (BL-012's "hostable later").
- Removing the GitHub workflow: it stays, as the backup.
- The 09:16 pick itself (`options-rotation-pick`): it still records the journal entry and sends its
  Telegram message, as now.
- AlgoTest's MTM or enable: no AlgoTest row is on (settings v6); revisit if one turns back on.

## Plan

### Phase 1 — The login runs on the Mac
- **Tasks:**
  - The scheduler's `broker-login` job runs `src/main.ts` locally instead of `dispatch.ts`, with `ONLY`,
    `QUANTIPLY_LOGIN` and `QUANTIPLY_BROKERS` derived from `automation-settings.json`
    (`effectiveRow`), not from the repository variables. Credentials from the repo-root `.env` (the
    runner already parses it); the package's own stale `.env` is never read for this.
  - Every login inside it takes the local guards: AlgoTest through `algotestLoginLocked` (stamps
    `login-algotest.last`); Quantiply · Angel One and · Shoonya through `quantiply-session.ts`'s login
    lock, TOTP-window stamp and refused-login hold; a refused password or PIN writes the hold, so no later
    job resends it.
  - `angel-login-check` and the Quantiply · Angel One login stop sharing a 30-second TOTP window
    (the same stamp, or run one after the other).
  - The result is recorded where the morning summary reads it (the scheduler's run history instead of
    `gh run list`); the Telegram report stays as it is.
  - Diagnostics (screenshots, HTML) go to a local folder under the scheduler's log directory, never a
    public artifact; still none of a logged-in Quantiply page.
- **Deliverables:** the job change in `apps/scheduler/src/jobs.ts`, a settings-to-env helper with
  tests, the summary change, docs (`packages/broker-login/CLAUDE.md`, `apps/scheduler/CLAUDE.md`,
  `technical.md`, the Guide's Jobs and Settings pages).
- **Done when:** one trading day's 08:00 login runs on the Mac with no GitHub run, its report and the
  09:00 summary are right, and the locks show its logins (`login-algotest.last`, the TOTP stamps).

### Phase 2 — GitHub as the backup
- **Tasks:**
  - After a local success the scheduler records the day where GitHub can read it (a repository
    variable such as `LOCAL_LOGIN_OK=<IST day>`, set through `gh`). The workflow's backstop crons skip
    when it is today, as they now skip after a successful GitHub run.
  - A local failure that another machine could fix (the browser would not start, a network error,
    AlgoTest's page not loading) dispatches the GitHub workflow once, for the parts that failed only. A
    refused password, PIN or TOTP never does: that is the owner's to fix, and a resend counts toward a
    lockout.
  - The laptop asleep at 08:00 and awake before 15:35: the scheduler's catch-up runs the local login, as
    it does the dispatch today.
- **Deliverables:** the workflow's backstop-check change, the fallback dispatch in the job, tests for
  the "which failures fall back" rule.
- **Done when:** a simulated local failure (browser that will not start) produces exactly one GitHub
  run, a refused credential produces none, and a day with a local success has its backstop crons skip.

### Phase 3 — Keep the backup's credentials true
- **Tasks:** GitHub cannot show a secret's value, so the scheduler compares what it can: after an
  `.env` change to a broker credential (the file's value hash against one kept in the state directory),
  Telegram once: "`.env` broker credentials changed: update the GitHub secrets for the backup" with the
  names, and the command that copies them without printing them.
- **Done when:** changing `SHOONYA_PASSWORD` in `.env` sends that reminder once.

### Phase 4 — The 09:16 pick changes only what starts after 09:17
Owner, 2026-10-28 (superseding "nothing on the 09:16 pick" from earlier the same night): when the 09:16
pick differs from last evening's, a change whose new strategy enters at 09:17 is not made (the evening's
strategy runs); a change whose new strategy enters later (09:32, 12:02, …) is made: the evening's
strategy it replaces is taken off and the new one created and switched on.
- **What exists:** `quantiply-topup` (09:19) creates the recorded picks the evening upload lacks, and
  `quantiply-deploy-topup` (09:21) switches them on and switches off an owned algo no longer picked if
  it has not started. A 09:17 pick is already TOO LATE there (90 s rule), but its dropped partner is
  still switched off, which loses it: the owner's rule keeps it.
- **Tasks:**
  - A pure rule over (evening picks, recorded picks, now): each change is a dropped evening pick D and
    an added pick A (pairing: see the questions). A enters at 09:17, or too soon to switch on: no
    change, D stays on. Otherwise: create A, switch it on, switch D off (only if D has not started; a
    started D stays and is reported). Unit-tested, in `quantiply-deploy-plan.ts`.
  - The two morning jobs follow it as one step per account (create → switch on A → switch off D), so
    a failure never leaves D off with A not on: A on first, then D off.
  - D is switched off, not deleted, in the morning; the evening upload deletes it as now (it deletes
    only finished, switched-off algos). See the questions.
  - The day's list as actually run (evening picks with the changes made) is written beside the export,
    and the trade monitor, live capture and the 16:00 message read it.
  - `algotest-deploy` (09:16) and `algotest-topup` (09:18) are removed while no AlgoTest row is on.
- **Done when:** replayed on the forward days where 09:16 changed a pick, the rule gives the expected
  list each time, and one live day with a change after 09:17 switches the new algo on and the old off.

### Phase 5 — Quantiply MTM SL at the list's stop, every morning
- **Tasks:**
  - **Found (2026-10-28):** the "Clientwise P&L" stop-loss, account-wide per broker client: read from
    `GET /brokers` (`configurations.<MON…SUN>.stoploss`, negative), saved with
    `POST /brokers/<id>/config` `{stoploss: -SL, target}` (`docs/algotest-execution.md`, "Clientwise
    stop-loss and target"). The owner set ₹8,000 (Angel One) and ₹9,000 (Shoonya) by hand; all seven
    days read back alike. The call has not been sent by the tool yet: the first one is supervised.
  - "Already right" means every weekday's `stoploss` is −figure and `target` is unchanged (a target or
    trailing option the owner set by hand is kept, sent back as read).
  - At 08:00, after that account's login: read the figure; equal to the row's list stop, nothing
    changes ("MTM SL ₹9,000 ✓"); otherwise set it, read it back, and say old → new in the morning
    report. A read-back that differs stops and alerts (exit 3, never retried).
  - The figure lives in one place (see the questions); the job never guesses one.
- **Done when:** a morning with the figure already right changes nothing; one with it changed by hand
  sets it back and reports old → new; the by-hand check in Quantiply shows the figure.

### Phase 6 — Enable last evening's picks at 08:00
- **Tasks:**
  - `quantiply-deploy.ts --mode enable` accepts the evening export for today's session when asked
    (a flag such as `--picks evening`: the manifest's `day` is today and its source is `preview`;
    without the flag the rule stays as it is). Every other check stays: owned by the uploader, read back
    against the export, on today's weekday, the account's broker, never one the deploy ledger shows
    switched already, never within 90 s of its start.
  - The morning sequence on the Mac, per account: login → MTM SL (Phase 5) → enable. The enable runs
    only if that account's login and MTM SL succeeded (an algo must never go live under a wrong or
    unknown MTM SL).
  - The 16:55 `quantiply-deploy` (enable the evening before) is removed: algos go live only in the
    morning. The 15:40 `quantiply-disable` safety net stays as it is.
  - `QUANTIPLY_DEPLOY=on` in `.env` is the owner's switch, and a scheduler restart after it.
- **Done when:** one trading day's algos are switched on by 08:30 with no hand step, the morning report
  lists them, and the 15:40 disable switches them off.

### Phase 7 — Quantiply · Shoonya subscription: the next session's algo count, each evening
Owner, 2026-10-28: Quantiply · Shoonya is paid (Quantiply · Angel One is free). Its Subscription sets
how many algos a day the account may run, and it is charged on a daily basis: lowering it returns
credits. So each evening, once the upload knows how many strategies the next session needs, the count is
set to that.
- **What it is now** (read 2026-10-28, read-only, `GET /users/me` `subscription`, `GET /subscriptions/plans`):
  the Value plan, auto-renew on, term 23 Oct – 21 Nov; `algosPerDay` 2 included + `additionalAlgos` 3 =
  `totalAlgosPerDay` 5; 250 credits per extra algo per 30 days. Calls in the app: `PUT /subscriptions/<id>`
  (change), `POST /subscriptions/<id>/preview-upcoming` (what a change costs or returns),
  `GET /subscriptions/plans`. **Found (2026-10-28):** the owner lowered 5 → 3 by hand (415 credits back,
  prorated by the days left in the term); the change is `PUT /subscriptions/<id>` `{plan, additionalAlgos}`
  (`docs/algotest-execution.md`, "Shoonya's subscription"). An `additionalAlgos` of 0 is left out of the
  body by the app: check what the server does before the tool ever asks for 2.
- **Tasks:** after the evening upload for `quantiply.finvasia`: needed = the next session's algos on the
  account (the export's picks, Buy add-on included when on); `additionalAlgos` = needed − `algosPerDay`
  (never below 0). Preview the change, make it, read the subscription back, and report old → new with
  the credits. Angel One: nothing.
- **Open:** raising the count spends credits: automatic too, or only lowering (raising reported for the
  owner to do)? Does the limit count the owner's own algos on that weekday as well as the tool's?
- **Done when:** one evening's count is set by the tool to the next session's algos and the credits
  returned show in the report.

## Risks

- **The Mac is off or asleep through 08:00–15:35.** Then the backstop crons (often hours late) or a
  manual dispatch log in; uploads, deploys and the monitor would not have run either.
- **Two logins for one account in the switch-over.** Phase 1 removes the 08:00 dispatch in the same
  change that adds the local run, and the backstop's existing rule (skip after a success today) still
  sees GitHub runs only until Phase 2's variable exists: until then a laptop success must also stop the
  crons (set `LOCAL_LOGIN_OK` from Phase 1 already, or ship Phases 1 and 2 together).
- **Playwright on the Mac.** The uploaders already run Chromium there, so the browsers are installed;
  keep the package's Playwright version and the workflow's container tag in step (as today).

## Open questions

- **09:16 pairing:** when several picks change, which dropped pick does each added one replace?
  Proposed: the same variant family and index first, else the closest entry time. And an added 09:17
  pick with no dropped partner (the list grew): skip it?
- **Taking the old one off at 09:2x:** switch it off and let the evening run delete it (proposed:
  deleting a not-yet-run algo is a new kind of delete), or delete it at once?
- Where the ₹8,000 / ₹9,000 live: a field per Quantiply row in Settings › Automation (one place, the
  morning job reads it), or follow the Rotation page's portfolio-stop defaults?
- When to switch `QUANTIPLY_DEPLOY=on`: with Phase 6 merged, or after one supervised morning?

- Phases 1 and 2 in one change (no window where a local success and a late GitHub cron both log in), or
  Phase 1 with the crons switched off until Phase 2?
- Should the fallback dispatch also cover the AlgoTest broker logins when an AlgoTest row turns back
  on, or Quantiply only?

## Log

- 2026-10-27 — Created from the owner's request; the owner chose GitHub as the backup. Planned.
- 2026-10-28 — Owner: enable the Quantiply strategies at 08:00 and do nothing on the 09:16 Telegram
  pick (BL-165: the 09:16 changes make no difference to the result); keep Quantiply's MTM SL at
  ₹9,000 for T1 and ₹8,000 for Core, checked each morning and set only when different. Phases 4-6
  added.
- 2026-10-28 — Owner, later: the 09:16 change is made after all, except where the new strategy enters
  at 09:17 (the evening's runs instead); later changes delete the old strategy, create the new one and
  switch it on. Phase 4 rewritten.
- 2026-10-28 — Owner set the Clientwise SL by hand (₹8,000 Angel One, ₹9,000 Shoonya); the setting and its
  call found (Phase 5). Owner: Quantiply · Shoonya's Subscription sets how many algos a day it allows
  (Phase 7). Read back: Value plan, 5 a day, term to 21 Nov. Owner: it is charged daily and lowering it
  returns credits, so it is set each evening to the next session's count. The owner set 3 (Value plan (3),
  415 credits back); the change's call found.
