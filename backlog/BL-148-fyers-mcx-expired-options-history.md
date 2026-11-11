# BL-148 — Fyers MCX expired options history: Prime two-year 1-minute backfill into the lake

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-21): take Fyers Prime and do the two-year MCX options backfill next |
| **Status** | In progress (started 2026-11-11; Phases 1-5 built, Phase 4's job waits for merge) |
| **Type** | feature |
| **Area** | options / trading-data |
| **Created** | 2026-10-21 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) (canonical lake and quality table); owner activates Fyers Prime; reuses the expired-F&O client, request limiter and raw cache of TODO 3.11.26 (`fyers/expired.py`) |
| **TODO.md row** | 3.11.27 |

## Context

The owner wants the last two years of MCX commodity-option 1-minute history stored locally and
will take Fyers Prime so it can be downloaded in one resumable run rather than at the Standard
plan's ten expired-intraday requests per day.

An earlier plan existed as `BL-054-mcx-options-evening-straddles.md` on an unmerged branch, but
that ID collided with the current BL-054 and the item never entered the active backlog. This item
restores only its data-platform scope under a new ID. Strategy research belongs in a later,
pre-registered item after the history is present and audited.

On 2026-10-14 Fyers added three dedicated expired-F&O APIs:

1. `expiry_dates` lists past option/future expiries, up to 366 days per request;
2. `history_underlying_symbols` lists the expired future and every CE/PE symbol for one expiry;
3. `fno_historical_data` returns OHLCV and optional OI for one expired contract, up to 100
   calendar days per intraday request.

Official contracts and limits:

- [Get Expiry Dates](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expiry-dates/)
  says MCX history is available from 2018-10-11.
- [Get Expired Contracts](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-contracts/)
  is the authoritative symbol source; do not reconstruct expired symbols.
- [Get Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-fo-data/)
  supports 1-minute candles and OI; MCX Greeks are explicitly unavailable.
