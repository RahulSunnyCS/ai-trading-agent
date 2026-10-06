# BL-012 — Scheduler service: one home for every recurring ingestion and maintenance job

| | |
|---|---|
| **Priority** | P0 — missed evening runs lose expiring-option data for good (30 Sep 2026 is already gone from the lake), and several silent data-quality deadlines are approaching |
| **Status** | In progress |
| **Type** | feature |
| **Area** | infra (cross-cutting: options, momentum, trading-data, broker-login, contract-notes, server) |
| **Created** | 2026-10-05 |
| **Depends on** | BL-011 Phase 1 (done). Supersedes BL-011 Phases 2–4. Related: BL-002 (hosting) |
| **TODO.md row** | 1.10 |

## Context

The owner wants every recurring ingestion job in one service that runs on the laptop
today and can move to a hosting platform later without changes, so that the laptop
stops being something to babysit.

An inventory taken on 2026-10-05 found recurring work spread across **five schedulers**,
most of it unreliable, and much more work that nobody schedules at all:

| Scheduler | What runs there | Problem |
|---|---|---|
| GitHub Actions cron | Broker-login backstop, nightly CI | Delivered 5–6 h late. Runs on datacenter IPs, which NSE, niftyindices and Yahoo block |
| launchd (laptop) | Broker-login dispatch, momentum weekly preview/final | One plist per job, no run history, no missed-run alert. The stock-ingest plist was never installed, so Friday stock data stops at 25 Sep |
| BullMQ in `apps/server` | EOD retrospection (16:00), Fyers token check (08:45) | Only runs while the server, Redis and Postgres are up. Locally `SIMULATE=true` and `EOD_WORKER_ENABLED=false`, so nothing consumes the queue. The token check is disabled by `.env` |
| Claude Routine | option-backtesting nightly AlgoTest ingest (`DECISIONS.md:47-64`) | Not registered: `RemoteTrigger list` is empty (TODO 3.5.2) |
| Another repo's cron | Contract notes (`trade-analytics`, `daily-cron-job.yml`) | Lives outside this repo; cutover pending (TODO 2.x) |

There is also no record of what ran and when, no alert when a job did not run, and the
laptop's sleep or power state decides whether data exists.

## Goal

1. A single **scheduler service** owns every recurring job: daily ingestion, weekly
   signals, monthly backups, and semi-annual or yearly reference-data upkeep.
2. Every run is recorded (start, end, exit code, log), and every **failure or missed run**
   reaches Telegram with the exact command to fix it.
3. The same service runs on the laptop today and on a host later, with no change to
   job definitions. Jobs that must stay on a home connection or need a desktop browser
   are marked as such and keep running at home.
4. Data that can be lost for good (the evening options collection) is collected
   unattended on every trading day.

## Out of scope

- Choosing or setting up the hosting platform (BL-002 and a later decision). This item
  only makes the service ready to move.
- Fixing data-quality problems themselves, such as Total Market survivorship bias or
  missing lot-size history. This item **detects and alerts** on them; the fixes have
  their own TODO rows or backlog items.
- Live trading or AlgoTest execution (TODO §3).

## Inventory — every recurring activity and its fix

**Today** values:
- **auto (late):** the GitHub backstop.
- **auto (laptop):** a launchd job.
- **not installed:** a job file exists, but its launchd job was never loaded.
- **off:** the code exists but nothing runs it.
- **other repo:** scheduled from the `trade-analytics` repo.
- **manual:** a person has to do it.

### Daily (trading days)

