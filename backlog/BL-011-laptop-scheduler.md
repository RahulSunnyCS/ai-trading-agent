# BL-011 — Laptop as scheduler: run the repo's cron jobs from launchd

| | |
|---|---|
| **Priority** | P1 — the morning broker login is the prerequisite for any AlgoTest execution, and GitHub's scheduler was delivering it hours late |
| **Status** | In progress (Phase 1 done) |
| **Type** | feature |
| **Area** | infra |
| **Created** | 2026-10-05 |
| **Depends on** | none |
| **TODO.md row** | 1.8 |

## Context

The owner is using their laptop as the server for now. Scheduled work is split
across two schedulers:

- **GitHub Actions cron.** `daily-broker-login.yml` is set for 08:15 and 08:45 IST,
  but GitHub delivered it about six hours late: the scheduled runs on 2026-09-29 to
  2026-10-02 started between 14:30 and 15:45 IST (`gh run list`, `packages/broker-login/run-log.md`).
  GitHub documents scheduled runs as best-effort and delayed under load. Manually
  dispatched runs start within seconds.
- **launchd on the laptop.** The three Friday momentum jobs
  (`packages/momentum-backtesting/scripts/*.plist`, TODO 3.11.5 / 3.11.16).

The owner asked for the laptop to run cron jobs that trigger these actions, starting
with the broker login at 08:00 every weekday.

## Goal

Every recurring job in the repo has one schedule, on the laptop, installed by one
script, with a way to see when each last ran. The broker login starts by 08:16 IST on
every trading day the laptop is on.

## Out of scope

- A new long-running scheduler service (BullMQ, node-cron, a daemon). launchd already
  exists, survives reboots and needs no process to babysit.
- Moving secrets onto the laptop. GitHub-hosted jobs stay on GitHub; the laptop only
  triggers them.
- Hosting the laptop's jobs anywhere else once a real server exists — that is a
  separate decision.

## Plan

### Phase 1 — Broker login at 08:00 IST (done 2026-10-05)
- **Tasks:** `packages/broker-login/src/dispatch.ts` runs `gh workflow run
  daily-broker-login.yml --ref main` (5 attempts, 30 s apart, for Wi-Fi after a wake),
  confirms a new `workflow_dispatch` run appeared, and sends a Telegram alert through
  `@trading/notify` if not. `src/dispatch-rules.ts` only allows weekday 07:45–15:35 IST,
  because launchd runs a missed job on wake. LaunchAgent
  `deploy/launchd/jobs/com.ai-trading-agent.broker-login.plist`, Mon–Fri 08:00, with
  `deploy/launchd/install.sh` / `uninstall.sh`. The GitHub cron lines stay as a late backstop.
- **Deliverables:** the files above, 5 unit tests, `deploy/launchd/README.md`.
- **Done when:** a weekday morning shows a `workflow_dispatch` run created at about
  08:00 IST in `gh run list`, and the Telegram report arrives at about 08:17.
  *Installed and dry-run verified 2026-10-05; first real fire is Mon 2026-10-05 08:00.*

> **Phases 2–4 moved to [BL-012](BL-012-scheduler-service.md)** (2026-10-05): a scheduler
> service that replaces per-job plists and can move to a host later. Kept below for history.

### Phase 2 — One home for every scheduled job
- **Tasks:** move the three momentum plists into `deploy/launchd/jobs/`, delete
  `packages/momentum-backtesting/scripts/install-launchd.sh`/`uninstall-launchd.sh`,
  and update TODO 3.11.5's pointers. Add `deploy/launchd/status.sh`: per job, loaded or not,
  last exit code, last log line. Write logs to `~/Library/Logs/ai-trading-agent/` for every job.
- **Found while planning:** `com.ai-trading-agent.momentum-weekly-stock-ingest.plist`
  is in the repo but not installed in `~/Library/LaunchAgents` (only preview and final are),
  so the Friday 19:30 stock ingest is not running. Also, the momentum plists say a missed
  run has no catch-up; launchd does run a missed calendar job on wake, so that comment is wrong.
- **Done when:** `install.sh` installs all four jobs, `status.sh` lists them, and the
  stock-ingest job shows a run after the next Friday.

### Phase 3 — Reliability when the laptop sleeps or is off
- **Tasks:** document and have the owner run `sudo pmset repeat wakeorpoweron MTWRF 07:55:00`
  (needs their password). Add a missed-run check: at the first wake after a scheduled time,
  alert on Telegram if a job did not run. Reuse the late-run idea from momentum's
  `ran_late_by_minutes` (TODO 3.11.16 B5).
- **Done when:** a morning with the lid closed at 08:00 either still dispatches on time or
  sends a Telegram alert saying it did not.

### Phase 4 — More jobs onto the laptop
Candidates, each its own plist and decided with the owner:
- `contract-notes` daily (still on the `trade-analytics` repo's cron — cutover in `docs/algotest-execution.md`).
- `obt daily` evening collector — Fyers expiring contracts vanish the same evening, so a missed run loses data for good.
- Monthly `tdata backup --to <disk>` (TODO 3.11.6).
- Morning AlgoTest selector canary before 08:00 (TODO 1.7).
- **Done when:** each chosen job is in `jobs/`, has run once on schedule, and its old schedule is removed.

## Risks

- **Laptop off, asleep or offline at 08:00.** Asleep: launchd fires on wake and the
  07:45–15:35 rule decides. Off all day: the GitHub cron backstop still logs in, late.
- **`gh` token expires or is revoked.** The dispatch fails all 5 attempts and sends a
  Telegram alert; fix with `gh auth login`.
- **Path drift.** The plist hard-codes the fnm default Node 20 and Homebrew `gh` paths.
  A Node upgrade that removes the `default` alias breaks it. The Telegram alert path needs
  Node too, so check `~/Library/Logs/ai-trading-agent/broker-login.log`.
- **Market holidays.** The dispatch still goes out; the workflow fails with its usual
  Telegram alert, as it did before.
- **Double runs.** On a normal day the delayed GitHub cron run also fires in the afternoon
  and reports both brokers SKIPPED, which costs one extra Telegram message.

## Open questions

For Phase 2 onwards:
1. At 08:00 is the laptop usually on power with the lid open, or closed/asleep?
2. Which Phase 4 jobs should move first?
3. Once the laptop dispatch has been reliable for two weeks, remove the GitHub cron lines
   to stop the afternoon duplicate message?

## Log

- 2026-10-05 — created. Owner's answers: trigger the existing GitHub workflow from the
  laptop (credentials stay in GitHub secrets); fire at 08:00 and let the window guard wait
  for 08:16; keep the GitHub cron lines as a backstop; build Phase 1 now.
- 2026-10-05 — Phase 1 built and installed: typecheck clean, 12/12 package tests pass,
  plist lints, `DRY_RUN=1` of the exact plist command under an empty environment found
  `gh` and its auth. The dry run also showed the first rule (skip only after 15:35) would
  have dispatched a login at 00:38; tightened to weekday 07:45–15:35. No real login was
  dispatched during verification.
- 2026-10-05 — corrected the first-fire date (Mon 5 Oct, not Tue 6 Oct). Phases 2–4
  superseded by BL-012; this item closes once Phase 1's first real run is confirmed.