- [Plans and limits](https://fyers.in/api-docs/v3/getting-started/plans-and-limits/): Standard
  expired intraday is 10 requests/day; Prime uses 10 requests/second, 500/minute and
  500,000/day. A repeated rate-limit breach can block the user for the rest of the day.

The local Standard account was smoke-tested read-only on 2026-10-21, before this item was
written:

- `expiry_dates(MCX:CRUDEOIL26NOVFUT, 2024-01-01..2024-12-31)` returned all 12 option expiries;
- the 2024-01-17 expiry returned 160 CRUDEOIL CE/PE contract symbols;
- one request for `MCX:CRUDEOIL24JAN6500CE`, 1-minute + OI, returned 26,944 candles from
  2023-12-04 10:42 IST through 2024-01-17 23:54 IST, with non-null OI on every row.

The repo's current `FyersClient` calls only the older `/data/history` endpoint. That endpoint
correctly says `Invalid symbol provided` for expired contracts; the new expired-F&O endpoints
need their own client methods and response schema (`columns` must be read by name).

Initial scope is the most recent two years, fixed at **2024-10-21 through the day the backfill
starts**, then daily continuation. The inventory phase measures the exact contract count and
disk requirement before any bulk download. The intended universe is every non-agricultural MCX
option root Fyers actually reports in that window, including standard and mini contracts;
MCXBULLDEX and any other commodity index are excluded.

## Goal

1. Every traded 1-minute OHLCV+OI row for the selected MCX commodity-option contracts from
   2024-10-21 through today is in the canonical `trading-data` lake.
2. Discovery uses Fyers' historical expiry and contract APIs, never guessed symbol names or
   today's master for a past date.
3. The import is idempotent, resumable and request-budget aware: a crash or token expiry never
   repeats completed contract windows or leaves a partial Parquet partition.
4. A machine-readable manifest proves requested, completed, empty and failed contracts; a
   coverage report gives rows/days by underlying, expiry, strike and side.
5. Active contracts and new expiries continue into the same schema without mixing or
   duplicating the old `/data/history` and new expired-F&O sources.

## Out of scope

- Strategy tests, parameter sweeps or a verdict on commodity straddles/strangles. Those require
  a separate pre-registered research item after this data passes audit.
- MCX Greeks: Fyers explicitly does not supply them. They may be derived later from futures,
  rates and option prices, but are not guessed during ingestion.
- Agricultural commodities, NCOM and MCX index options.
- Tick, bid/ask, market depth or second-level data.
- Greeks from the vendor: it does not supply them for MCX at all. Any MCX IV or Greek is
  derived locally (Black-76 on the MCX future, which `trading_data/derived.py` would need to be
  generalised for); what that needs is settled by [BL-149](BL-149-fyers-greeks-validation.md).
- Order placement or any live-trading integration.

## Plan

### Phase 1 — Prime entitlement, inventory and immutable manifest

- **Tasks:**
  - Confirm the account is Prime with one expired 1-minute request and record the response
    headers/body fields without recording credentials.
  - Add a small expired-F&O client beside `fyers/client.py`: expiry dates, contracts and candles;
    parse candle fields from the returned `columns`, not fixed positions.
  - Discover expiries from 2024-10-21 through the start date in 366-day windows, then discover
    every option symbol for each expiry. Keep CE and PE; keep futures in the manifest as the
    future-price reference, but do not count them as option coverage.
  - Produce a dry-run inventory: underlyings, expiries, option symbols, expected history calls,
    estimated raw/Parquet size, and free disk space. Freeze that manifest before the bulk pull.
  - Persist the manifest and per-window state under `TRADING_DATA_ROOT/raw/fyers-expired/`; its
    identity includes the requested date window and a hash of the discovered symbol list.
- **Deliverables:** expired-F&O client, tests with recorded/synthetic responses, and
  `obt fyers expired inventory --from 2024-10-21 --to <start-day>` (name may change, behaviour
  may not).
- **Done when:** the local Prime token returns an expired MCX option with 1-minute OI; the
  inventory has no reconstructed symbols; the owner sees exact calls and disk required before
  the first bulk candle request.

### Phase 2 — Resumable Prime backfill

- **Tasks:**
  - Download one contract per request in at most 100-calendar-day windows. Since most commodity
    option lives fit inside that bound, use one window where possible; split only when required.
  - Throttle below Prime's ceilings (target at most 8/second and 450/minute), honour `429` with
    server-directed/exponential backoff, and stop rather than risk the documented day block.
  - Checkpoint only after a raw response is durably archived and its normalized rows are
    atomically committed. `ok`, `no_data`, retryable failure and permanent validation failure are
    distinct states.
  - Normalize timestamps to Asia/Kolkata and write the existing lake schema under
    `bars_1m/asset=option/underlying=<U>/date=<D>/`. Register instruments and Fyers aliases using
    the exact expired symbols; record `source=fyers-expired` ingest runs.
  - Merge contracts sharing a day partition without dropping rows already supplied by another
    source. Raw bars remain sparse: a minute with no trade is not forward-filled.
  - Add `--resume`, `--only-underlying`, `--only-expiry`, `--max-requests` and a clean interrupt
    path so the job can be safely stopped around token reset or other Fyers work.
- **Deliverables:** bulk command, manifest progress, raw archive and lake partitions.
- **Done when:** killing and restarting the import causes zero completed API windows to be
  repeated; the frozen manifest has no unclassified item; every successful response's row count
  equals its normalized/lake row count before deduplication.

### Phase 3 — Data audit and coverage verdict

- **Tasks:**
  - Enforce OHLC invariants, unique `(instrument_id, ts)`, non-negative volume/OI, monotonic
    timestamps and correct MCX session bounds. Do not mistake an untraded minute for missing
    vendor data.
  - Compare a sample of currently active contracts fetched through old `/data/history` with the
    same contracts after expiry through the new endpoint; OHLCV+OI must match on common bars or
    the source difference is measured and recorded.
  - Aggregate selected expiry-day contracts to daily OHLCV and cross-check against an independent
    MCX/Fyers daily value where available.
  - Generate coverage by underlying/expiry/strike/side: requested contracts, contracts with
    bars, first/last timestamp, trading days, rows, OI coverage, empty contracts and failures.
  - Rebuild `data_quality` with MCX-aware session expectations; any DST-dependent close and
    evening-only holiday session comes from reference data, not a fixed 870-minute assumption.
- **Deliverables:** `tdata quality` integration and a committed audit summary (counts, not the
  data itself).
- **Done when:** all manifest rows have a final verdict, sampled raw-to-lake checks are exact,
  duplicates are zero, and every excluded day has a named reason rather than a guessed fill.

### Phase 4 — Nightly collection of live contracts (built 2026-11-11)

Owner decisions (2026-11-11): collect the **nearest two expiries** of all ten roots (every strike);
**run at the MCX close, 23:30 IST on US summer time and 23:55 on winter time** (expiring options
trade to the close and vanish from `/data/history` after expiry); **write nightly into the lake,
compare later**; **Angel One** completes the run after midnight when Fyers cannot be used; Prime is
dropped about a month after the backfill, so the live collector is the only source then.

- **Tasks (done):**
  - `fyers/mcx_daily.py` + `obt fyers mcx-daily`: select the nearest two expiries from the live
    `MCX_COM` master (expiring first), one `/data/history` request per contract from its last stored
    day (else 99 days back, so the first run fills a live contract's whole life), 1-minute bars with
    OI, wait for the close (`session_close`), replace only the rows of the contracts fetched, never
    touch an expired contract, one ingest run per root (`mcx_options_daily`), days judged.
  - Angel One fallback (`angelone/mcx.py`, `--source angelone`; automatic when Fyers has no usable
    token): contracts matched by root, expiry, strike (÷100) and side; OI divided by the lot size
    (Angel's is in units, Fyers' in lots); starts the day after the last stored day and looks back at
    most 3 days, so it never replaces a Fyers day; the next Fyers run overwrites its days for any
    contract still listed.
  - Scheduler job `mcx-collect` (weekdays 23:31, one job: the command waits for the close, so the
    season rule lives only in `session_close`; group `catalog`, retries 2, exit 2 not retried,
    catch-up until 05:30).
  - Prime is documented as needed for the bulk rebuild and the Phase 5 comparison only; the stored
    history stays usable without it.
- **Probes before building (2026-11-11):** `/data/history` serves live MCX options with OI on every
  row and one request returns a contract's whole life; Angel One serves MCX candles and OI (up to
  about 8,000 rows a request); the two feeds agree on shape and close/high but not exactly (open and
  low differ by a few ticks, volume by a few percent), and Angel's OI is Fyers' times the lot size.
- **Deliverables:** `mcx-daily`, the fallback, the scheduler job, tests.
- **Done when:** five consecutive sessions append idempotently, the Angel One fallback has been used
  once, and the coverage report advances with no manual file work. **Not yet met: it runs only after
  merge and a scheduler restart.**

### Phase 5 — History API against the expired API (built 2026-11-11)

While Prime lasts, the November expiries of all ten roots (CRUDEOIL and CRUDEOILM 17 Nov,
NATURALGAS and NATGASMINI 20 Nov, SILVERM, COPPER and ZINC 23 Nov, GOLD, GOLDM and SILVER 27 Nov)
are fetched from the expired API after they expire and compared with what the nightly collector
stored while they were live.

- **Run, per expired expiry:** `mcx-inventory --refresh --to <today>` (a new frozen manifest that
  lists the new expiries), `mcx-pull --roots <root> --only-expiry <D>` (cache only: **do not run
  `mcx-import` on it**, which would fill the lake's missing minutes and end the independence of the
  two sides), then `mcx-compare --roots <root> --expiry <D>`.
- **`fyers/mcx_compare.py` + `obt fyers mcx-compare`:** the lake's bars of each contract against the
  expired raw answer, minute by minute: rows on both sides, rows only in History, only in expired,
  every field that differs (open, high, low, close, volume, OI) with counts, largest gap and examples,
  the share of rows identical; days the Angel One fallback stored are left out; writes
  `raw/fyers-expired/mcx/compare-<root>-<expiry>.json/.csv`, nothing to the lake.
- **After the comparison:** the owner picks the precedence rule (and whether to fill the lake's missing
  minutes from the expired answers, which `mcx-import` already does without overwriting). Nothing is
  replaced before then.
- **Done when:** every November expiry is compared and the findings are in the log and in
  `research/`'s data notes.

## Risks

- **Size is unknown until inventory.** Full chains across standard and mini contracts can be
  hundreds of millions of rows. The dry run gates the download on free space; it does not silently
  narrow strikes to fit.
- **New API surface.** The expired endpoints were released only on 2026-10-14. Archive raw JSON,
  test the `columns` schema, and make unknown columns additive rather than shifting OI silently.
- **Rate-limit block.** Fyers says repeated per-minute breaches can block the account for the day.
  Stay below 10/sec and 500/minute, use a global limiter, and stop after repeated `429`s.
- **Token resets at 06:00 IST.** Checkpoint per request and resume with the next token; never hold
  the whole run in one transaction.
- **Sparse trading.** Many strikes may have no candles. `no_data` is a recorded result, not an
  ingestion failure, and raw data is never filled forward.
- **Overlapping sources.** Old active-contract history and new expired history may differ or
  overlap. Reconciliation is measured before a precedence rule is adopted.
- **Contract identity.** Minis and standard contracts can share prices but not lot sizes or
  instrument identities. Never collapse them by root/strike/expiry alone.

Phase 2 reuses `fyers/expired.py`'s pieces rather than a second implementation: the client's
`per_minute` / `max_rate_limit_hits` options, `client.response_state` (ok / no_data / permanent /
retryable / blocked / rate_limited, the states this item asks for; `permanent` is an allow-list,
so an unrecognised error is never cached as final), the per-contract raw cache keyed on the
requested window, the stop-at-budget loop that merges a day only once every expiry it needs is
cached, and the merge that never overwrites an existing row.

Runbook notes (from the NIFTY/SENSEX repair):
- Stored results for repaired days predate the repair, so run `obt legwise rerun` (and
  `obt rotation update --day D` for the days the rotation covers) afterwards; the command's
  summary says so too.
- A contract that keeps getting an unrecognised error (say a 404) is `retryable` on every run
  and holds back its expiry's days (`pending_days`, `retryable_failures`), with exit 0 and no
  override yet. If it persists, a per-symbol skip (`--skip-symbol`) or an attempt count
  across runs is the fix.
- Merging ready days in chunks (`MERGE_CHUNK_DAYS`, 5) re-reads every cached contract of the
  expiries each chunk needs: about 4 passes over a monthly's files. IO only, accepted to bound
  memory. What stays
MCX-specific is discovery (`MCX:` symbols, session bounds) and the instrument identity.

## Open questions

Answered by the owner on 2026-11-11 (Fyers Prime active):

1. **Universe:** all ten roots, full chain, standard and mini (`CRUDEOIL`, `CRUDEOILM`,
   `NATURALGAS`, `NATGASMINI`, `GOLD`, `GOLDM`, `SILVER`, `SILVERM`, `COPPER`, `ZINC`), **after a
   pilot**: pull CRUDEOIL for two expiries first, measure raw and Parquet bytes per contract, and
   confirm the projected total against the free space before the bulk run.
2. **Standard and mini both:** yes (same answer as 1).
3. **Start rule:** any contract with rows on or after 2024-10-21 is included, whatever its
   expiry; the fetch window starts at that date.

## Log

- 2026-10-21 — created at P0. Owner decided to take Fyers Prime and asked to do the MCX history
  in one go. The local Standard-token smoke test proved the new expired API returns 1-minute MCX
  option OHLCV+OI; bulk ingestion waits only for Prime activation and the normal start-item
  questions above.
- 2026-11-11 — started (owner: "I got Fyers Prime, let's start the commodity MCX data pull").
  Read-only probe of the metadata endpoints with the Standard-era client (no candle requests):
  Fyers lists **92,356 option symbols** across the ten roots for 2024-10-21 → 2026-11-10 (GOLD
  21,396; SILVERM 18,362; SILVER 18,156; GOLDM 11,910; CRUDEOIL 5,770; CRUDEOILM 5,762;
  NATURALGAS 3,304; NATGASMINI 3,304; COPPER 2,746; ZINC 1,646; 20-25 expiries each). One candle
  request per contract is about 3.5 hours at 450 a minute, well inside Prime's 500,000 a day. The
  `expiry_dates` window must be at most 366 days, so discovery loops over shorter windows. The
  data volume (`/Volumes/TradingData`, a 200 GiB image) had 36 GiB free, so size is the gating
  fact: the CRUDEOIL pilot decides it.
- 2026-11-11 — Phase 1 built and run (`fyers/mcx.py`, `obt fyers mcx-inventory | mcx-pull |
  mcx-report`, 12 tests). `mcx-inventory --to 2026-11-10 --refresh` froze the manifest
  (`raw/fyers-expired/mcx/manifest-2024-10-21_2026-11-10-<hash>.json.gz`): **92,356 option
  symbols, 0 undecodable**, the same list the probe found; discovery uses the reference future
  from the live MCX master and 300-day expiry windows. **Prime confirmed**: the CRUDEOIL pilot
  (the first two expiries, 2024-11-15 and 2024-12-16, plus 2025-06-16 as a full-life expiry)
  made 434 candle requests with no refusal, no 429 and no retry (Standard stops at 10 a day).
  Pilot figures: 28% of contracts answer `no_data`; the rest average 9,657 rows over all 434
  (largest 29,705); raw cache 28.9 MB = **66 KB a contract**; no contract looked cut off at its
  100-day window start. Projection if every root looks like CRUDEOIL: raw cache about 5.7 GiB and
  about 890 million rows, Parquet about 7 GiB by the report's estimate (sorted by symbol, then time,
  so the real per-day files will be larger; not yet measured). That fits the 36 GiB free, but
  bullion strikes are not CRUDEOIL's, so a GOLD and a SILVER expiry should be pulled before the
  bulk run. Not yet done: the lake write, instrument registration and the MCX session bounds
  (Phase 2 and 3). The Phase 1 "done when" is met.
