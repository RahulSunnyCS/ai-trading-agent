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
  wake detection is needed. Slots before the scheduler's first start are ignored.
- `src/alerts.ts` — immediate Telegram on failure (skipped for `alertsItself` jobs unless
  they timed out or could not start), on a missed slot, and on recovery. Successes stay
  quiet.
- `src/summary.ts` — the 09:00 trading-day morning summary (builtin job): today's job slots,
  the AlgoTest workflow result (`gh run list`), Fyers token (`mbt token-status`), whether
  the last trading day's options data is in the lake, disk space, and failures in the last
  24 h.
- `src/api.ts` — loopback HTTP API (`127.0.0.1:8790`, `SCHEDULER_API_PORT`) started by
  `serve` in the same process as the loop. `GET /jobs`, `GET /runs?job=&limit=`,
  `GET /runs/:id/log?tail=200` (refuses paths outside the log dir and
  `packages/momentum-backtesting/data`, symlinks resolved), `POST /jobs/:id/run` (manual run;
  202 + run id, 409 if the job or its group is busy), `GET`/`PUT /notifications` (catalogue +
  the prefs file from `@trading/notify`, written atomically). The dashboard reaches it through the
  `SCHEDULER_DIRECT` rewrite `/api/scheduler/*`. Never bind it beyond loopback.
- `src/cli.ts` — `bun run jobs status | run <id> | serve`.

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
- `broker-login` has `retries: 0` on purpose: `dispatch.ts` retries itself and must never
  dispatch the GitHub workflow twice.

## Commands

```bash
bun run jobs status          # every job: schedule, last run, next run
bun run jobs run <job-id>    # run one now (recorded as manual)
bun run jobs serve           # the long-running scheduler
bun run test                 # bun test
bun run typecheck
```

State: `SCHEDULER_STATE_DIR` (default `~/Library/Application Support/ai-trading-agent`,
holds `scheduler.db`). Logs: `SCHEDULER_LOG_DIR` (default `~/Library/Logs/ai-trading-agent`).
