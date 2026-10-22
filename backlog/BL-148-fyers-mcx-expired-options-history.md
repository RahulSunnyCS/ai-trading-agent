# BL-148 — Fyers MCX expired options history: Prime two-year 1-minute backfill into the lake

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-21): take Fyers Prime and do the two-year MCX options backfill next |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / trading-data |
| **Created** | 2026-10-21 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) (canonical lake and quality table); owner activates Fyers Prime; reuses the expired-F&O client, request limiter and raw cache of TODO 3.11.26 (`fyers/expired.py`) |
| **TODO.md row** | — (filled in when started) |

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

### Phase 4 — Active contracts and daily continuation

- **Tasks:**
  - Generalize the existing daily collector's strike centre from spot index to the relevant MCX
    future and add the selected commodity roots.
  - While a contract is active, collect it with the old History API; after expiry, reconcile it
    once with the expired-F&O endpoint and close its manifest entry.
  - Add a post-MCX-close scheduler job with the shared job lock, token/source reporting and a
    Telegram alert on failure. A next-login catch-up uses expired history, so a sleeping laptop
    no longer permanently loses an expiry.
  - Document Prime as required for bulk rebuild speed, not for the normal small daily increment;
    the stored history remains usable if Prime is later cancelled.
- **Deliverables:** daily MCX collection/reconciliation and scheduler entry.
- **Done when:** five consecutive sessions append idempotently, one expired series reconciles
  successfully, and the two-year coverage report advances without manual file work.

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

To resolve when the owner says Prime is active and starts BL-148:

1. Confirm **full chain** for all non-agricultural roots, rather than ATM ±N. The planned default
   is full chain; the inventory gives the exact storage cost before download.
2. Include both standard and mini roots (`CRUDEOIL`/`CRUDEOILM`, `NATURALGAS`/`NATGASMINI`,
   `GOLD`/`GOLDM`, `SILVER`/`SILVERM`) plus `COPPER` and `ZINC`? Planned default: yes.
3. Is the initial fixed start exactly 2024-10-21, or the earliest expiry on/after that date?
   Planned default: include any contract rows on or after 2024-10-21, regardless of expiry date.

## Log

- 2026-10-21 — created at P0. Owner decided to take Fyers Prime and asked to do the MCX history
  in one go. The local Standard-token smoke test proved the new expired API returns 1-minute MCX
  option OHLCV+OI; bulk ingestion waits only for Prime activation and the normal start-item
  questions above.
