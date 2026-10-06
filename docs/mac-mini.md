# Moving the scheduler to a Mac mini

The scheduler (`apps/scheduler`, BL-012) is built for an always-on home machine. This is the
checklist for moving it from the laptop to a Mac mini. Nothing here needs a cloud host.

**Why a home machine and not a cloud box:** NSE, niftyindices and Yahoo block datacenter IPs;
the Friday NSE stock sync needs a *headed* browser (a real desktop session) because NSE's bot
check rejects headless Chromium; and `~/TradingData` (the research database, including
expired-contract history that cannot be re-downloaded) lives on disk where the jobs run.

## 1. Before you start
- Keep the laptop's scheduler running until the mini passes step 7. Two schedulers on two
  machines would run every job twice (a double broker-login, a double Telegram), so **stop the
  laptop's only at the cut-over in step 8**.
- Use the **same macOS username (`rahul`) and the same repo path (`~/Projects/ai-trading-agent`)**.
  `deploy/launchd/jobs/com.ai-trading-agent.scheduler.plist` hard-codes `/Users/rahul/...`; with a
  different user or path, edit that file first.

## 2. Make the Mac mini stay awake and signed in
- **System Settings → Energy** (or `sudo pmset -a sleep 0 disksleep 0`): prevent sleep when the
  display is off; enable "Start up automatically after a power failure".
- **Auto-login to your user** (System Settings → Users & Groups). The scheduler is a *LaunchAgent*,
  which only runs inside a logged-in GUI session, and the Friday stock sync needs that session for
  its headed browser. A locked screen is fine; being logged out is not.
- Optional, if you want it off at night: `sudo pmset repeat wakeorpoweron MTWRF 07:55:00`.
- Check the clock is set to **IST** (the scheduler's own maths is IST regardless, but the logs and
  your own sanity are easier).

## 3. Install the tools
Homebrew, then: `bun`, `uv`, `node` (via `fnm`, Node 20 — `packages/contract-notes` and
`packages/broker-login` need it), `gh`, `qpdf`, Docker or a local PostgreSQL 16 with TimescaleDB if
you want the trading app and the 08:05 Fyers token store (`DATABASE_URL`, default port 5433).
The scheduler finds tools on `~/.bun/bin`, `~/.local/bin` (uv), `~/.local/share/fnm/aliases/default/bin`
and `/opt/homebrew/bin`; if you install somewhere else, extend `jobPath()` in `apps/scheduler/src/env.ts`.

## 4. Get the code and the secrets
```bash
git clone https://github.com/RahulSunnyCS/ai-trading-agent ~/Projects/ai-trading-agent
cd ~/Projects/ai-trading-agent && bun install
(cd packages/momentum-backtesting && uv sync && uv run playwright install chromium)   # NSE stock sync: a real (headed) browser
(cd packages/option-backtesting && uv sync) && (cd packages/trading-data && uv sync)
(cd packages/broker-login && node_modules/.bin/playwright install chromium)           # the 08:05 Fyers login
```
- Copy the repo-root **`.env`** over a channel you trust (it holds the broker, Telegram, Fyers
  and database secrets — never commit it, never paste it into chat). Compare against `.env.example`.
- `gh auth login` on the mini (the AlgoTest login is dispatched through `gh`). The 08:36 check
  `gh-auth-check` alerts if it ever stops working.
- `packages/momentum-backtesting/data/` is gitignored; copy it too (or let `mbt fetch` rebuild),
  and the Fyers token cache (`data/.fyers_token.json`) is only a fallback.

## 5. Bring the data
The research database is `TRADING_DATA_ROOT` (default `~/TradingData`). **Do not re-create it —
copy it**: expired option contracts cannot be downloaded again.
- Restore from the latest monthly backup on the SSD:
  `cp -R "/Volumes/RAHUL'S SSD/TradingData" ~/TradingData`, or copy it straight from the laptop
  (`rsync -a laptop:~/TradingData/ ~/TradingData/`). Then `uv run tdata status` in `packages/trading-data`.
- Run a fresh backup on the laptop first, so the copy includes today's data:
  `bun run --filter @ata/scheduler jobs run backup`.

## 6. Install the scheduler on the mini (do NOT enable it yet if the laptop's is still on)
```bash
cd ~/Projects/ai-trading-agent && git switch main && git pull
bun run --filter @ata/scheduler jobs status        # every job, with next run times
bun run --filter @ata/scheduler jobs run morning-summary   # sends a real summary to Telegram
```
Dry-run the logins: `DRY_RUN=1 bun run --filter @ata/scheduler jobs run broker-login` only checks
`gh` and prints the command. Run `jobs run fyers-login` once while watching (it needs `DATABASE_URL`
reachable). Run the Friday jobs' pieces by hand once: `uv run mbt stocks sync` in a desktop session
(the headed browser must open and pass NSE's check — this is the step most likely to need attention).

## 7. Compare before cutting over
For a day or two, leave the laptop as the live scheduler and run `jobs status` and the
read-only checks on the mini (`jobs run check-nifty50-membership`, `check-lot-sizes`,
`calendar-upkeep`, `check-stock-ca-baseline-age`) — they only look, never change data.

## 8. Cut over
1. On the laptop: `deploy/launchd/uninstall.sh` (stops its scheduler; its data stays).
2. On the mini: `deploy/launchd/install.sh` — it prints any of today's slots the new scheduler
   will skip; run those by hand.
3. Next morning, the 09:00 Telegram summary should say all good. Check `jobs status` and
   `~/Library/Logs/ai-trading-agent/scheduler.log`.
4. Keep the laptop's `~/TradingData` as a cold copy for a week before deleting anything.

## Gotchas
- **Single instance:** `serve` refuses to start while another scheduler holds the pid file on the
  *same machine*; it cannot see another machine, which is why step 8 is a hard cut-over.
- **The checkout's branch is the code that runs.** The morning summary flags anything but `main`.
  Restart after pulling: `launchctl kickstart -k gui/$(id -u)/com.ai-trading-agent.scheduler`.
- **Dashboard** (`bun run start`) can run on the mini too; `SCHEDULER_DIRECT=1` (set by the dev
  stack) is what lets it reach the scheduler API on `127.0.0.1:8790`. See `docs/remote-dashboard.md`
  for serving it away from the machine.
- If a cloud host is ever chosen, jobs marked `needs: home`/`gui` in `apps/scheduler/src/jobs.ts`
  (NSE and niftyindices work) must stay on this machine as a "home runner"; that mode is not
  built yet (BL-012 Phase 5).