- **2026-11-11 (bulk pull, import, audit):** pulled all 92,356 contracts in about 3 h 15 min
  (87,544 requests, 20 threads on one paced client, 8/s cap; no refusal, 429 or retry; the resume
  pass asked for nothing). Imported with `mcx-import --roots all`: **277,003,032 one-minute bars**
  in the lake under `asset=option/underlying=<ROOT>` (1.3 GB of Parquet, 513-524 session days per
  root), raw rows = lake rows for every root, 0 duplicates dropped. Only 29,127 of 92,356 contracts
  (32%) have any bars; the rest answered `no_data` (GOLD 2,681 of 21,396, SILVER 2,691 of 18,156).
  `mcx-audit --roots all` **passed**: 0 repeated minutes, 0 out of order, 0 negative price, volume
  or open interest, 0 bars after expiry, 0 missing open interest, and 200 of 200 sampled
  contracts per root identical to the raw cache. Rows by root: CRUDEOIL 44.0M, CRUDEOILM 35.0M,
  NATURALGAS 36.5M, NATGASMINI 27.0M, GOLD 20.4M, GOLDM 40.1M, SILVER 21.6M, SILVERM 37.8M,
  COPPER 11.7M, ZINC 2.8M. Vendor facts, listed and not repaired: 54-248 bars per root whose
  high/low cannot hold their open or close (e.g. `MCX:CRUDEOIL24DEC6050PE` on 2024-12-12 09:00: high 124.8 below open 143.6); 0.1-0.3% of bars outside 09:00-23:55 IST (bars at 23:55 and, on 2026-07-03 and
  07-07, after midnight); 0.4-0.5% of rows on a Saturday or Sunday IST date (not yet explained:
  special sessions? unchecked). `may_be_cut_at_window_start`: 10 SILVERM contracts, 0 elsewhere.
  Quality verdicts: 2 excluded days per root (the Diwali evening session, `short_session`),
  COPPER 5, **ZINC 278 of 513** (`thin_chain`: few contracts trade) so ZINC is mostly unusable as a
  chain. Not done: Phase 4 (daily collector and scheduler job; owner deferred it), the comparison
  of `/data/history` active contracts against the expired API after they expire, the weekend-row
  explanation.
- **2026-11-11 (Phases 4-5 built, first live run):** owner answers: nearest two expiries; run at the
  MCX close (23:30 summer / 23:55 winter) with Angel One completing after midnight; write nightly,
  compare later; Prime dropped in about a month. Probes first: `/data/history` returns MCX option
  bars with OI and a contract's whole life in one request (CRUDEOIL, GOLD, ZINC); Angel One serves
  MCX candles and OI, OI in units (Fyers' lots times 100 for CRUDEOIL), volume in the same units,
  open and low a few ticks different. Built `mcx_daily.py`, `angelone/mcx.py`, `mcx_compare.py` and
  the `mcx-collect` job. First real run, ZINC 10 Nov: 74,683 rows, last bar 23:54, a re-run changed no
  byte of any day file and no row of the backfill. A `--dry-run` with `--source angelone` once ran a
  real Angel One collection (ZINC, 11 Nov so far: 90 rows) because that branch ignored the flag; fixed
  and covered by a test; those Angel rows belong to live contracts and the next Fyers run replaces them.
