# CLAUDE.md

Guidance for coding agents working in `apps/scheduler` (`@ata/scheduler`).

## What this app does

One home for every recurring job (BL-012, done 2026-10-28): broker logins, the Friday momentum
runs, the evening options collection, contract notes, the AlgoTest/Quantiply jobs, backups and
the alert-only maintenance checks. It replaced the one-plist-per-job launchd setup. Every run is
recorded, and missed or failed runs raise a Telegram alert at once. launchd only keeps this
process alive (`deploy/launchd/jobs/com.ai-trading-agent.scheduler.plist`, installed and running
as `com.ai-trading-agent.scheduler`); jobs run from the main
checkout's working tree, so its checked-out branch is the code that runs (the morning
summary flags anything but `main`).

## Layout

- `src/jobs.ts` — **the job registry.** Adding a job means adding an entry here: steps
  (argv, no shell), cwd relative to the repo root, timeout, retries, catch-up window,
  `group` and `needs`, and the `fixHint` that goes into a failure alert.
- `src/schedule.ts` — IST time (fixed UTC+05:30; India has no DST) and schedules. A
  schedule is a time plus a day predicate (`tradingDays`, `onWeekdays(…)`), not a cron
  string, because "trading days" and "first Sunday" are not expressible in cron.
  `tradingDays` comes from `@trading/market-reference`'s `isTradingDay`. `at` may be a list of
  times (BL-234: `contract-notes` runs at 00:00, 07:30, 10:30 and 15:30): each is a slot of
  its own, but the job has one history and `decide()` serves only the latest slot, so a laptop that slept
  through two runs the later one once.
- `src/runner.ts` — runs a job's steps with the repo `.env` parsed in-process (`env.ts`),
  a launchd-safe PATH, per-step timeout, whole-job retries, and logs to
  `<logDir>/<job>/<IST date>.log`. Jobs in the same `group` never overlap: in-process by
  a promise chain, across processes by unfinished rows in the history table.
- `src/chain.ts` + `src/step.ts` — BL-234: a job with a `chain` (a list of `ChainStep`s, `steps` left empty) is a
  chain: each step starts when the one before ends, not at a clock time, and carries what a whole job used to:
  its own `timeoutMinutes`, `retries` / `retryDelayMinutes` / `noRetryExitCodes`, `onFail` (`stop`, the default,
  ends the chain and marks the rest `skipped`; `continue` runs on), `requires` (skipped when a named step did
  not pass; held when it was held), `notBefore` / `notAfter` (`HH:MM` IST: wait for it, or record the step
  `late`, which is no failure), `alertsItself`, `logFile` and `holdId` (the id the stop hold and the pause know
  the step by: set it on every step that uploads, enables or deploys). A chain has NO job-level retries (a
  test pins `retries: 0`). Every step is a row in `run_steps` (`ok`, `failed`, `skipped`, `held`, `late`,
  `carried`, `running`, `unknown`). **Resume:** the loop restarting a slot whose run was cut off
  (`restartIfInterruptedUntil`) resumes that slot by itself; a hand run resumes only with `jobs run <chain> --resume`
  (the runs of today), `--from <step>` (every step before it counts as done) or starts over with `--fresh`. What each
  step LAST came to across those runs decides (`History.priorSteps`: the latest row of a step wins), so a refused
  resume (no step rows) or an Apply now (some) never hides a step that passed, and a step that failed again after
  passing runs again. A step that passed is not run again (`carried`); a step that was `running` when
  the run was cut off is `unknown` (`reapDead`) and a resume REFUSES (exit 4) rather than repeat it, because a
  login sent or an algo enabled must not repeat: say so in the alert, and the owner picks `--from <step>` to run
  it or `--from <the next>` to skip it. The alert (`alertChain`) is ONE message naming each failed or skipped
  step with its own `fixHint`, and what passed; a step that `alertsItself` and really ran is left out. A chain
  takes a step's `group` when it gets to that step and lets it go after the last step that needs it (Phase 3: the
  `evening` chain starts at 15:45 without waiting for the close-out's `quantiply` group, takes it at its first
  AlgoTest step, and lets `catalog` go after `t1-update` for the whole upload stretch; the groups a chain holds now
  are rows in `run_groups`, so another job waits only while one is really held; two jobs that each take one group
  and then want the other's would deadlock, and none does; `groupsOf(job, only)` is every group a run can hold). `jobs run <chain> --only a,b` / `{"only": [...]}` runs just those steps (the dashboard's Apply now:
  the others count as done, no rows, no resume). `step.ts` holds `runStep` (one spawned command,
  its own process group, a timeout) for the runner and the chain.