| # | Activity | Command | Today | Lost or broken if missed | Fix |
|---|---|---|---|---|---|
| D1 | AlgoTest broker login | `dispatch.ts` → `daily-broker-login.yml` | auto (laptop, BL-011) + auto (late) | No AlgoTest execution that day | Move into the scheduler as a `github-dispatch` job, 08:00 |
| D2 | **Fyers access token** (expires every ~24 h) | Dashboard Broker logins, `mbt login`, or headless `npm run fyers-token` (selectors provisional) | manual | D3, D5 and M2's fallback all fail | Daily 08:30 job running `fyers-token`, writing to `broker_tokens`; confirm the selectors on a real run (roadmap T-53). **Main thing stopping the rest running unattended** |
| D3 | **Evening options 1-minute collection + leg-wise backtests** | `obt daily` (fetch + every `strategies/legwise/*.yaml` + Telegram) | manual (TODO 3.10.2) | **Expiring contracts are lost for good.** 30 Sep is missing; nothing collected since 1 Oct | 16:15 IST on trading days, retried until 23:00; catch-up for still-listed contracts with `obt fyers fetch --date` |
| D4 | Contract notes → Google Sheet | `packages/contract-notes` `npm start` | other repo | Gaps backfill on the next run | Cutover (TODO 2.x), then a scheduler job; remove the old repo's cron in the same change to avoid duplicate rows |
| D5 | Regime tags (`daily_regime_tags`) | `classifyAndPersistDay` in `apps/server/src/trading/regime-tagging.ts`; **no caller outside tests** | off | EOD retrospection falls back to `RANGING`; Options Lab regime overlay is empty | Add a CLI entry point and a 16:30 job (needs Postgres) |
| D6 | EOD retrospection | BullMQ in `apps/server` (`jobs/eod-retrospection-job.ts`) | off (no worker) | No per-personality metrics | Stays in `apps/server` (engine-internal); the scheduler checks it ran and alerts if not (Phase 3) |
| D7 | Daily health summary | — | none | Problems found days late | 08:30 job: token validity, last collected day per dataset (`tdata status`, `ingest_runs`), disk space, yesterday's failed jobs → one Telegram message |

### Weekly

| # | Activity | Command | Today | Lost or broken if missed | Fix |
|---|---|---|---|---|---|
| W1 | Momentum signal preview / final | `mbt weekly --run preview\|final` (Fri 14:40 / 16:45) | auto (laptop) | No Friday signal | Move into the scheduler |
| W2 | **NSE stock-data sync** | `mbt stocks sync` (bhavcopy + migrate, Fyers fallback) then `mbt weekly --run final --only-dataset stock …` (Fri 19:30) | **not installed**; data stops at 25 Sep | Stock, Custom Index and Broad favourites are blocked | Scheduler job; must run at home because it needs a desktop (headed) Chromium for NSE's Akamai check (`home+gui`) |
| W3 | Stock-action review (drops of more than 20%) | Dashboard review → `stock_action_reviews` | manual | Unreviewed splits or bonuses distort backtests | After W2: Telegram "N events to review" with the link |

### Monthly

| # | Activity | Command | Today | Lost or broken if missed | Fix |
|---|---|---|---|---|---|
| M1 | **Backup of the research database** | `tdata backup --to <disk>` | manual, never set up (TODO 3.11.6) | Lose the disk, lose expired-contract history for good | Monthly job once the destination is chosen; alert if the disk isn't mounted |
| M2 | **Corporate-action baseline review** | Review `fetch_report.csv`, then `mbt stocks pin-manifest` or `--accept-ca-diff` | manual (last pinned 28–29 Sep) | ~30 days after the first new event, **every Friday sync fails** (`guards.check_ca_diff_age`) | Check job warns at 20 days with the list and the exact command |
| M3 | Margin table | `tdata reference sql` on `ref_margin` (month-keyed; one row, 2026-08) | manual | Return on margin quietly uses a stale month | Monthly reminder; automate later if a SPAN source exists |

### Semi-annual / quarterly

