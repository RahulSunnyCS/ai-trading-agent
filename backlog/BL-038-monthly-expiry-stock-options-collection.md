# BL-038 — Collect every F&O stock's options on its monthly expiry day, from Fyers, from October 2026

| | |
|---|---|
| **Priority** | P1 — time-critical: an expiring contract's history vanishes from Fyers after its last session, so every monthly expiry missed is a month of stock options lost for good; the first one is 2026-10-27 |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / trading-data (+ infra for the schedule) |
| **Created** | 2026-10-07 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) Phase 1 (done: lake, importer, quality table); a Fyers login for the first run; [BL-012](BL-012-scheduler-service.md) for the schedule |
| **TODO.md row** | — (filled in when started) |

## Context

The vendor's stock-option history ends **2026-08-25** (see [BL-037](BL-037-stock-options-in-the-lake.md),
deferred). The owner's request (2026-10-07): from October on, check every evening whether it is
a **monthly expiry**; if it is, **pull the options of every stock** from Fyers that evening, so
the lake keeps getting stock data going forward. Index options (NIFTY, SENSEX, …) stay on the
existing daily `obt daily` collection; this adds stocks, on monthly expiry days only.

Why monthly-expiry-only works (to be confirmed in Phase 0): stock options have monthly expiries
only, each series listed for about three months. Fyers' history call takes a date range of up
to ~100 calendar days at 1-minute resolution (`FyersClient.minute_candles_range`, already in
the repo), and a contract's history is available until its last session. So **one evening's pull
on an expiry day can retrieve the whole life of that month's contracts** — there is no need to
fetch every stock every day (~200 stocks × many strikes would take hours daily at the client's
~180 requests/minute throttle).

What the existing collector gives us (`packages/option-backtesting/src/option_backtesting/fyers/daily.py`):
symbol-master download and parsing for a set of underlyings (`download_master`, `parse_master`),
instrument registration with a Fyers alias, the chain-width walk (cover the day's range, then
extend outward until two consecutive strikes' day high is below ₹2), raw response archiving to
`raw/fyers/`, one `ingest_runs` row per run, and the same Parquet schemas the vendor importer
writes.

## Goal

On every monthly stock-option expiry day, in the evening, the lake gains the complete 1-minute
history of that month's contracts for every F&O stock — no manual step, with a Telegram line if
it did not run or came back short.

## Out of scope

- Index options (already collected daily).
- Backfilling expired series (Aug/Sep 2026 and earlier are gone from Fyers; vendor data stops
  2026-08-25 — see BL-037 and the gap the owner is sourcing).
- Derived tables, IV and greeks for stocks (BL-034 Phase 3 is NIFTY and SENSEX).

## Plan

### Phase 0 — Measure what Fyers will give (needs a Fyers login)
- **Tasks:** for three stocks (one liquid, one thin, one with a recent rename) and one live
  series: how far back does `minute_candles_range` return for a still-listed contract (days
  listed vs the 100-day request cap)? Does it keep returning data on the expiry day itself
  after the close? How many requests per stock (chain width rule) and how long at the client's
  throttle? How many stocks does the symbol master list as stock-option underlyings?
- **Deliverables:** the answers written into this item; a decision on the strike-width rule
  (the index rule — day range, then walk out until the premium floor — or a fixed band around
  each stock's spot).
- **Done when:** a full evening's request count and duration are known, and fit the window
  between the close and the next morning's login.

### Phase 1 — The collector
- **Tasks:** `obt fyers fetch-stocks [--day D] [--force]`: from the day's symbol master find the
  stocks whose nearest expiry is today (**do not use a calendar rule** — it is known wrong for
  NIFTY before 2025-09 and NSE moves expiries over holidays; the listed expiries are the
  truth); for each, the expiring contracts' chain per Phase 0's width rule; fetch each
  contract's history for the last ≤100 days, split it into trading days, and write the lake's
  day files; register the contracts (alias `fyers`); archive the raw responses; one `ingest_runs`
  row per stock and a `data_quality` row per day written. Stock spot (`NSE:<SYMBOL>-EQ`) for
  the same days goes in as `asset=stock` bars — without it the legwise engine cannot run a stock
  (see BL-037).
- **The one design point:** a lake day file holds every contract of that underlying that day,
  but a stock day's contracts arrive in up to three separate evenings (the near, next and far
  series each get pulled on their own expiry). So the writer must **merge** into an existing
  day file (read it, add the new contracts' rows, write atomically) — the collector's current
  "skip an existing day" rule would silently drop later series. Add a merge mode to the lake
  writer and test it (idempotent: re-pulling a series changes nothing).
- **Deliverables:** the command, the merge writer, tests with a fake Fyers client (the
  `FakeClient` pattern in `tests/unit/test_fyers_collect_store.py`), docs.
- **Done when:** a dry run on a real evening writes the expected stock days, re-running it is a
  no-op, and `tdata quality status` shows verdicts for them.

### Phase 2 — Schedule it (under BL-012)
- **Tasks:** a scheduler job that runs after the evening index collection and exits quickly on a
  non-expiry day; a **rehearsal** the evening before an expiry (the same pull; the merge writer
  makes it harmless) so a failure is seen while there is still a day to fix it; Telegram on a
  missed or short run (stocks expected vs stocks written). The first real window is
  **2026-10-27**.
- **Done when:** the October expiry's stock data is in the lake the next morning without a
  manual step.

### Phase 3 — Use the live series now
- **Tasks:** the Oct/Nov/Dec 2026 series are still listed, so their histories can be pulled on any
  evening after a Fyers login, not only on expiry day. Run the Phase 1 command once now so the
  lake has stock data from whenever those contracts started trading, instead of from 27 Oct.
- **Done when:** stock days between late August and today exist for the live series.

## Risks

- **Request volume:** ~200 stocks × tens of strikes × 2 at ~180 requests/minute is roughly one to
  two hours; if it does not fit the evening window, narrow the strike band or run in two passes.
- **A missed expiry evening loses that series permanently** — hence the rehearsal and the
  alert; also the reason this is P1 despite being small.
- **A Fyers token is needed at ~16:00–18:00:** the 08:05 login job's token expires daily; check
  that the evening run sees a valid one (the index collector has the same need).
- **Rename and demerger days** (a stock's symbol changing mid-series) split one stock's data
  across two underlyings; the importer already treats symbols this way (PR #68).
- **Merge writes break the "files are immutable" convention** for stock day files; limit merging
  to this collector and keep `tdata backup`'s size comparison in mind (a merged file changes
  size, so the next backup recopies it — correct, just not free).

## Open questions

- All F&O stocks (the vendor had 216), or a watchlist?
- Stock spot: collect it here, or later with BL-037 Phase 3?
- What time should the evening run start (the index collector's slot, or later)?

## Log

- 2026-10-07 — created from the owner's request while BL-034's stock import was being stopped;
  priority P1 because each missed monthly expiry is unrecoverable (first window 2026-10-27).
