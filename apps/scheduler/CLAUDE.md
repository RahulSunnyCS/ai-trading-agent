# CLAUDE.md

Guidance for coding agents working in `apps/scheduler` (`@ata/scheduler`).

## What this app does

One home for every recurring job (BL-012): broker logins, the Friday momentum runs and,
in later PRs, the evening options collection, backups and maintenance checks. It replaces
the one-plist-per-job launchd setup. Every run is recorded, and missed or failed runs
raise a Telegram alert at once. launchd only keeps this process alive
(`deploy/launchd/jobs/com.ai-trading-agent.scheduler.plist`); jobs run from the main
checkout's working tree, so its checked-out branch is the code that runs (the morning
summary flags anything but `main`).

## Layout

- `src/jobs.ts` — **the job registry.** Adding a job means adding an entry here: steps
  (argv, no shell), cwd relative to the repo root, timeout, retries, catch-up window,
  `group` and `needs`, and the `fixHint` that goes into a failure alert.
- `src/schedule.ts` — IST time (fixed UTC+05:30; India has no DST) and schedules. A
  schedule is a time plus a day predicate (`tradingDays`, `onWeekdays(…)`), not a cron
  string, because "trading days" and "first Sunday" are not expressible in cron.
  `tradingDays` comes from `@trading/market-reference`'s `isTradingDay`.
- `src/runner.ts` — runs a job's steps with the repo `.env` parsed in-process (`env.ts`),
  a launchd-safe PATH, per-step timeout, whole-job retries, and logs to
  `<logDir>/<job>/<IST date>.log`. Jobs in the same `group` never overlap: in-process by
  a promise chain, across processes by unfinished rows in the history table.
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
  `GET /runs/:id/log?tail=200` (refuses paths outside the log dir and
  `packages/momentum-backtesting/data`, symlinks resolved), `POST /jobs/:id/run` (manual run;
  202 + run id, 409 if the job or its group is busy), `GET`/`PUT /notifications` (catalogue +
  the prefs file from `@trading/notify`, written atomically), `GET`/`PUT /settings/automation`
  (BL-140, below). The dashboard reaches it through the
  `SCHEDULER_DIRECT` rewrite `/api/scheduler/*`. Never bind it beyond loopback.
- `src/automation.ts` — BL-140's automation settings. Three master switches (logins, uploads, deploy) and one
  row per platform + broker (`algotest|quantiply` × `finvasia|angelone`: login, list none/core/t1, upload),
  validated (unknown keys refused).
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

## Gotchas

- Tests use `bun test`, not vitest, because `bun:sqlite` only exists under Bun.
- `group: 'catalog'` is for anything that writes the DuckDB catalog (`TRADING_DATA_ROOT`).
- `group: 'quantiply'` holds the Quantiply jobs (upload, enable, disable), so an enable runs after the upload
  before it, retries included (`quantiply-deploy` 16:55 waits for `quantiply-evening` 16:45;
  `quantiply-deploy-topup` 09:21 for `quantiply-topup` 09:19). It does not space their TOTP logins (the next job
  starts the moment one ends): `packages/broker-login/src/quantiply-session.ts` waits out the last window each
  account typed a code in (a file stamp), and the deployer retries a refused code once. The enables have
  `retries: 0` like `algotest-deploy`: a second attempt could act on a half-finished first. `quantiply-disable`
  is the safety net and runs whatever `QUANTIPLY_DEPLOY` and the deploy switch say.
- `broker-login` has `retries: 0` on purpose: `dispatch.ts` retries itself and must never
  dispatch the GitHub workflow twice.
- `angel-login-check` (trading days 08:00) runs `obt angel test --scheduled`: one Angel One
  SmartAPI login through the same guard as the dashboard's Test connection and the collector
  (one login at a time, 60 s cool-down). Its single retry is 5 minutes later, past its own
  cool-down, and a login Angel One refused is not re-sent for 15 minutes with the same settings,
  so the retry only helps a network blip. The check re-reads the `ANGELONE_*` keys from `.env`
  itself, so the scheduler's start-time snapshot of `.env` does not matter for it. The scheduler
  sends the failure alert (the job does not alert itself). `broker-login`'s GitHub run logs in
  to Angel One too (AlgoTest's Angel One login from 08:15 unless BROKER_LOGIN_ONLY=finvasia, and
  Quantiply's at about 08:02 when QUANTIPLY_LOGIN is on), where this job's hold can't see it;
  see the comment on the job in `jobs.ts`.
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
- The scheduler reads `jobs.ts` once at start: a new or changed job needs a restart of the
  service (`launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`, see
  `deploy/launchd/README.md`).

## Commands

```bash
bun run jobs status          # every job: schedule, last run, next run
bun run jobs run <job-id>    # run one now (recorded as manual)
bun run jobs serve           # the long-running scheduler
bun run jobs settings        # the current automation settings (BL-140); `settings set <file.json>` saves a version
bun run test                 # bun test
bun run typecheck
```

State: `SCHEDULER_STATE_DIR` (default `~/Library/Application Support/ai-trading-agent`,
holds `scheduler.db` and `automation-settings.json`). Logs: `SCHEDULER_LOG_DIR` (default `~/Library/Logs/ai-trading-agent`).