- `src/history.ts` — `bun:sqlite` run history (`runs` table). Deliberately not the DuckDB
  catalog, so recording a run never competes with a job for its single writer.
- `src/loop.ts` — `bun run jobs serve`: every 30 s, `decide()` each job from the run
  history alone: run a due slot, catch up a slot missed while the laptop slept (within the
  job's `catchUpHours`), or record it as missed and alert. Because it reads history, no
  wake detection is needed. Slots before the scheduler first saw a job are ignored
  (`History.jobFirstSeen`, kept per job in the `meta` table), so a newly added job is
  never reported missed for a slot from before it existed. A new job is seen as of now
  minus its `catchUpHours`, so a slot that only just passed still catches up on the first
  restart; a manual `jobs run` does not count as history. Before its first tick it closes the
  rows a previous scheduler left open (`reapDead`, exit -2, interrupted), but only a row whose
  writer (`pid`) AND whose step's process group (`child_pgid`, recorded by the runner at each
  spawn: steps run detached and outlive a stopped scheduler) are both gone (`rowAlive`); an orphan
  still running keeps its row open. Every tick reaps the same way, so an orphan that ends later is
  closed then (and the trade monitor restarts). An orphan's exit code cannot be read, so even a
  normal exit is recorded as interrupted (-2).
- `src/alerts.ts` — immediate Telegram on failure (skipped for `alertsItself` jobs unless
  they timed out or could not start), on a missed slot, and on recovery. Successes stay
  quiet.
