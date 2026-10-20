# Laptop scheduler (launchd)

One LaunchAgent, `com.ai-trading-agent.scheduler`, keeps the scheduler running
(`apps/scheduler`, BL-012). The jobs themselves — times, commands, retries,
catch-up windows — live in [`apps/scheduler/src/jobs.ts`](../../apps/scheduler/src/jobs.ts),
not in plists. See [`apps/scheduler/CLAUDE.md`](../../apps/scheduler/CLAUDE.md).

| Job | When (IST) | What |
|---|---|---|
| `broker-login` | 08:00 trading days | Triggers the "Daily broker login" GitHub workflow (`packages/broker-login/src/dispatch.ts`); GitHub's own late cron stays as a backstop |
| `morning-summary` | 09:00 trading days | One Telegram message: logins, Fyers token, last options day collected, checkout branch, disk, last-24h failures |
| `options-evening` | 15:45 trading days; retried 17:15, 18:45 and 20:15 (catch-up to 23:00) | Five steps, stopping at the first failure: `obt daily` (collect the day's 1-minute option data from Fyers when its token works, else Angel One, BL-079; judge it, build its derived tables, run every leg-wise strategy, Telegram the summary), `obt rotation update` (all 298 rotation variants over the day, BL-058), `tdata derived rebuild` (any derived day still unbuilt), then `obt rotation update --track t1 --soft-fail` (the T1 track's 223 variants, BL-125; a T1 failure Telegrams its own alert and exits 0, so it never fails or retries this job), then `obt rotation result --not-before 16:00 --soft-fail` (a no-op before 16:00; on a late retry it sends the result at once, because a failed 16:00 slot is never caught up; markers prevent a double send) |
| `options-rotation-result` | 16:00 trading days; retried every 5 minutes to 16:35 (catch-up to 22:00) | `obt rotation result --wait-until 16:25` (BL-125): one Telegram message with the day's one-lot net paper gain for Adaptive and T1 and tomorrow's strategies in full, to the owner; the Option signals group gets Adaptive's part. Nothing is sent while the evening run's results are incomplete (exit 2, retried); at 16:25 it sends what exists and T1 follows on its own. Per-destination sent markers and a per-day lock make retries and overlapping runs safe; a T1 that cannot be read never holds Adaptive's result back |
| `options-rotation-t1-update` | 21:00 trading days (catch-up to 23:30) | Catch-up for the T1 track: `obt rotation result --soft-fail` first (sends anything still owed, never fails the job), then a strict `obt rotation update --track t1` (a failure fails the job, so its retries at 22:00 and 23:00 try again), then `obt rotation result`, which sends T1's part if it was not ready at 16:00 and is a no-op otherwise |
| `options-rotation-pick` | 09:16 trading days (no catch-up) | `obt rotation pick --with-t1`: record lists A, B, C and REF before 09:17, hash-chained, then the T1 track in its own journal, the group gets Adaptive alone as soon as it is recorded; the owner gets one message with Adaptive then T1, waiting for T1 until 09:16:50 at most (20 s after Adaptive's entry on a later run), else Adaptive alone and T1 follows on its own (BL-058, BL-125) |
| `quantiply-disable` | 15:40 trading days; retried twice, 5 minutes apart (catch-up to 23:40) | `quantiply-deploy.ts --mode disable --apply` per Quantiply account (BL-139 Phase 4): switches off the uploader's algos for today that are still enabled, and any of an earlier session, so they do not run again next week; only finished ones; re-reads the list to confirm. Before the 16:45 upload (same `quantiply` group), which can then delete them. Off until `QUANTIPLY_DEPLOY=on` |
| `quantiply-deploy` | 16:55 trading days; never retried (catch-up 6 h) | `quantiply-deploy.ts --mode enable --apply` per account: enables the next session's picks the 16:45 upload made (it waits for that job and its retries), each read back and set to the account's broker first; re-reads the list to confirm. REAL MONEY. Needs `QUANTIPLY_DEPLOY=on`, Automated deployment and the account's row |
| `quantiply-deploy-topup` | 09:21 trading days; never retried (catch-up 3 h) | The same for today after the 09:19 top-up: enables a pick 09:16 changed and switches off an enabled one it dropped, never an algo within 90 s of its start (TOO LATE, reported) |
| `backup` | 1st Sunday of the month 10:00 (catch-up all week) | `tdata backup` to `/Volumes/RAHUL'S SSD/TradingData`; to `~/Downloads/TradingData-backup` with a Telegram warning when the SSD isn't plugged in |
| `kite-login-reminder` | Fri 13:30 (catch-up 30 min) | `mbt kite remind --send`: when Kite is the Momentum holdings source and today has no valid Kite login, a Telegram reminder to log in before the 14:15 orders (BL-142); silent otherwise |
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
