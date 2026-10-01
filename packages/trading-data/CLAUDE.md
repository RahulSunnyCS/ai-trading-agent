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
- `lake/` — immutable Parquet price data, read through TEMP views (`bars_1m_option`,
  `bars_1m_index`, `bars_1m_future`, `symbol_master`, `bars_1d_stock`)
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

- **One writer.** DuckDB allows one read-write process; a read-write connection also
  blocks other processes' readers. Use `connect()` as a short context manager — never
  hold it across a long download (see how `fyers/daily.py` opens it only to register
  and to finish the run).
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
uv run tdata init | status | backup --to <dir>
uv run tdata reference export | check | sql "<statement>"
uv run mbt local migrate   # from packages/momentum-backtesting/: (re-)import its data
```
