# Laptop scheduler (launchd)

One LaunchAgent, `com.ai-trading-agent.scheduler`, keeps the scheduler running
(`apps/scheduler`, BL-012). The jobs themselves — times, commands, retries,
catch-up windows — live in [`apps/scheduler/src/jobs.ts`](../../apps/scheduler/src/jobs.ts),
not in plists. See [`apps/scheduler/CLAUDE.md`](../../apps/scheduler/CLAUDE.md).

| Job | When (IST) | What |
|---|---|---|
| `broker-login` | 08:00 trading days | Triggers the "Daily broker login" GitHub workflow (`packages/broker-login/src/dispatch.ts`); GitHub's own late cron stays as a backstop |
| `fyers-login` | 08:05 trading days | Headless Fyers login, token stored in `broker_tokens` (needs Postgres) |
| `morning-summary` | 09:00 trading days | One Telegram message: logins, Fyers token, last options day collected, checkout branch, disk, last-24h failures |
| `options-daily` | 16:15 trading days, retried 17:45 and 19:15 | `obt daily`: collect the day's 1-minute option data (expiring contracts are gone tomorrow; the nearest and next index futures too), judge the day (`data_quality`), build its derived 5-minute snapshots and IV, run every leg-wise strategy; Telegram summary with the day's verdicts and IV percentile |
| `options-rotation-nightly` | 19:45 trading days (retries to 23:00) | `obt rotation update`: run all 248 rotation variants over the day's data and store the results (BL-058; same `catalog` group as `options-daily`) |
| `options-rotation-pick` | 09:16 trading days (no catch-up) | `obt rotation pick`: record lists A, B, C and REF before 09:17, hash-chained, and Telegram them (BL-058) |
| `options-derived` | 23:30 trading days | `tdata derived rebuild`: catch up any derived day the evening run left unbuilt (lock-free) |
| `backup` | 1st Sunday of the month 10:00 (catch-up all week) | `tdata backup` to `/Volumes/RAHUL'S SSD/TradingData`; to `~/Downloads/TradingData-backup` with a Telegram warning when the SSD isn't plugged in |
| `momentum-preview` / `-final` | Fri 14:40 / 16:45 | `mbt weekly --run preview|final` |
| `momentum-stock-ingest` | Fri 19:30 | `mbt stocks sync`, then the stock/Custom Index/Broad final (needs the GUI session) |
| `momentum-journal-check` | Fri 21:00 | `mbt journal check --send` |
| `momentum-live-rules` | Fri 21:30 | `mbt live-rules check --send` |

Failures and missed runs reach Telegram immediately; successes only appear in the morning
summary.

## The data-root mount agent

`com.ai-trading-agent.trading-data-mount` is a second LaunchAgent, deliberately **not** a
scheduler job: the scheduler's own jobs read and write the research database, so the volume
holding it must be attached first. `TRADING_DATA_ROOT` is `/Volumes/TradingData`, an APFS disk
image on the external SSD (BL-034). The agent runs `tdata mount` (idempotent: already mounted is
a no-op) at login and whenever a volume appears under `/Volumes`, so plugging the SSD in is
enough. With the SSD unplugged it logs why (`~/Library/Logs/ai-trading-agent/trading-data-mount.log`)
and every reader and writer refuses the unmounted root instead of writing elsewhere. It needs
`TRADING_DATA_ROOT` and `TRADING_DATA_IMAGE` in the repo `.env`; `install.sh` installs it with
the scheduler.

## Commands

```bash
deploy/launchd/install.sh                                    # install; also retires the old per-job plists
bun run --filter @ata/scheduler jobs status                  # every job: last run, next run
bun run --filter @ata/scheduler jobs run <job>               # run one now
launchctl print gui/$(id -u)/com.ai-trading-agent.scheduler  # loaded? running?
tail -f ~/Library/Logs/ai-trading-agent/scheduler.log
deploy/launchd/uninstall.sh
```

## Things to know

- Moving to a Mac mini: see [`docs/mac-mini.md`](../../docs/mac-mini.md).

- **Install before 07:55 on a trading day**, or run what `install.sh` lists afterwards. The
  scheduler never runs a slot that fell before its first start (those belonged to the old
  plists, which `install.sh` removes), so installing at 08:03 would otherwise skip that
  day's broker-login. `install.sh` prints the slots that are already past, with the command
  to run each (`bun run --filter @ata/scheduler jobs skipped` shows the same).

- **Jobs run from `~/Projects/ai-trading-agent`'s working tree**, so whatever branch is
  checked out there is the code that runs. The morning summary flags a branch other than
  `main`. Restart after pulling a scheduler change:
  `launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`.
- **Asleep at a job's time:** the scheduler catches the slot up on wake if it is still
  within that job's catch-up window, otherwise it alerts that the run was missed.
- **Off:** nothing runs. To wake or power on the Mac before 08:00 on weekdays:
  `sudo pmset repeat wakeorpoweron MTWRF 07:55:00`.