| # | Activity | Command | Today | Lost or broken if missed | Fix |
|---|---|---|---|---|---|
| S1 | **Nifty 50 membership** (index reviews take effect end of Mar and Sep) | Edit `stocks/curated/nifty50_membership.csv` (+ companies/aliases), then `stocks fetch`, `local migrate`, pin | manual. No 2026 changes recorded; the **Sep-2026 review needs checking now** | Survivorship and point-in-time errors; **no guard notices** because the count stays 50 | Check job in Feb/Aug and on the effective date: compare the live niftyindices list with the file and alert on any difference |
| S2 | Lot sizes (NSE revises about every 6 months) | `tdata reference sql` on `ref_lot_sizes` | manual. 3 rows, all from 2026-01-01; no MIDCPNIFTY/FINNIFTY | Every paper P&L is off by the ratio (the NIFTY 50→65 bug) | Daily check after D3: the Fyers symbol master's lot size vs `lot_sizes.csv` → alert on any mismatch (the engine already notes it, `legwise/engine.py:148`) |
| S3 | Total Market universe and category membership | `mbt categories fetch-universe`, `mbt categories fetch` | manual. The universe is `constant_current` for every year | Survivorship bias in Broad Momentum | Twice-yearly refresh job (`home`, NSE); the historical fix is separate work |

### Yearly

| # | Activity | Command | Today | Lost or broken if missed | Fix |
|---|---|---|---|---|---|
| Y1 | **Trading holidays** (NSE publishes around December) | `tdata reference sql` on `ref_holidays` | manual. Covers 2024–2026; two 2026 dates still provisional | `obt daily` and the scheduler's trading-day check go wrong from 1 Jan 2027 | 1 Dec check: next year present? Alert until it is. Also confirm the provisional dates |
| Y2 | `event_calendar` (Postgres) — RBI MPC, budget, expiry days | New migration + `bun run migrate` | manual. 2026 RBI has only Feb/Apr/Jun | Regime tags miss `EVENT_DAY` | Yearly reminder + a check that every RBI date announced so far is present |
| Y3 | `BLOCKED_DATES` in `.env` | Edit `.env` | manual. Still lists the old **Thursday** expiries | Live entry engine treats the wrong days as blocked | Generate from the holidays and expiry calendar instead of hand-editing (separate small fix); yearly check until then |
| Y4 | Expiry calendar / strike steps | `tdata reference sql` | manual. NIFTY shown as Tuesday back to 2018 (TODO 3.10.15) | Days-to-expiry and ATM resolution wrong | Reminder on SEBI/NSE circulars; fix the history separately |

### On demand (not scheduled, listed so nothing is forgotten)

`obt fyers history` (index + VIX 1-minute backfill, never run — TODO 3.10.11) · `obt legwise rerun` (after editing a strategy) · `obt ingest` AlgoTest pulls (need the MCP connector; the Routine is dead, TODO 3.5.1–3.5.2) · `mbt fetch` full rebuild · `apps/server` Fyers backfill → legs → straddle reconstruction · stock group tags for new listings · curated guard exceptions (TODO 3.6.3).

### Credentials with a lifetime

| Credential | Lifetime | Fix |
|---|---|---|
| Fyers access token | ~24 h | D2 (automated daily login) |
| `gh` CLI auth (used by D1) | Until revoked | D7 health check: `gh auth status` |
| AlgoTest / Angel One / Finvasia passwords and TOTP secrets, Gmail app password, Google service-account key, Telegram bot token, Cloudflare Access token, `FYERS_APP_SECRET` (also the encryption key for `broker_tokens`) | No rotation dates recorded | A `credentials.md` listing each one, where it lives and how to rotate it; yearly reminder |
| GitHub scheduled workflows | Disabled after 60 days without repo activity | Not needed once nothing depends on GitHub cron |

## Design

### Recommendation: a separate small service, `apps/scheduler`

A Bun/TypeScript app in this monorepo, not a part of `apps/server`.

- **Why not inside `apps/server` (BullMQ):**
  - `apps/server` needs Redis and Postgres running, and it is the trading engine. Locally it isn't running at all (`SIMULATE=true`), which is exactly why the EOD job is off today.
  - Ingestion must not stop when the engine is down or restarting.
  - Most jobs are Python or Node CLIs, so they would be child processes either way.
- **Why not GitHub Actions or a cloud cron alone:** it is hours late, datacenter IPs are blocked by NSE, niftyindices and Yahoo, and the research database (`~/TradingData`) lives on disk where the jobs run.

