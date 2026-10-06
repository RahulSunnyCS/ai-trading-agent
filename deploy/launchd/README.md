# Laptop scheduler (launchd)

Scheduled jobs that run on the owner's laptop while it serves as the server.
Plan and later phases: [`backlog/BL-011-laptop-scheduler.md`](../../backlog/BL-011-laptop-scheduler.md).

| Job | When (IST) | What |
|---|---|---|
| `com.ai-trading-agent.broker-login` | 08:00 Mon–Fri | Triggers the "Daily broker login" GitHub workflow (`packages/broker-login/src/dispatch.ts`). The workflow waits until 08:16 and logs both brokers into AlgoTest. GitHub's own cron for it arrives hours late and stays only as a backstop |
| `com.ai-trading-agent.fyers-login` | 08:05 Mon–Fri | Logs Fyers in headlessly (`packages/broker-login/src/fyers.ts --store`) and stores the token in `broker_tokens`. Separate from the AlgoTest login so neither blocks the other. Needs `FYERS_CLIENT_ID`, `FYERS_PIN`, `FYERS_TOTP_SECRET` in `.env` |

The Friday momentum jobs still live in `packages/momentum-backtesting/scripts/`
until Phase 2 moves them here.

## Commands

```bash
deploy/launchd/install.sh                                     # install or re-install every job in jobs/
launchctl print gui/$(id -u)/com.ai-trading-agent.broker-login # loaded? last exit code?
launchctl kickstart gui/$(id -u)/com.ai-trading-agent.broker-login  # run now (this one triggers a real login)
tail ~/Library/Logs/ai-trading-agent/broker-login.log
deploy/launchd/uninstall.sh
```

## Adding a job

1. Copy an existing plist in `jobs/`. The label and file name must match.
2. `source` the repo `.env` and set `PATH` in the command: launchd provides neither.
3. Times are in the Mac's local timezone, which must be IST.
4. Re-run `install.sh`.

## When the laptop is not awake

- **Asleep at the scheduled time:** launchd runs the job when the Mac wakes. Each job must handle a late start (the broker-login dispatch skips after 15:35 IST).
- **Off:** nothing runs. Waking the Mac before 08:00 needs `sudo pmset repeat wakeorpoweron MTWRF 07:55:00` (Phase 3).
