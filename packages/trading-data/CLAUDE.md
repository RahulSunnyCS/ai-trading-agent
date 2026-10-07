# CLAUDE.md

Guidance for Claude Code when working in this package. Design choices and their
reasons are in `DECISIONS.md`; the monorepo-wide picture is in the root
`.claude/project/technical.md` (Package Index).

## What this package does

The local research database shared by `packages/option-backtesting` and
`packages/momentum-backtesting` (both editable path dependencies). Everything
lives under `TRADING_DATA_ROOT` (default `~/TradingData`):

- `catalog.duckdb` — tables from `src/trading_data/migrations/*.sql`:
  - `001_core.sql`: instruments + vendor aliases, reference data (lot sizes, strike
    steps, expiry rules, holidays, margins), ingest runs + quality issues,
    strategies/versions, backtest runs/days/trades
  - `002_momentum.sql`: companies + renames (`company_symbols`), corporate actions,
    index/category membership, `momentum_prices` (index/ETF/commodity/premium/weekly
    series, mirroring momentum-backtesting's retired Neon schema), `momentum_signals`
  - `003_stock_weekly.sql` / `004_stock_weekly_series.sql`: the Nifty 50 stock dataset's
    cached weekly series (`stock_weekly_prices`, `stock_membership_weekly`,
    `stock_weekly_series` for its benchmark TRIs and cash)
  - `005_stock_action_candidates.sql` / `006_stock_action_scan_state.sql`:
    large-drop review candidates, persistent split/bonus/crash decisions,
    cumulative share factors, and the baseline after which new events need
    user review
  - `007_momentum_forward_journal.sql`: `momentum_forward_journal`, the append-only,
    hash-chained record of every weekly momentum signal (BL-024; written only by
    momentum-backtesting's `forward_journal.record`)
  - `008_data_quality.sql`: `data_quality`, one verdict per lake partition (asset, name,
    day) — usable, or excluded and why; mirrors the Parquet files, rebuilt from them by
    `tdata quality rebuild` (BL-034)
  - `009_ref_expiries.sql`: `ref_expiries`, every expiry each index's options actually had
    (from the lake, `tdata reference derive-expiries`; a few added by hand where the lake has
    a hole), exported as `expiries_observed.csv`; days-to-expiry reads it (BL-034 Phase 2)
  - `010_ref_rates.sql`: `ref_rates`, the RBI repo rate from each policy decision date
    (`rates.csv`), the risk-free rate for implied volatility (`ReferenceData.risk_free_rate`)
- `lake/` — immutable Parquet price data, read through TEMP views (`bars_1m_option`,
  `bars_1m_index`, `bars_1m_future`, `symbol_master`, `bars_1d_stock`). One file per
  (asset, name, trading day); `lake.BAR_SCHEMA` / `lake.OPT_SCHEMA` are the one definition
  every bars_1m writer casts to (the Fyers collector imports them). `lake.write_parquet` refuses
  a bars_1m file with any other schema: the 1-minute and derived views bind from the first file
  without `union_by_name` (`db.FIXED_SCHEMA_VIEWS`), which would silently cast or drop a later
  file's differing columns
- `lake/derived/` — tables rebuilt from bars_1m by `tdata derived rebuild` (`derived.py`,
  BL-034 Phase 3; NIFTY and SENSEX by default): `chain_snapshots_5m` (per 5-minute window:
  ATM±10 strikes of every expiry within 45 days — OHLC, volume, OI, spot, VIX, DTE, implied
  forward, Black-76 IV and greeks, `iv_quality`), `straddle_series_5m` (ATM straddle at each
  window's start and close, ATM IV, 5-step skew), `contracts_daily` (per contract per day) — one
  file per (underlying, day) — and `iv_daily` (one file per underlying: ATM IV at 09:20/15:00
  per expiry, 7-day constant-maturity IV, VIX, 20-day realised vol, trailing 1y/2y percentiles —
  rank `iv_7d_1500`). Views of the same names (static placeholder columns in `db.LAKE_VIEWS`,
  checked against the schemas by a test, so `db` never imports numpy).
  Each file carries `derived_version` in its Parquet metadata; a rebuild redoes only missing
  or out-of-version files. `obt legwise run --bars 5m` runs the unchanged engine on them
- `raw/` — gzipped verbatim vendor responses

A stock's identity is its literal exchange symbol at the time (one `instruments` row
per symbol string, so a rename like MUNDRAPORT → ADANIPORTS is two rows) — linked to a
`company_id` only where a package has curated that rename history (momentum's
`aliases.csv`, today just the ~95-company Nifty 50 universe); an unlinked symbol still
gets its own instrument and bars, just no cross-rename continuity yet. Individual
stocks' bars are Parquet (`bars_1d_stock`, year-partitioned — 6.9M+ rows); a handful of
cross-instrument series that aren't one clean OHLC bar (an index's signal price, its
traded ETF, its premium-to-NAV, its weekly close) stay in the small `momentum_prices`
table instead.

## Rules that matter

- **The root may be an external volume.** On the owner's laptop `TRADING_DATA_ROOT` is
  `/Volumes/TradingData`, an APFS disk image on the SSD. `data_root()` raises if a root on
  `/Volumes/<name>` is not mounted (`check_mounted`) — never fall back to a default or let
  `connect()` create a fresh root. `tdata mount` attaches `TRADING_DATA_IMAGE`; the
  `deploy/launchd` job `trading-data-mount` runs it at login and when a volume appears.
- **One writer.** DuckDB allows one read-write process; a read-write connection also
  blocks other processes' readers. Use `connect()` as a short context manager — never
  hold it across a long download (see how `fyers/daily.py` opens it only to register
  and to finish the run).
- **Never hold a catalog connection across a request or a long computation.** Open, query,
  close: not app-lifetime or module-level, not across a network fetch, a backtest, a streamed
  response or a generator's `yield`. Every other process (`obt daily`'s save, `tdata`) waits on
  it and gives up after `lock_wait` (10 s). Heavy reads of lake data run on an in-memory DuckDB
  over the Parquet instead (`refresh_views` works on any connection), with the catalog open only
  to copy the small table they join (momentum's `db_read.stock_bars`). On 2026-10-07 `mbt serve`
  broke this and `tdata` / `obt` timed out.
- **`connect(views=...)` binds only the lake views a caller reads.** Binding runs with the
  catalog locked: on the live lake all views took 21-33 s per connection before
  `FIXED_SCHEMA_VIEWS`, ~1 s after (2026-10-07; timings in `db.py`). The default (None) still
  binds all of them; a caller passes the ones it reads (momentum: `("bars_1d_stock",)`) or `()`.
  Nothing in this package or `option-backtesting` reads a lake view through the catalog (the
  readers open the Parquet directly; `tdata status` counts on an in-memory DuckDB), so every
  `connect()` there passes `views=()`; a test in each package fails on one that does not.
- **Migrations by filename**, like apps/server's runner: never edit an applied
  migration, add `NNN_name.sql`.
- **No FOREIGN KEYs** (DuckDB checks them over-eagerly); relations are documented in
  the migration and kept by the writers.
- **Reference data: the catalog is master.** The CSVs in
  `packages/option-backtesting/src/option_backtesting/data/reference/` are EXPORTED
  (`tdata reference export`) because `packages/market-reference` (TypeScript, used by
  apps/server) and the Python `ReferenceData` loader read them. Change data with
  `tdata reference sql "..."` (edits + re-exports); `tdata reference check` / the
  test suite fail on drift.
- **Vendor imports keep every row and never overwrite the collector.** `vendor.import_unit` /
  `import_index_csv` (BL-034) write one file per (asset, name, day) in the Fyers shape,
  including closing bars, weekend sessions and Muhurat evenings; `data_quality` labels them.
  A day file the Fyers collector wrote is never replaced, even with `--force`. Work is cut
  into date chunks, each one `ingest_runs` row (`scope = 'NIFTY 2025-06-01..2025-06-30'`); a
  chunk that finished (`ok` or `partial`) is skipped on a re-run.
- **`data_quality` mirrors the lake.** One row per bars_1m file, written when a file is
  written and regenerable with `tdata quality rebuild`; a day is never dropped from the lake
  for a bad verdict — the label says why, readers decide. Fetch timestamps from DuckDB as
  epoch seconds, not `TIMESTAMPTZ` (that import needs `pytz`, which is not a dependency).
- **The evening run judges one day with `quality.judge_day`** (one connection, ~20 s), not
  `rebuild(days=...)` (a connection per known name — minutes, and it waits on every one while the
  catalog is held).
- **Readers get verdicts from a file, not the catalog.** `quality.SNAPSHOT`
  (`$TRADING_DATA_ROOT/quality/data_quality.parquet`) is rewritten after every rebuild and vendor
  import (and by `tdata quality export`); `quality.excluded_days()` reads it without the catalog
  lock, which `mbt serve` can hold for hours. The legwise engine leaves out the days it lists
  (`legwise.market.backtest_days`; `--include-excluded` to keep them). Not backed up: regenerable.
- **A derived 5-minute row is known at the window's END.** Row `bucket` T covers [T, T+5):
  its `open` is its first minute's open (the last earlier close when that minute had no trade) —
  the bar a stop's gap is checked against; the price AT T, which fills use, is the previous
  window's close (`Series.price_at`, BL-009). Everything else is the window's, and
  IV/greeks/forward come from its close. Nothing is carried past the last minute that has an index bar.
  `tests/test_derived.py::test_no_window_uses_later_bars` cuts a day short and requires every
  earlier window to be unchanged — keep it passing when changing `derived.py`, and bump
  `DERIVED_VERSION` with any formula or column change.
- **Partition values live in folder names only** (`asset=`, `underlying=`/`symbol=`,
  `date=`) — never repeat them as columns inside the Parquet.
- Tests use `tmp_path` roots; never point a test at the real `~/TradingData`.

- **Views are snapshotted when `connect()` opens**, not live. A write made through a
  connection is invisible to a query on that SAME connection afterward if the target
  view didn't exist (no matching files) when that connection opened — always read
  back through a fresh `connect()` (see `db.refresh_views`'s docstring).

## Commands (from any package that depends on this one, or here)

```bash
uv sync && uv run pytest
uv run tdata init | status | backup --to <dir> | mount
uv run tdata quality rebuild [--asset option] [--name NIFTY] [--days A..B] | status | export
uv run tdata derived rebuild [--underlying NIFTY] [--day D | --days A..B] [--force] [--check]
uv run tdata vendor import --from <staging> [--unit nifty] [--section index|stocks] [--days A..B] [--force] [--dry-run]
uv run tdata vendor import-index <csv> --symbol NIFTY|BANKNIFTY|SENSEX|INDIAVIX [--days A..B]
uv run tdata reference export | check | sql "<statement>" | derive-expiries
uv run mbt local migrate   # from packages/momentum-backtesting/: (re-)import its data
```