**How it works:**
- **Job registry in code** (`apps/scheduler/src/jobs.ts`), one entry per job:
  - `id` and `schedule` (cron, `Asia/Kolkata`);
  - `calendar`: every day, trading days only (from `holidays.csv` through `@trading/market-reference`), or a set day;
  - a run window (as `dispatch-rules.ts` does today);
  - `command`: argv, working directory and environment;
  - `timeout` and `retries`;
  - `catchUp`: run if missed within N hours, or skip;
  - `group`: jobs in the same group never overlap. `catalog` covers everything that writes DuckDB, which allows only one writer process;
  - `needs`: `fyers-token`, `home` (residential IP), `gui` (headed browser).
- **Job types:**
  - `command`: run a CLI;
  - `github-dispatch`: generalise `dispatch.ts`;
  - `check`: a detector that alerts with the fix command instead of changing data. This covers M2, S1, S2, Y1 and so on.
- **Run history:** a `runs` table in a local SQLite file (`bun:sqlite`, nothing to install), not the DuckDB catalog, so recording a run never competes with a job for the catalog. Logs go to `~/Library/Logs/ai-trading-agent/<job>/<date>.log`, kept 30 days.
- **Missed runs:** at startup and after a wake (by watching the clock jump), compare each job's last run with its schedule, then catch up or alert according to `catchUp`. This fixes the laptop-sleep gap that per-job plists can't.
- **Alerts:** through `@trading/notify`, never the Telegram API directly. Failure, missed, and recovered after failure, each with the job's fix command. Successful runs go only into the D7 daily summary, which keeps Telegram quiet.
- **Status:**
  - a small loopback HTTP API (`GET /jobs`, `GET /runs`, `POST /jobs/:id/run`);
  - a dashboard **Jobs** page through the existing proxy pattern (as `/api/momentum/*` does);
  - a `bun run jobs status` CLI.
- **On the laptop:** one launchd agent with `KeepAlive` runs the scheduler. It replaces every per-job plist in `deploy/launchd/jobs/` and `packages/momentum-backtesting/scripts/`.
- **When hosted:**
  - the same code in a container (Bun, uv/Python, Playwright, qpdf) with a persistent volume for `TRADING_DATA_ROOT` and the run history;
  - secrets come from the platform instead of `.env`;
  - jobs marked `home` or `gui` (W2, S1, S3, anything NSE, niftyindices or BSE) run on a **home runner**: the same binary on the laptop in runner mode, which asks the hosted scheduler for its jobs and reports results. Connections are outbound only, so the laptop needs no open port.
  - Until hosting, everything runs locally and runner mode is unused.

## Plan

### Phase 0 — Stop the losses (owner, now, no code)
- **Tasks:**
  - Run `obt fyers fetch --date 2026-09-30` and the same for every trading day since 1 Oct. Today's 5 Oct after 15:45. Contracts that have already expired can't be recovered.
  - Install the stock-ingest plist (`packages/momentum-backtesting/scripts/install-launchd.sh`).
  - Check the **Sep-2026 Nifty 50 review** against `nifty50_membership.csv`.
  - Add the 2026 Aug/Oct/Dec RBI MPC dates to `event_calendar`.
- **Done when:** the lake has every trading day still available, the stock-ingest job is loaded, and the membership file matches the live list.

### Phase 1 — The scheduler, running the existing jobs
- **Tasks:**
  - Build `apps/scheduler` (registry, runner, `group` locking, SQLite history, Telegram alerts, missed-run catch-up, status CLI) with tests for the schedule, calendar, catch-up and locking rules.
  - Move D1, W1 and W2 into it, in the **same change** that removes their plists, so no job runs twice.
  - One launchd `KeepAlive` agent.
- **Deliverables:** `apps/scheduler`, one plist, updated `deploy/launchd/README.md`, docs in `.claude/project/`.
- **Done when:** for one full week, D1, W1 and W2 run from the scheduler on time or are caught up after sleep, and `jobs status` shows each run.

