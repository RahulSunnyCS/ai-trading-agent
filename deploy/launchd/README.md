# Laptop scheduler (launchd)

One LaunchAgent, `com.ai-trading-agent.scheduler`, keeps the scheduler running
(`apps/scheduler`, BL-012). The jobs themselves — times, commands, retries,
catch-up windows — live in [`apps/scheduler/src/jobs.ts`](../../apps/scheduler/src/jobs.ts),
not in plists. See [`apps/scheduler/CLAUDE.md`](../../apps/scheduler/CLAUDE.md).

| Job | When (IST) | What |
|---|---|---|
| `broker-login` | 08:00 trading days | Triggers the "Daily broker login" GitHub workflow (`packages/broker-login/src/dispatch.ts`); GitHub's own late cron stays as a backstop |
| `morning-summary` | 09:00 trading days | One Telegram message: logins, Fyers token, last options day collected, checkout branch, disk, last-24h failures |
| `evening` | 15:45 trading days (catch-up to 23:00; a restart before 23:00 resumes it) | **A chain (BL-234 Phase 3)**; a step starts when the one before ends. The data steps (group `catalog`; retried 17:15, 18:45 and 20:15; a failure stops the chain): `collect` (`obt daily`: the day's 1-minute option data from Fyers when its token works, else Angel One, BL-079; judge it, derived tables, every leg-wise strategy, the Telegram summary), `rotation-update` (all 298 rotation variants over the day, BL-058), `derived-rebuild`; then `t1-update` (the T1 track's 223 variants, `--soft-fail`: it Telegrams its own alert and never stops the chain). `result` (never before 16:00, `--wait-until 16:25`, retried every 5 minutes to 16:35, BL-125): one Telegram message with the day's one-lot net paper gain for Adaptive and T1 and tomorrow's strategies in full to the owner, Adaptive's part to the Option signals group; sent markers and a per-day lock make retries safe. Then the uploads, which no step before them waits a clock time for and each platform apart: AlgoTest (`algotest-export`, `algotest-upload` with `--allow-delete`, `algotest-setup`, BL-137 / BL-197; retried 4 times an hour apart, never on exit 3; group `quantiply`, so they start after the close-out) and Quantiply (`quantiply-export`, `quantiply-upload`, BL-139; same retries; group `quantiply` too, taken when the chain reaches its first upload step and let go after the last). Last, `t1-catch-up` (a strict `obt rotation update --track t1`, retried twice an hour apart) and `t1-result` (the T1 part of the result if it was not ready). The upload steps are held by the stop button and a pause under their old job ids (`algotest-evening`, `quantiply-evening`). The dashboard's Apply now runs only one platform's upload steps (`jobs run evening --only algotest-export,algotest-upload,algotest-setup`) |
| `options-rotation-pick` | 08:45 trading days (catch-up to 09:15) | `obt rotation pick --with-t1`: record lists A, B, C and REF before 09:17, hash-chained, then the T1 track in its own journal, from last evening's list (owner, 2026-11-09: the evening is the source of truth; no 09:16 re-pick, no morning message, a private alert only on failure) (BL-058) |
| `close-out` | 15:30 trading days (catch-up 6 h; a restart before 16:30 resumes it) | **A chain (BL-234)**, steps in order, a failed step never stopping the next: `fyers-login-recheck` (`mbt token-remind --evening`, not after 15:45); `algotest-deploy-check` (from 15:35, not after 15:45); `live-capture` (from 15:40, `live-capture.ts --soft-fail`, BL-141: every strategy that ran today on AlgoTest and Quantiply, the tool's or the owner's own, with live ₹, multiplier and fills, to `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`, GET calls only; also back-fills 5 days); `quantiply-disable` (`quantiply-deploy.ts --mode disable --apply`, retried twice 5 min apart: the safety net, never gated, so a stuck algo cannot trade next week); `contract-notes-capital` (from 15:50, `obt realised capital`); `live-capture-retry` (from 15:55, `--no-backfill`, retried twice 8 min apart, done by about 16:30; alerts once if the day is still not captured). In the `quantiply` group, before the 16:45 upload, which can then delete the algos |
| `quantiply-deploy` | 16:55 trading days; never retried (catch-up 6 h) | `quantiply-deploy.ts --mode enable --apply` per account: enables the next session's picks the 16:45 upload made (it waits for that job and its retries), each read back and set to the account's broker first; re-reads the list to confirm. REAL MONEY. Needs `QUANTIPLY_DEPLOY=on`, Automated deployment and the account's row |
| `morning-topup` | 09:19 trading days (catch-up 3 h; a restart before 10:00 resumes it) | **A chain (BL-234)**: `quantiply-export` and `quantiply-topup` (both held as `quantiply-topup`, not after 09:49, retried once 2 min apart; a failed top-up does not stop the enable), then `quantiply-deploy-topup` (never retried, held as `quantiply-deploy-topup`): enables a pick the 08:10 switch-on missed and switches off an enabled one the day's entry does not have, never an algo within 90 s of its start (TOO LATE, reported) |
| `backup` | 1st Sunday of the month 10:00 (catch-up all week) | `tdata backup` to `/Volumes/RAHUL'S SSD/TradingData`; to `~/Downloads/TradingData-backup` with a Telegram warning when the SSD isn't plugged in |
| `fyers-login-reminder` (and the `fyers-login-recheck` step of `close-out`) | 08:05 trading days (catch-up 1 h); the re-check at 15:30 | `mbt token-remind --send`: when Fyers does not accept today's token, a Telegram reminder with a link to the hosted Broker logins page for a phone login (and a warning if the Momentum API or the tunnel below is down); silent otherwise |
| `kite-login-reminder` | Fri 13:30 (catch-up 30 min) | `mbt kite remind --send`: when Kite is the Momentum holdings source and today has no valid Kite login, a Telegram reminder to log in before the 14:15 orders (BL-142), with the same link; silent otherwise |
| `kite-login-reminder-monday` | 08:45 trading Mondays (catch-up 30 min) | The same with `--when monday`, before the open |
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

## The always-on Momentum API and tunnel

Two more LaunchAgents, also not scheduler jobs, keep the pieces a phone login needs running
(`docs/remote-dashboard.md`): `com.ai-trading-agent.momentum-api` runs `uv run mbt serve`
(127.0.0.1:8765, from this checkout's `packages/momentum-backtesting`) and
`com.ai-trading-agent.tunnel` runs `cloudflared tunnel run` (`~/.cloudflared/config.yml`). Both
start at login and are restarted if they exit; logs `momentum-api.log` and `tunnel.log` in
`~/Library/Logs/ai-trading-agent/`. Stop a hand-started `bun run start` stack or
`bun run start:tunnel` before installing, or the agent's copy waits for the port.

`bun run start` / `start:backend` from this checkout restart the API through launchd
(`launchctl kickstart -k`) instead of starting a second copy, and `bun run stop:research` leaves it
running. From another worktree the port is taken: `launchctl bootout gui/$(id -u)/com.ai-trading-agent.momentum-api`
first, and `deploy/launchd/install.sh` (or `launchctl bootstrap`) afterwards. After pulling a
Momentum API change: `launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.momentum-api`.

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
