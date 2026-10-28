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
| `live-capture` | 15:40 trading days; one attempt, 8-minute limit, so `quantiply-disable` starts by 15:48 (catch-up 6 h) | `live-capture.ts --soft-fail` (BL-141): for each platform + broker the automation settings have on, every strategy that ran today on AlgoTest and Quantiply, the tool's or the owner's own (discretionary), with live ₹, multiplier and fills, to `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`; also back-fills the last 5 trading days that miss a section. GET calls only. In the `quantiply` group, ahead of `quantiply-disable`. The evening uploads do not wait for it: both platforms keep a day's results after its strategies are deleted |
| `live-capture-retry` | 15:55 trading days; retried twice, 8 minutes apart, done by about 16:30 (catch-up 6 h) | `live-capture.ts --no-backfill`: reads only the sections today's file does not have as read (no login to an account already read; nothing to read = no login at all). Alerts once if the day is still not captured; the next evening's 15:40 run back-fills it. Same group |
| `quantiply-disable` | 15:40 trading days; retried twice, 5 minutes apart (catch-up to 23:40) | `quantiply-deploy.ts --mode disable --apply` per Quantiply account (BL-139 Phase 4): switches off the uploader's algos for today that are still enabled, and any of an earlier session, so they do not run again next week; only finished ones; re-reads the list to confirm. Before the 16:45 upload (same `quantiply` group), which can then delete them. The safety net: it always runs, whatever `QUANTIPLY_DEPLOY` and Automated deployment say |
| `quantiply-deploy` | 16:55 trading days; never retried (catch-up 6 h) | `quantiply-deploy.ts --mode enable --apply` per account: enables the next session's picks the 16:45 upload made (it waits for that job and its retries), each read back and set to the account's broker first; re-reads the list to confirm. REAL MONEY. Needs `QUANTIPLY_DEPLOY=on`, Automated deployment and the account's row |
| `quantiply-deploy-topup` | 09:21 trading days; never retried (catch-up 3 h) | The same for today after the 09:19 top-up: enables a pick 09:16 changed and switches off an enabled one it dropped, never an algo within 90 s of its start (TOO LATE, reported) |
| `backup` | 1st Sunday of the month 10:00 (catch-up all week) | `tdata backup` to `/Volumes/RAHUL'S SSD/TradingData`; to `~/Downloads/TradingData-backup` with a Telegram warning when the SSD isn't plugged in |
| `kite-login-reminder` | Fri 13:30 (catch-up 30 min) | `mbt kite remind --send`: when Kite is the Momentum holdings source and today has no valid Kite login, a Telegram reminder to log in before the 14:15 orders (BL-142); silent otherwise |
| `momentum-preview` / `-final` | Fri 14:40 / 16:45 | `mbt weekly --run preview|final` |
| `momentum-stock-ingest` | Fri 19:30 | `mbt stocks sync`, then the stock/Custom Index/Broad final (needs the GUI session) |
| `momentum-journal-check` | Fri 21:00 | `mbt journal check --send` |
| `momentum-live-rules` | Fri 21:30 | `mbt live-rules check --send` |
| `momentum-history` | Fri 22:00 | `mbt verify history --send` (BL-001 Phase 4): names any stored history up to the anchor Friday that changed; a change is its own Telegram and exits 0 once delivered |

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
- **The stop button (BL-143 Phase 4) lives in this process.** With `STOP_BUTTON=on` in the
  repo-root `.env` (and a restart: `launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`),
  the scheduler long-polls the Telegram bot and is its only `getUpdates` consumer: nothing else
  may poll the bot. While the scheduler is down (laptop asleep or off) the button does not
  answer; do the stop by hand then (Quantiply's square off & terminate, algotest.in/live's
  Square Off). A confirmed stop holds the tool **until it is lifted** (Telegram's Resume, or
  `cd packages/broker-login && node_modules/.bin/tsx src/stop-button.ts --clear-hold`): no
  `algotest-*` upload or deploy and no `quantiply-*` upload or enable runs, however it is
  started (`jobs status` shows those slots as ok, held). The hold is the file
  `TRADING_DATA_ROOT/stop/HOLD.json` or its copy `stop-hold.json` in the scheduler's state
  folder; if neither could be written, only the running scheduler holds it, in memory, and
  a restart lifts it: the stop's report then says HOLD NOT SAVED. `quantiply-disable` still runs. A slot
  the hold refused is not caught up: run it by hand after lifting the hold.

## Wake schedule (BL-143)

On 2026-10-19 the 16:40 / 16:45 uploads ran at 20:27, as catch-ups, because the laptop slept.
The morning summary now lists the previous trading day's jobs that ran late like that ("Ran late
after sleep"). Keeping the laptop awake is a macOS power setting, so **the owner runs these**; no
job or script in the repo changes them.

1. **The morning wake.** `pmset repeat` keeps one repeating wake, so pick one time:

   ```bash
   sudo pmset repeat wakeorpoweron MTWRF 07:55:00   # recommended: the 08:00 jobs run on time
   sudo pmset repeat wakeorpoweron MTWRF 08:50:00   # BL-143's first suggestion: wake for the 09:00-09:25 jobs only;
                                                    # the 08:00 broker login and Angel One check then run as catch-ups at ~08:50
   pmset -g sched                                   # check what is set
   ```

2. **An optional second wake for the evening jobs** (16:40 AlgoTest upload, 16:45 Quantiply
   upload, 16:55 Quantiply enable). `pmset repeat` cannot hold a second wake; `pmset schedule`
   adds one-off ones, so schedule the next four weeks' weekdays in one go (re-run monthly):

   ```bash
   for d in $(seq 0 27); do
     day=$(date -v+${d}d +%u)                      # 1-5 = Mon-Fri
     [ "$day" -le 5 ] && sudo pmset schedule wake "$(date -v+${d}d +%m/%d/%y) 16:35:00"
   done
   pmset -g sched
   ```

3. **Staying awake once woken.** A scheduled wake does not stop the Mac going back to sleep at
   its idle timer, and a closed lid on battery always sleeps. On the power adapter, System
   Settings › Battery › Options › "Prevent automatic sleeping on power adapter when the display
   is off" keeps it awake. The `trade-monitor` job (09:04-15:30) holds `caffeinate -i` while it
   runs, so the Mac does not idle-sleep during the session; that assertion ends with the job and
   changes no setting.

**Done when** a trading day's 16:40 job runs at 16:40 (the next morning summary has no "Ran late
after sleep" line).