### Phase 2 — Unattended daily data
- **Tasks:**
  - D2: confirm the `fyers-token` selectors on a real run and schedule it at 08:30.
  - D3: `obt daily` at 16:15 on trading days.
  - D7: daily health summary.
  - M1: monthly backup.
  - D5: regime-tag CLI and job.
- **Done when:** five trading days in a row are collected with no human action, and the backup has run once.

### Phase 3 — Maintenance checks (monthly, semi-annual, yearly)
- **Tasks:** `check` jobs for:
  - M2 (CA baseline age, warn at 20 days);
  - S1 (live Nifty 50 list vs file);
  - S2 (lot size vs Fyers symbol master);
  - Y1 (next year's holidays by 1 Dec);
  - Y2 (RBI dates);
  - M3 and Y4 reminders;
  - D6 (EOD retrospection ran);
  - W3 (review queue);
  - credential rotation reminders, plus `credentials.md`.
- **Done when:** each check has a test that makes it fire, and a forced failure of each reaches Telegram with its fix command.

### Phase 3b — Weekly health digest (owner-approved 2026-10-06)
- **Tasks:** one Telegram message every Saturday morning: CI state on `main`, every job's last
  run and any misses, data freshness per dataset, the forward journal against the backtest
  (BL-024), and any live-money rule close to its limit (BL-025). Green items collapse to one line.
- **Done when:** two Saturdays' digests arrive and match `gh run list` and the Jobs records.

### Phase 4 — Dashboard Jobs page
- **Tasks:** list jobs with next run, last result and duration; run now; tail the latest log.
- **Done when:** every job can be checked and re-run from the dashboard.

### Phase 4b — Notification preferences in the dashboard (owner request 2026-10-06)
- **Tasks:**
  - A **Notifications** page in Settings that lists every notification type (morning
    summary, job failure, missed run, momentum preview/final, rebalance, data checks, weekly
    digest) with a Telegram on/off switch per type.
  - Preferences are stored by the scheduler and read before every send. Failure and
    missed-run alerts stay on by default; turning one off asks for confirmation.
- **Done when:** switching a type off stops that message the next time it would send, and
  switching it back on restores it.

### Phase 5 — Ready to host
- **Tasks:**
  - Dockerfile and persistent-volume layout.
  - Home-runner mode for `home`/`gui` jobs.
  - Map secrets from `.env` to platform secrets.
  - D4 contract-notes cutover into the scheduler, retiring the `trade-analytics` cron.
  - Decide whether the `apps/server` BullMQ jobs stay there.
- **Done when:** the container runs the non-home jobs for one week alongside the laptop as home runner. If hosting is not yet chosen, a dry run in local Docker against a copy of the data counts instead.

## Risks

- **DuckDB allows one writer process.** Two jobs writing the catalog at once fail. The `catalog` group runs them one after another; the dashboard's own writes (manual runs from Options Lab or Momentum) can still collide. Route manual runs through the scheduler in Phase 4.
- **The headed-browser NSE check cannot run in a container.** That is why `home` and `gui` placement exists; those jobs stay at home permanently unless NSE access changes.
- **Automated Fyers login (D2)** depends on provisional selectors and could break on a Fyers redesign. The D7 health check catches a missing token by 08:30, before D3 needs it.
- **Moving jobs can double-run them.** Each move removes the old schedule in the same change, the same rule as the contract-notes cutover.
- **Noise:** too many Telegram alerts get ignored. Successes only go into the daily summary, and an unchanged failure repeats at most once a day.
- **The laptop is still a single point of failure** until Phase 5. Missed-run catch-up and alerts reduce the damage; they don't remove it.

## Owner decisions (2026-10-06)

1. **Separate `apps/scheduler`**, as recommended.
2. **Hosting:** the laptop for now, a **Mac mini (always-on home machine)** later. Design for
   the home machine first. Cloud hosting is considered only after the proof of concept
   works, so Phase 5 keeps the container and runner mode but they come after everything else.
3. **Automate the daily Fyers login (D2).** The headless login already runs at 08:05 from
   launchd (TODO 1.9); it moves into the scheduler like the other jobs.
4. **Backup (M1):** to `/Volumes/RAHUL'S SSD/TradingData` when it is mounted. When it isn't, write to
   `~/Downloads` as a fallback and say so in the alert. (That copy sits on the same disk, so
   it guards against a broken database, not a lost laptop.)
5. **Telegram:**
   - one **morning summary between 08:00 and 09:15 IST** once the AlgoTest and Fyers logins
     and the other morning jobs have finished, saying everything worked;
   - an **immediate** message the moment anything fails;
   - a dashboard page to choose which notifications reach Telegram (Phase 4b).
6. **Phase 3 checks:** all four groups (data-source drift, calendar upkeep, stock-data
   deadlines, credential reminders). **Alert only**: no check changes data by itself.

**Delivery:** small PRs, one concern each. PR 1 trading-day calendar · PR 2 notification
types and preferences · PR 3 scheduler core · PR 4 loop, catch-up, alerts, morning summary ·
PR 5 the single launchd cut-over · then one PR per later job, check group and dashboard page.

## Log

- 2026-10-05 — created from a full inventory of scheduled and manual jobs. Verified by
  hand: no `date=2026-09-30` partition in `~/TradingData/lake/bars_1m` (latest is 1 Oct);
  `nifty50_membership.csv` has no 2026 changes; `holidays.csv` ends 2026-12-25. Takes
  over BL-011 Phases 2–4.
- 2026-10-06 — new jobs to schedule once their items land: the Friday forward-journal write and
  the weekly scoring (BL-024), the live-money rules check (BL-025), and the daily
  realised-vs-backtest join for options (BL-026).
- 2026-10-06 — owner decisions on PR #27: weekly Telegram health digest approved — added as Phase 3b.
- 2026-10-06 — started. Owner answered questions 1–5 (see Owner decisions) and asked for a
  notification preferences page, added as Phase 4b. Question 6 answered the same day. PR 1:
  `isTradingDay`/`isHoliday` in `@trading/market-reference`.
- 2026-10-06 — PRs 2–5 opened: notification types + preferences (and the momentum `"warning"`
  fix), the scheduler core, the loop with catch-up/alerts/morning summary, and the launchd
  cut-over (one `KeepAlive` agent; the six per-job plists retired by `install.sh`). The
  Friday jobs keep writing `data/launchd-weekly-*.log` because the Momentum status panel
  reads them. Found: GitHub's backstop broker-login cron fails every afternoon (~15:55 IST,
  after AlgoTest's window) — PR 10.
- 2026-10-06 — PR 7: `options-daily` (`obt daily`) at 16:15 IST trading days, retries at
  17:45 and 19:15, catch-up until 23:00, `catalog` group.
- 2026-10-06 — PR 8: monthly `backup` job (1st Sunday 10:00, catch-up all week): SSD, else
  `~/Downloads` with a warning. First backup taken through it: 188 files, 280 MB.
- 2026-10-07 — Phase 0: Nifty 50 Sep-2026 review applied (BSE in, Wipro out, effective 2026-09-30; confirmed against the live niftyindices list). BSE's 15 corporate-action rows reviewed and accepted, baseline advanced, three stock goldens re-accepted (BSE appears in the companies list; no number moved).
- 2026-10-07 — Phase 3b: `weekly-digest` (Saturday 09:00 IST): CI on main, each job's runs over the last 7 days, last options day in the lake, last backup; green items collapse to one line. Journal-vs-backtest (BL-024) and live-money rules (BL-025) join when those ship.
- 2026-10-07 — `docs/mac-mini.md`: the checklist for moving the scheduler to an always-on Mac mini (stay-awake and auto-login settings, tools, secrets, copying `~/TradingData`, dry runs, hard cut-over so two machines never both schedule).
