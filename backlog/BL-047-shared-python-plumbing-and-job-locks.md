# BL-047 — Shared Python plumbing in `trading-data`, and cross-process job locks

| | |
|---|---|
| **Priority** | P2: copies have already drifted into bugs, and duplicate runs can double-send Telegram signals |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | trading-data (+ options, momentum) |
| **Created** | 2026-10-07 |
| **Depends on** | none. Related: BL-012 (scheduler), BL-044 |
| **TODO.md row** | none yet (filled in when started) |

## Context

`option-backtesting` and `momentum-backtesting` were written to share no code, so each carries its
own copies. Both now depend on `trading-data` (editable path dependency), so that reason is gone.
The 2026-10-07 audit found copies that have drifted:

- **Fyers token resolution.**
  - obt `fyers/auth.py` did not apply the 06:00 IST expiry rule that mbt `fyers.py:262` applies.
    The audit PR `fix/obt-daily-drift` fixed it locally, so a second copy now exists.
  - The two `.env` parsers differ: mbt strips `export ` and inline comments, obt did not.
- **`notify.py`** is 138 lines in one package and 123 in the other, and only momentum has
  `register_secret`.
- **The IST timezone constant** is defined 12 times. Holiday lookups are repeated in
  `trading_data/vendor.py:280` and `quality.py:296`.

Separately, two job triggers are guarded only inside their own process:

- mbt `/api/weekly/run` (`api.py`, `_SingleFlightJob`);
- obt `/legwise/daily` (`legwise_routes.py:354`).

The scheduler runs the same jobs as separate processes. There is no file lock (`grep flock`
finds nothing), so a dashboard click during the scheduler's run starts a second copy:

- duplicate Telegram messages;
- two writers on the DuckDB catalog.

`trading_data.db._open` then retries for up to 10 s with `time.sleep`, which blocks the API's
worker threads.

## Goal

There is one implementation of the token, `.env`, notify, IST and holiday helpers, in
`trading_data`. A given job can never run twice at once, whoever starts it.

## Out of scope

- The TypeScript side: `@trading/notify` and `@trading/broker-identity` already hold the JS
  versions.

## Plan

### Phase 1 — `trading_data.common`
- **Tasks:**
  - Move into `trading_data`: `IST`, `load_env()`, `fyers_token()` (sources and the 06:00 clamp,
    shared with the TS `fyersTokenExpiry`), `notify` (the momentum version, which has
    `register_secret`) and `holidays`.
  - Switch obt and mbt to them; delete the copies.
  - Cross-check the token rule against `packages/broker-identity` with a parity test.
- **Done when:** `git grep "ZoneInfo(\"Asia/Kolkata\")"` shows exactly one definition, and both
  packages' tests and goldens pass.

### Phase 2 — Job locks
- **Tasks:**
  - `trading_data.locks.job_lock(name)`: an `fcntl.flock` on `TRADING_DATA_ROOT/locks/<name>.lock`,
    non-blocking.
  - Use it in the mbt weekly run, obt daily, and the scheduler's CLI calls of those jobs.
  - The API returns 409 "already running (pid, started)" instead of starting a second run.
- **Done when:** starting `obt daily` from the CLI while the dashboard run is going returns 409
  or refuses immediately. Test with two processes.

### Phase 3 — Writer wait in API threads
- **Tasks:**
  - Read-only API paths open read-only connections. This builds on PR #101's fix for the
    `mbt serve` lock.
  - Writes from an API thread fail fast (about 1 s) with a 503 "catalog busy" instead of a 10 s sleep.
- **Done when:** a GET during `obt daily` returns without waiting on the writer lock.

## Risks

- Moving `notify` changes which secrets get redacted. Union the two registries, never shrink one.

## Open questions

None.

## Log

- 2026-10-07: created from the whole-repo audit.