- `src/summary.ts` — the 09:00 trading-day morning summary (builtin job): today's job slots,
  the broker login workflow result (`gh run list`; label "Broker login", and a failure names
  AlgoTest or Quantiply from the run's steps via `gh run view`), Fyers token (`mbt token-status --probe`: the one Fyers check of the morning, which also asks Fyers, so a stale `.env` token fails), whether
  the last trading day's options data is in the lake, disk space, the previous trading day's jobs that
  ran as catch-ups after sleep ("Ran late after sleep", `History.catchUpsBetween`, BL-143; a restart of an
  interrupted run is not one: its slot has an earlier row, the interrupted run, listed as a failure), and failures
  in the last 24 h.
- `src/api.ts` — loopback HTTP API (`127.0.0.1:8790`, `SCHEDULER_API_PORT`) started by
  `serve` in the same process as the loop. `GET /jobs` (each job's schedule, next and last run, its latest slot
  that has come with the row serving it, `previousSlot` / `previousSlotRun` (an open row carries `alive`: its
  writer or its step's process group exists), its longest run `maxRunMinutes` (timeout x steps x attempts, the
  retry delays, one timeout of group wait) and `catchUpHours`: the trade monitor reads these before every platform
  login; dead rows are closed first, `reapDead`), `GET /runs?job=&limit=`,
  `GET /runs/:id/steps` (a chain run's step rows; the Jobs page's Steps panel), `GET /jobs` lists a chain's step ids
  as `chain`, `POST /jobs/:id/run` takes `{"resume": true}`, `{"from": "<step>"}` or `{"fresh": true}` for a chain,
  `GET /runs/:id/log?tail=200` (refuses paths outside the log dir and
  `packages/momentum-backtesting/data`, symlinks resolved), `POST /jobs/:id/run` (manual run;
  202 + run id, 409 if the job or its group is busy), `GET`/`PUT /notifications` (catalogue +
  the prefs file from `@trading/notify`, written atomically), `GET`/`PUT /settings/automation`
  (BL-140, below). The dashboard reaches it through the
  `SCHEDULER_DIRECT` rewrite `/api/scheduler/*`. Never bind it beyond loopback.
- `src/pause.ts` — BL-140 Phase 4: while the settings' pause covers a job's session (the evening jobs prepare the
  next trading session, the morning top-ups and deploys are for today), `PAUSE_JOBS` (= the stop hold's jobs) are
  held by `runJob` and the API's run routes (`pausedReason`, beside `heldReason`); unreadable settings hold them too.
  `quantiply-disable` (a `close-out` step with no `holdId`) and the read-only jobs are never held. A chain step is held by its `holdId`, so the held lists below still name the old job ids (`quantiply-topup`, `quantiply-deploy-topup`). `nextSession` feeds the page's "Skip next session";
  the 09:00 summary says a pause is on (`pauseNotice`).
- `src/automation.ts` — BL-140's automation settings. Three master switches (logins, uploads, deploy) and one
  row per platform + broker (`algotest|quantiply` × `finvasia|angelone`: login, list none/core/t1, upload,
  `multiplier` 1-10, `addon`, `dirBoost` (BL-183: the picked Dir at 2 lots on a non-expiry day), `mtmSl`), a
  `pause.until` day and `capital` (rupees per broker account, `finvasia` / `angelone`, ₹10,000 to ₹10 crore; ₹8.5 lakh
  each before the field, owner 2026-10-29: the evening message's month as a share of capital) and `margin` (BL-205: `bufferPct` 0-50 and `days` 1-30, 10 and 6 before the field: the evening message's margin block), validated (unknown keys
  refused). Versions saved before Phase 4 lack the new fields and read as
  1, yes and no pause (`withDefaults`); before BL-183, `dirBoost` off.
  - Every save is a new version in `scheduler.db` (`automation_settings`). Only the `github` outcome column is
    ever written after the insert.
  - The current version is written atomically to `automation-settings.json` beside it (also on `serve` start);
    that file is what jobs read.
  - A save also sets the repository variables the "Daily broker login" workflow reads (`BROKER_LOGIN_ENABLED`,
    `ALGOTEST_BROKERS`, `QUANTIPLY_BROKERS`, `BROKER_LOGIN_ONLY`, `QUANTIPLY_LOGIN`) through `gh`, so the 08:15
    backstop follows too. A failed sync is recorded on the version, never undoes it.
  - The `.env` switches (`ALGOTEST_UPLOAD`, `QUANTIPLY_UPLOAD`, `ALGOTEST_DEPLOY`, `QUANTIPLY_DEPLOY`) stay as hard
    safety.
- `src/stop-button.ts` + `src/stop-hold.ts` — BL-143 Phase 4, the owner's Telegram "stop everything" button.
  Started by `serve` only with `STOP_BUTTON=on` in the repo-root `.env` (and a valid `TELEGRAM_CHAT_ID`: a private
  chat, never the friends' group `TELEGRAM_ROTATION_CHAT_ID`; else it says why and stays off).
  - The listener long-polls the bot (`getUpdates`, `@trading/notify`). **This process is the bot's ONE
    `getUpdates` consumer: nothing else may poll this bot** (a second poller gets 409, which is alerted once).
  - Only updates whose chat AND sender are `TELEGRAM_CHAT_ID` count; everything else is ignored and logged.
  - `/stop` and the 09:00 morning summary (`withStopOffer`, `builtins.ts`) offer `stop:ask:<day>` (that day only).
    Its tap runs `packages/broker-login/src/stop-button.ts --plan` (no login) and sends the plan with
    `stop:go:<nonce>` / `stop:no:<nonce>`: in memory, 2 minutes, once; a second tap on the offer while it is valid
    re-sends the same nonce.
  - Only `stop:go` acts: `stop-button.ts --apply` runs (log in `<logDir>/stop-button/`). Exit 0 / 3: the runner
    reported; 2: "did NOTHING: <the runner's REFUSED line>" (STOP_BUTTON off), or, while another stop runs, "did
    nothing new: <its REFUSED line, with the marker path>. The hold stays on"; 4: "the
    report could not be delivered"; anything else (killed, timed out): "square-offs may already be in flight:
    open AlgoTest /live and Quantiply before acting at the broker".
  - The hold (`TRADING_DATA_ROOT/stop/HOLD.json` and `<SCHEDULER_STATE_DIR>/stop-hold.json`, written by the runner
    before it squares off; either holds; and this process's memory from the confirm tap, the fallback when no file
    could be written, lifted by a Resume, or by a refused runner only when that same tap set it and no other stop is
    running) lasts until the owner lifts it: `/resume` or the morning message's Resume button, then `stop:rgo:<nonce>` (same rules), runs
    `stop-button.ts --clear-hold`. While it is on, the 09:00 message says so every day.
  - `runJob` refuses every `STOP_HELD_JOBS` run (the uploads, deploys and enables) while the hold is on, however
    it was started (schedule, catch-up, `jobs run`, Apply now, queued behind its group): the run is recorded with
    exit 0, no attempts and the reason, and is not caught up later; held before a retry, the earlier attempt's
    failure stays the result. `POST /jobs/:id/run` answers 409. The memory hold covers this process only;
    `jobs run` in another process sees the files. `quantiply-disable` is never held. Every tap is a line in
    `TRADING_DATA_ROOT/stop/<day>.jsonl`.
  - While the runner works, `stop-running.json` (`{pid, at}`) sits beside each hold copy; jobs that log in to the
    brokers (the loss / deploy monitor) skip their logins while it is there, its pid is alive and it is fresh
    (`otherStopRunning` in `packages/broker-login/src/stop-hold.ts`: under 20 minutes old and from today, IST).
- `src/cli.ts` — `bun run jobs status | run <id> | serve | settings [show | set <file.json>]`.

## Adding a check

A check looks for a slow-burning problem and **never changes data** (alert only). Put it in
its group's file under `src/checks/` (`drift`, `calendar`, `stock`, `credentials`, `digest`):
export `jobs` (use `checkJob({...})` from `checks/types.ts` for the shared defaults) and
`builtins` (wrap the function in `checkBuiltin(...)`). A problem makes the job exit 1 with the
detail as its error, so the normal failure alert goes out with the job's `fixHint`; the job runs
daily, so an unfixed problem repeats at most once a day. Inject anything that touches the
network or disk so the test needs neither. One group per file keeps parallel PRs from clashing.

**Suites (BL-234).** The daily checks run as two jobs, not one each: `morning-checks` (trading days
08:30) and `evening-checks` (17:00), listed in `checks/index.ts` (`SUITES`). A check named there stays
defined in its module (description, fix hint, retries are read from it) but is not scheduled on its
own; to add a daily check to a suite, add its id to that list. A suite (`checkSuite` in `checks/types.ts`)
runs every member and never stops at a problem; a member with `retries` is retried alone, after its
delay, so the others run once; the result is ONE failure that names each problem with its own fix, so a
bad morning is one Telegram message. A check that fires only on its own day (`margin-reminder`,
`credential-rotation-reminder`) or does real work (`weekly-digest`) stays a job of its own. Run a suite
by hand with `bun run jobs run morning-checks`.

What each file holds (BL-012 inventory numbers): `drift` S1 Nifty 50 list, S2 lot sizes, Y4
`check-expiry-calendar` (the Fyers NSE + BSE masters' listed option expiries against
`expiry_calendar.csv`, holiday shifts from `holidays.csv`, years with no holiday rows skipped,
and the nearest expiry's commonest strike gap against `strike_step.csv`); `calendar` Y1
holidays, Y2 RBI dates, M3 margin, Y3 `check-blocked-dates` (`.env`'s `BLOCKED_DATES` from
`ctx.env`); `stock` M2, W3, S3 `universe-refresh-reminder` (the category CSVs' modification
day against the last 1 Apr / 1 Oct, and this year's rows; `MOMENTUM_DATA_DIR` honoured);
`credentials`; `digest`.

## Gotchas

- Tests use `bun test`, not vitest, because `bun:sqlite` only exists under Bun.
- `group: 'catalog'` is for anything that writes the DuckDB catalog (`TRADING_DATA_ROOT`).
- `group: 'quantiply'` holds the Quantiply jobs (upload, enable, disable), so an enable runs after the upload
  before it, retries included (`morning-open`'s steps (BL-234 Phase 4) take it at the first Quantiply step; the
  `morning-topup` chain runs the 09:19 top-up, then its enable, in order; the `close-out` chain (15:30) holds the
  switch-off and the live capture; the `evening` chain's Quantiply upload steps wait for both). It does not space their TOTP logins (the next job
  starts the moment one ends): `packages/broker-login/src/quantiply-session.ts` waits out the last window each
  account typed a code in (a file stamp), and the deployer retries a refused code once. The enables have
  `retries: 0` like the `morning-open` activation: a second attempt could act on a half-finished first. `quantiply-disable`
  is the safety net and runs whatever `QUANTIPLY_DEPLOY` and the deploy switch say.
- `morning-open` (BL-234 Phase 4, trading days 08:00) is the morning as one chain, replacing the four clock-chained jobs
  the former `angel-login-check` (08:00), `broker-login` (08:02), `quantiply-deploy` (08:10) and `algotest-activate` (08:11) jobs;
  `options-rotation-pick` (08:45) and `morning-summary` (09:00) stay fixed-time jobs (owner, 2026-11-18). Owner's
  order: **Quantiply is switched on first (about 08:06), before AlgoTest's 08:16 window**, and its one Telegram message
  goes once at the end (about 08:20; 2026-11-19). Steps (`jobs.ts` is the one place that lists times, timeouts and
  fixes): `angel-check` (`obt angel test --scheduled`: never stops the rest, no retry (the old 5-minute retry only
  helped a blip and would hold Quantiply back), not after 09:10) → `quantiply-login` (`local-login.ts --part
  quantiply`: Quantiply · Angel One and Kite; not after 15:00, the old `broker-login` window) → `quantiply-deploy`
  (Quantiply · Angel One's account, REAL MONEY; `requires` that login; held as `quantiply-deploy`; not after 09:05, the
  09:19 `morning-topup` chain is the net) → `quantiply-deploy-shoonya` (the same for Shoonya's account; no `requires`,
  so one failed Angel One login does not leave it off; the same `holdId`) →
  `algotest-login` (`--part algotest`: the AlgoTest brokers, then Quantiply · Shoonya; `notBefore` 08:16, not after
  15:00) → `algotest-catch-up` (a list switched in after 16:40 is exported, uploaded and set up first; never fails;
  held as `algotest-activate`; not after 12:40) → `algotest-activate` (REAL MONEY; no `requires`: the old 08:11 job did
  not depend on the login, `--part algotest` exits 1 when only one broker, or only Quantiply · Shoonya, failed, and
  `strategy-deploy --morning` reports each broker not logged in; not after 12:40) →
  `morning-message` (`morning-report.ts --chain`: the login line and each Quantiply account's report, or "switch-on
  not run"). Failure policy: a failed check stops nothing; a failed Quantiply · Angel One login skips only that
  account's switch-on; a failed AlgoTest login skips nothing. Every login and activation step has NO retries (a refused PIN sent
  again locks an account; a second activation double-activates) and a step cut off mid-run is `unknown`, so a resume
  refuses (exit 4) and the owner decides with `--from`. A step past its `notAfter` is `late` and, with `alertLate`, the
  run counts it as a problem and the one alert names it (it is never waited for); the chain's `catchUpHours` is the
  old login window (7 h), each step has its own limit. The `quantiply` group is taken at the first Quantiply step and
  let go after the last step that needs it (`algotest-activate`), the span the old jobs held it (other chains still use it). The stop hold and the pause hold the
  `quantiply-deploy` and `quantiply-deploy-shoonya` (as `quantiply-deploy`), `algotest-catch-up` and `algotest-activate` steps under their old job ids (`holdId`); the logins
  and the message are never held. Each login part records its own body under `parts` in `<state>/broker-login/<day>.json`
  (the file's top level is them combined, which the 09:00 summary and the message read), hands only its own failures
  to GitHub, and the last asked part sets `LOCAL_LOGIN_DONE` (a part that failed sets it at once, so a refused PIN is
  not sent again by the backstop). The Quantiply login waits for the next 30-second TOTP window before its first
  Angel One code, because the check ran on the same seed seconds before. `jobs run morning-open --dry-run [--at HH:MM]`
  prints the order, the 08:16 wait and any hold or late skip without starting anything (`chain-plan.ts`; steps taken as
  instant). The check's refusal hold: `obt angel test --scheduled` waits out a login in flight and the 60 s cool-down; a
  login Angel One refused is not sent again for 15 minutes with the same settings. `broker-login`'s GitHub run logs in
  to Angel One too (AlgoTest's Angel One login from 08:15 unless BROKER_LOGIN_ONLY=finvasia, and Quantiply's when
  QUANTIPLY_LOGIN is on), where this chain's hold can't see it. The 09:00 summary reads the status file first, GitHub's
  runs only when the Mac did not run or handed parts over.
- `trade-monitor` (BL-143, trading days 09:04, `packages/broker-login/src/trade-monitor.ts`) runs all
  session long under `caffeinate -i`, so it is not in the `quantiply` group (it would hold the 09:19 /
  09:21 top-ups all day). It makes no login and holds no session 09:10-09:25, and none on a platform after that
  while a job that logs in to that platform runs (`GET /jobs` before every login, at any hour; a due one
  blocks until 10:00 / 17:30); every platform login
  (its own, the uploaders', the deployers') takes the cross-process login lock. It alerts itself
  (`alertsItself`), including every failure exit and a crash; its state file stops a retry repeating
  a message; exit 3 (a refused or held Quantiply login, or another monitor running) is not retried.
  `restartIfInterruptedUntil: '15:25'` (a `Job` field, read by `loop.decide`): a run cut off by a
  scheduler or laptop restart (reaped as interrupted, exit -2, by `startLoop` before its first tick) is
  started again while the session lasts; every other job treats an interrupted slot as served. Each part waits for its `.env` switch.
- `mcx-forward-spread` (BL-219, weekdays 18:00, `obt mcx-forward spread`) and `mcx-forward-score`
  (Tue-Sat 01:30, `obt mcx-forward score`, group `catalog`, exit 2 not retried) run the gold Dir
  forward paper test: the 18:00 job reads live quotes (read-only) and does nothing outside a gold
  expiry window (the last five sessions before an option expiry from 2026-11-27); the 01:30 job
  scores the evening just held (`default_session`: at 01:30 that is yesterday's) after the 23:31
  collector, journaling it and sending one private Telegram line. Neither places an order.
- `momentum-journal-score` (BL-024, Fri 20:30, `mbt journal score`) sits between the 19:30
  stock-ingest run (which records the week's journal rows and prices it scores against) and the
  21:00 journal check, in the `catalog` group so it waits for a late 19:30 run. It re-runs every
  scored favourite on today's code (one engine pass each, cached rankings), writes only
  `forward_scores.json` in the momentum state dir and sends nothing: the headline's score line is
  added to its 19:30 message, so the scheduler's own failure alert is the only Telegram it causes.
- `momentum-history` (BL-001 Phase 4, Fri 22:00) runs `mbt verify history --send`: read-only on the catalog,
  but in the `catalog` group because DuckDB will not open a read-only connection while another process
  writes. It `alertsItself`: a restated history is its own Telegram and exits 0 once Telegram took it (like
  `momentum-live-rules` on a breach), so the scheduler does not alert twice; an undelivered one exits 1 (the
  retry sends it again, the Jobs page shows it red), as does a check that cannot run (also sent by the command).
  Like every `alertsItself` job, an exit the command never reached (a `uv` environment that will not build)
  is silent apart from the Jobs page, unless it is 124 or 127.
- The scheduler reads `jobs.ts` once at start: a new or changed job needs a restart of the
  service (`launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`, see
  `deploy/launchd/README.md`).

## Commands

```bash
bun run jobs status          # every job: schedule, last run, next run
bun run jobs run <job-id>    # run one now (recorded as manual)
bun run jobs run <chain> --resume          # BL-234: today's earlier run's steps that passed are not run again
bun run jobs run <chain> --from <step-id>  # start at a step; the steps before it count as done
bun run jobs run <chain> --fresh           # ignore an earlier run
bun run jobs run evening --only algotest-export,algotest-upload,algotest-setup   # just those steps (Apply now)
bun run jobs serve           # the long-running scheduler
bun run jobs settings        # the current automation settings (BL-140); `settings set <file.json>` saves a version
bun run test                 # bun test
bun run typecheck
```

State: `SCHEDULER_STATE_DIR` (default `~/Library/Application Support/ai-trading-agent`,
holds `scheduler.db` and `automation-settings.json`). Logs: `SCHEDULER_LOG_DIR` (default `~/Library/Logs/ai-trading-agent`).
