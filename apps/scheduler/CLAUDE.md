# CLAUDE.md

Guidance for coding agents working in `apps/scheduler` (`@ata/scheduler`).

## What this app does

One home for every recurring job (BL-012): broker logins, the Friday momentum runs and,
in later PRs, the evening options collection, backups and maintenance checks. It replaces
the one-plist-per-job launchd setup. Every run is recorded, and missed or failed runs
will raise Telegram alerts (catch-up and alerts land in BL-012 PR 4; until the launchd
cut-over in PR 5, the old plists still do the scheduling).

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
- `src/cli.ts` — `bun run jobs status`, `bun run jobs run <id>`.

## Gotchas

- Tests use `bun test`, not vitest, because `bun:sqlite` only exists under Bun.
- `group: 'catalog'` is for anything that writes the DuckDB catalog (`TRADING_DATA_ROOT`).
- `broker-login` has `retries: 0` on purpose: `dispatch.ts` retries itself and must never
  dispatch the GitHub workflow twice.

## Commands

```bash
bun run jobs status          # every job: schedule, last run, next run
bun run jobs run <job-id>    # run one now (recorded as manual)
bun run test                 # bun test
bun run typecheck
```

State: `SCHEDULER_STATE_DIR` (default `~/Library/Application Support/ai-trading-agent`,
holds `scheduler.db`). Logs: `SCHEDULER_LOG_DIR` (default `~/Library/Logs/ai-trading-agent`).
