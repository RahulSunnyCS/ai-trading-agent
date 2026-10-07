# DECISIONS — trading-data

## Relational, DuckDB + Parquet, on the laptop — 2026-09-30

Owner asked for a local database (laptop now, external disk later) for option- and
momentum-backtesting, sized for adding stock options later. Chosen: a DuckDB catalog for the
relational parts plus a Parquet lake for price bars.

- **Not NoSQL** — the data is fixed-column, joined (contracts ↔ bars ↔ trades) and range-scanned;
  the few free-form parts (strategy specs, run params, ingest details) are JSON columns.
- **Not Postgres/Timescale here** — a server to run and back up, several times the disk for OHLC,
  harder to move to a USB disk. apps/server keeps Timescale for the live app; this is research.
- **Not SQLite** — row store, slow for scans over millions of bars.
- **Bars as files, not rows** — written once, compress 5–10x (1.45M option bars = 15 MB), never
  contend for DuckDB's single writer, and back up incrementally (`tdata backup`). Estimated
  ~1 GB/yr for today's index chains, ~15–40 GB/yr with ~200 stocks' options.
- **Scaling path** — the lake moves as-is to S3/R2 (DuckDB/MotherDuck read it there); only the
  small catalog would move to Postgres, and its SQL is kept plain for that.

## One shared package, not per-package tables — owner decision 2026-09-30

The two backtesting packages shared no code by design. A shared instrument/calendar model is the
point of a shared database, so this package owns the schema and helpers and both depend on it
(editable path dependency), instead of each duplicating instruments and calendars.

## Reference data mastered in the catalog, CSVs exported — owner decision 2026-09-30

The owner chose "move to DB". `packages/market-reference` (TypeScript, runtime dependency of
apps/server) and the Python ReferenceData loader read the CSVs off disk, so they stay — as an
export. `reference.export_csvs` reproduces the committed files byte for byte; drift is a test
failure. `ref_holidays` is keyed on (date, description) because 2025-10-02 closed for two
reasons and the committed CSV lists both.

## instrument_key identity — 2026-09-30

`NSE:OPT:NIFTY:2026-10-06:22700:CE`, `NSE:IDX:NIFTY`, `NSE:STK:RELIANCE`… A text key rather than a
multi-column UNIQUE because NULL expiry/strike on non-derivatives would make a composite UNIQUE
admit duplicates. Stock options are the same shape with a `STK` underlying — no schema change.

## Raw vendor copies kept — owner decision 2026-09-30

Every Fyers history response is kept gzipped under `raw/fyers/date=…/<UNDERLYING>.jsonl.gz`
(~2–3x the Parquet size), so a parsing bug can be fixed by re-processing instead of re-downloading
— which for expired contracts is impossible.

## D-4 (momentum-backtesting's data): stock identity, momentum_prices vs bars_1d, curated
## CSVs stay master — 2026-09-30

**Stock instrument identity is the literal exchange symbol, not the company.** `data/stocks/
daily.parquet` (6.9M rows) has 4,305 distinct raw symbols; momentum's curated rename history
(`aliases.csv`) covers only the ~95 companies that were ever Nifty 50 constituents. Forcing every
symbol through company-level continuity up front would have meant inventing that research for
4,200 names nobody has curated yet. Instead: one `instruments` row per literal symbol string (so
MUNDRAPORT and its later name ADANIPORTS are two rows), linked by the already-nullable
`instruments.company_id` wherever `aliases.csv` says so — zero rows lose data, continuity is just
absent for the uncurated majority until someone curates it. Downstream continuity/adjustment logic
(corporate-action splicing) stays in momentum-backtesting's own code for now; this migration only
stores the raw facts.

**`momentum_prices` (a small catalog TABLE) is deliberately separate from `bars_1d_stock` (the
big Parquet lake).** A stock has one clean daily OHLC bar; "Silver" does not — it is a signal
price, a traded-ETF price, a premium-to-NAV ratio, and a weekly close, each a materially different
series under one plain name (see momentum-backtesting's `store.py`, whose retired Neon schema this
table mirrors exactly, keyed on `(instrument, kind, date)`). Generalizing `bars_1d` to cover that
would have meant a nullable-everything schema; a second table matching the shape that already
existed and already worked was simpler and is small enough (139,895 rows) to not need Parquet.

**The curated CSVs (`companies.csv`, `aliases.csv`, `nifty50_membership.csv`) stay the master
copy** — imported wholesale on every `mbt local migrate` run, same pattern as `reference.py`, and
for the same reason reference data was the one exception to "the owner wants everything in the
DB": this is hand-researched history (Wayback Machine archaeology per their own headers), and
flipping mastery to the DB would cost that history's git diffability for no benefit. By contrast,
`data/categories/category_membership.csv` is a genuinely FETCHED cache (`mbt categories fetch`),
not hand-curated — it migrates in as exactly the kind of CSV cache this database exists to retire.

**`momentum_signals` is created, not yet populated.** Backfilling it needs a one-time pull from
Neon (`MOMENTUM_DATABASE_URL`), which is D-5's job (retiring Neon once the weekly job moves to a
laptop cron) — doing it here would mean touching a second package's credentials/network from a
migration whose only other inputs are local files.

**Same-connection view staleness bit this migration during development** (see
`db.refresh_views`'s docstring): a test that wrote via `migrate()` then queried
`bars_1d_stock`/`instruments` on the SAME open connection got the empty placeholder view, because
`refresh_views` only re-globs the lake when a connection is opened. Every real caller (the CLI,
tests) now reads back through a second `connect()` call.

## D-4 continued: stock-momentum weekly series get their own table, not recomputed — 2026-09-30

`stocks/ui_data.py::load_stock_dataset` needs five ALREADY-ADJUSTED weekly series (total-return
and plain price per company, weekly membership, three benchmark TRIs, cash) that `mbt stocks
fetch` computes from raw daily bars + corporate actions via real logic in `stocks/adjust.py`.
Recomputing that adjustment from `bars_1d_stock`/`corporate_actions` here would duplicate that
logic for no benefit — `003_stock_weekly.sql` stores the CACHED weekly output instead
(`stock_weekly_prices`, `stock_membership_weekly`, and — since `004_stock_weekly_series.sql` —
`stock_weekly_series` for the three benchmark TRIs and cash), matching the choice `002_momentum.sql`
already made for `weekly_closes.csv`.

003 first put the benchmarks/cash into `momentum_prices` (kind='weekly'). That broke on
2026-10-01: `momentum_prices` is wholesale-replaced from the ETF pipeline's files on every
`mbt weekly` run, which deleted the TRIs, and the stock cash series shared the name
`Cash (liquid fund)` with the ETF dataset's shorter cash column, so the two imports overwrote
each other. A table has to have one writer; 004 gives the stock series their own.

`db_read.py`'s `stock_dataset_from_db_or_none()` reconstructs the RAW (pre-rename) shapes
`load_stock_dataset` expects — including translating the DB's canonical benchmark names back to
the CSV's lowercase columns — so `ui_data.py`'s own rename/reindex/concat/tax-class logic runs
completely unchanged regardless of source. Verified: every field of the resulting `StockDataset`
(prices, price_only, membership, companies, tax_classes, extra_instruments) is `==`-equal between
the DB-backed and file-backed paths, and a real `/api/backtest` request returned a byte-for-byte
identical response with all five source files physically removed from disk.

Caught before shipping: `api.py`'s `_Data.get_stock()` had its OWN file-existence check ahead of
`load_stock_dataset` (a leftover from before the DB path existed) that 409'd even with the
database fully populated — the live file-removal test caught this immediately, which is why that
verification step is not skipped even when the underlying loader has already been unit-tested.

## D-4 continued: total_market_membership.csv shares category_membership, not a new table — 2026-09-30

Same (category, year, symbol, source_tier, wayback_timestamp) shape as `category_membership.csv`
— it IS that shape, just always `category='Total Market'`, and the file never contained that
value (verified against the real files before assuming this). Reusing the existing table needed
only a scoped `DELETE ... WHERE category != 'Total Market'` / `WHERE category = 'Total Market'`
pair in `db_migrate.py` so the two imports (`import_category_membership`,
`import_total_market_membership`) never clobber each other on re-run — no new table, no schema
migration needed for a fact that was already knowable from the data itself.

## Leftover file-existence gates are a real, repeating bug class in the wiring work — 2026-09-30

Every dataset wired to the database this way (ETF, Stock, Custom Index, Broad Momentum,
Momentum Scores) hit the SAME bug shape at least once: `api.py` had its own `path.exists()`
check sitting in front of the newly DB-aware loader, left over from before the database path
existed, which 409'd even with the database fully populated. Unit tests never caught this —
they exercise the loader directly, not the FastAPI route's gate above it. Only the live
verification method (run a real request, physically remove the source files, rerun, diff,
restore) caught it, every single time it was present. Six occurrences fixed in one pass
(`_Data.get_stock`, `_custom_index_meta`, `_custom_index_backtest`, `_broad_meta`,
`_momentum_scores_payload`, `_broad_backtest`), all via the same fix shape: OR the existing
`path.exists()` check with a cheap DB existence check (`db_read.has_category_data`/
`has_total_market_data` — a `SELECT 1 ... LIMIT 1`, not a full frame load) before raising 409.
**Conclusion for future wiring passes**: grep the target file for every `.exists()`/404/409
check before considering a dataset "wired," not just its data-loading function — the gate and
the loader are almost always two different call sites.

## Momentum's "Saved runs" store data in backtest_runs.summary, not backtest_days/backtest_trades — 2026-09-30

`option_backtesting/legwise/store.py` (options) splits a result across three tables:
`backtest_runs` (one row per run), `backtest_days` (one row per trading day: gross/costs/net/
worst_mtm/best_mtm), `backtest_trades` (one row per leg fill). That shape fits leg-wise options
strategies exactly — they ARE day-by-day trades.

Momentum's saved runs (`momentum_backtesting/runs_store.py`) are a single weekly equity curve
(dates[] + strategy[] arrays) plus a KPI dict — there is no per-day gross/costs/net breakdown and
no trade-leg structure to normalize into `backtest_trades`. Forcing the weekly series into
`backtest_days` would mean one row per WEEK with most of the options-shaped columns (worst_mtm,
best_mtm, stopped_by) meaningless/NULL, and would still need a second field somewhere for the
KPI dict and the equity-curve arrays themselves. Simpler and equally correct: the whole record
(name, kpis, dates, strategy series, overlay flag) goes into `backtest_runs.summary`, already a
free-form JSON column documented as holding exactly this kind of "net, max_drawdown, cagr,
sharpe …" data. `kind='weekly'` on the row distinguishes it from `options_legwise`'s `'daily'`/
`'adhoc'` rows sharing the same table.

One `strategies` row per momentum dataset (`momentum:etf`, `momentum:stock`, ...) reuses the
existing strategy/version grouping purely as a bucket — unlike options strategies, a momentum
"strategy" here has no independent identity beyond "the settings that produced this run"; the
version hash still dedupes identical reruns for free, which was a nice side effect, not the
reason for the design.

## DSL engine's run registry migrated off `data/registry.sqlite`; its Parquet bar cache deliberately did not — 2026-09-30

`packages/option-backtesting`'s original DSL engine (`obt run`/`registry`/`export-personality`,
the FastAPI `/runs` routes, the MCP server's `run_backtest`/`list_runs`/`critique_result`/
`export_personality` tools) used to record every run in a standalone `data/registry.sqlite`
(plain stdlib `sqlite3`). That state is now `backtest_runs`/`strategy_versions`/`strategies`
in the shared catalog (`package='options_dsl'`, `kind='dsl'`) — the same tables
`legwise/store.py` (`options_legwise`) and `momentum_backtesting/runs_store.py` (`momentum`)
already use, via `engine/registry.py`. `RunRecord`'s field shape and `strategy_hash()` are
byte-for-byte unchanged, so every one of the three call sites (`cli.py`, `api/routes.py`,
`mcp/server.py`) only had to swap a sqlite `Path` for a `duckdb.DuckDBPyConnection` opened
with `trading_data.db.connect()` — no response shape, no CLI output format, no MCP tool
contract changed.

**`strategies.strategy_id` is prefixed `dsl:`** for DSL runs (`_strategy_key` in
`registry.py`) — that column is a single global primary key shared by every package writing
into this catalog, and an unprefixed DSL strategy id (e.g. `nifty_pyramid_B`) could collide
with a legwise or momentum strategy that happens to reuse the same string. (Legwise itself
does not prefix its own `strategy_id` — a smaller, pre-existing risk this migration did not
try to retroactively fix, since doing so would mean rewriting every already-recorded legwise
row; flagging it here so a future migration doesn't reintroduce the same gap elsewhere.)

**The `--registry-db`/`registry_db` parameter was removed everywhere**, not deprecated —
`cli.py`'s `run`/`registry`/`export-personality` commands, `api/app.py`'s `create_app()`, and
`mcp/server.py`'s `resolve_registry_db()` all dropped it in favour of the same env-var-only
convention `legwise`'s CLI commands and `obt daily` already use (`TRADING_DATA_ROOT`, no
per-command override flag). This is a breaking CLI/API change, accepted because this is a
single-operator research tool, not a service with external callers to stay compatible for.

**DuckDB's `TIMESTAMPTZ` needs the optional `pytz` package to materialise into a python
value** — a dependency this package never declared. `record_run`'s `created_at` column is
read back via `CAST(r.created_at AS VARCHAR)` in SQL rather than selecting the raw
`TIMESTAMPTZ`, sidestepping the dependency entirely (an `InvalidInputException` mentioning
`pytz` is the symptom if this regresses). `RunRecord.created_at` was already a plain string
under sqlite, so this changes nothing about the field's type, only how it's fetched.

**Deliberately NOT migrated: the DSL engine's Parquet bar cache (`data/cache/`).** This is a
different concern from the run registry and stays file-based:
- It is sourced from **AlgoTest**, pre-resolved to strike-rule/leg combinations at ingest
  time (`data/ingest.py`) — a fundamentally different shape from the Fyers 1-minute
  concrete-contract lake (`bars_1m_option`) `legwise/` reads, and from the DSL engine's own
  bar-reading contract (`data/cache.py`'s `Cache` façade), so there is no existing lake view
  to redirect it to without inventing a new one.
- `engine/loop.py`'s formulas are pinned to reproduce the original design handoff's reference
  implementation to the rupee (golden-fixture-verified) — that module's docstring says to read
  it before touching any formula, and changing what `Cache` reads from is exactly the kind of
  change that could silently perturb bar selection and break that pinning.
- Nothing about the run registry's storage location bears on this — a recorded run's
  `strategy_yaml` is enough to reconstruct and re-run a strategy against whatever cache is
  configured (see `export/personality.py`), so migrating only the registry loses no
  reproducibility.

Live-verified after the code change (not just unit-tested): ran `obt run` against the real,
already-committed cache, confirmed the printed summary, then independently queried the DuckDB
catalog with a fresh `connect()` to confirm the `backtest_runs`/`strategy_versions`/
`strategies` rows actually exist server-side (not just in the CLI's own process state);
exercised `obt registry`, `obt export-personality <run_id>`, the FastAPI `/runs` and
`/runs/{run_id}` routes, and the MCP server's `list_runs`/`critique_result`/
`export_personality` tools against that same catalog; then repeated the CLI/API/MCP calls
against a brand-new, never-`tdata init`'d root to confirm every surface degrades gracefully
(empty list / 404 / exit code 1) rather than raising on a missing catalog file.

**Unrelated bug found and fixed along the way:** `scripts/build-cache.sh` used GNU-only
`date -d` for weekday checks and date increments — fails outright on a bare macOS install (no
`gdate`), which is why this environment's `data/cache/` was empty before this session touched
it despite the script being required "on a fresh clone" per this package's own `CLAUDE.md`.
Replaced both `date -d` calls with `python3 -c ...` one-liners (portable, and python3 is
already a hard dependency of this whole repo) — behaviour unchanged, now works on both GNU and
BSD userlands.

## The data root moves onto an APFS disk image on the SSD, and refuses to run unmounted — owner decision 2026-10-06

BL-034 loads two years of vendor 1-minute options history: ~110k day files, ~20 GB. The
internal disk has ~39 GB free, and the external SSD is ExFAT with 256 KiB clusters, where
macOS also writes an AppleDouble `._` file beside every file — two clusters per file, ~55 GB
of overhead for this lake. A sparse APFS image on the SSD (`TradingData.sparsebundle`,
200 GB ceiling) has neither cost and keeps atomic renames; the bundle itself is ~8 MB bands,
which ExFAT handles fine.

**Chosen: environment variable + mount guard + login auto-mount**, over hard-coding the path
as `DEFAULT_ROOT` (it would put the owner's laptop layout in the repo, and still need the
guard). The failure that matters is silent: with the image not attached, a process could
create a fresh empty root (or, attached as "TradingData 1", a second one) and the evening
collection would land there. So `data_root()` raises when a root on `/Volumes/<name>` is not
a mount point — resolved through symlinks, so `~/TradingData` can point at the image and a
dangling link fails the same way. `obt`, `obt-api` and `obt-mcp` now load the repo `.env` at
start (before, only commands resolving Fyers credentials did, so `obt daily --no-fetch` used
the default root). `TRADING_DATA_IMAGE` must be double-quoted in `.env` because the launchd
jobs `source` it and the SSD's name has an apostrophe and a space.

## `data_quality`: one verdict per lake file, labels not deletions — 2026-10-06

BL-034 loads ~110k day files from a vendor whose data has real defects (sessions that are
too short, Muhurat evenings, days without spot). Rather than have importers drop what looks
wrong — and lose it silently — every bars_1m file gets a `data_quality` row: **usable**, or
**excluded** with a reason (`off_session_only`, `short_session:<n>`, `thin_chain:<n>`,
`duplicate_bars:<n>`, `no_spot`), plus a `session_kind` (`regular`, `special` for weekend or
holiday sessions, `off_session`). The table mirrors the files one-to-one, so it can always be
rebuilt (`tdata quality rebuild`); the importers write rows as they write files.

Rules, in order, from the busiest instrument's count of regular-session bars (09:15–15:29,
bar start; 375 is a full day): 0 → off-session only; < 300 → short session (the same cut
`fyers/history.py` always used); an option day with < 10 contracts → thin chain; > 375 →
duplicate bars. `off_session_rows` (Fyers' own files keep the 15:30–15:39 closing bars) never
count as bars. `no_spot` is a cross-check: an option day whose underlying has an index series
in the lake but no usable index day. It is set and cleared whichever side arrives last, and
stocks (no index series at all) are left alone. Verified on the eight real Fyers days: all
usable, 375 bars, ~10 off-session rows per contract.

Nothing reads the table yet — legwise's `available_days` still enumerates files — so Phase 1
changes no behaviour; Phase 2 can let readers skip excluded days.

## The vendor importer: per-day pyarrow writes, every row kept, the collector wins — 2026-10-06

`tdata vendor import` re-partitions the vendor's staged per-expiry Parquet (2.11 billion rows)
into the lake's one-file-per-(underlying, day) layout; `import-index` does the same for the
spot and India VIX CSVs.

- **One file per (asset, name, day), sorted by instrument then time.** The daily collector adds
  exactly one immutable file per underlying; a day's chain is read as one file with no filtering;
  DuckDB prunes range scans by the `date=` folder. Rejected: month files (the daily top-up would
  rewrite a growing file, and a crash mid-write risks the month) and per-expiry files (every
  day-load would open five to ten files and filter them). Cost: ~110k small files, which is why
  the lake lives on an APFS image (see the entry above).
- **DuckDB scans, pyarrow writes.** A date chunk (about 8M rows, so ~1 month of NIFTY) is joined
  to the contract→`instrument_id` table into a temp table sorted by (day, instrument, ts); each
  day is then a zone-map-pruned query handed to `lake.write_parquet` — the writer the collector
  uses (atomic tmp+rename, zstd), cast to `lake.OPT_SCHEMA`. This beat `COPY … PARTITION_BY` on
  the points that matter: skip-existing is a `path.exists()`, no rename step, no open-file limit,
  and the per-day quality stats come from the same temp table.
- **Every vendor row is kept.** Closing bars (15:30–15:39; Fyers' own files have them) and the
  special sessions are written; `data_quality` labels the days. Only rows whose contract name
  could not be parsed have no instrument; they are counted in `ingest_runs.details` and
  `quality_issues`, not written. Duplicate `(contract, ts)` rows, if a source ever has them, are
  removed and recorded.
- **The collector always wins.** A file whose `vendor_symbol` is a Fyers symbol is never replaced,
  even with `--force`; a vendor file is replaced only with `--force`. The vendor's contracts reuse
  the collector's `instrument_id` where both name the same instrument — the catalog key is
  `NSE:OPT:<underlying>:<expiry>:<strike>:<CE|PE>`, and the vendor name is added as a second
  alias (`drive-vendor`).
- **Resumable by chunk, and aware of the data.** Each chunk is one `ingest_runs` row; `ok` and
  `partial` (finished, with recorded issues) are done *only if the run saw the same number of
  staged rows* — the scope string alone would swallow new data added to an imported month (the
  missing Aug–Sep 2026 days will arrive that way). A crashed run (`running`) is marked `failed`
  (only the importer's own scopes) and redone. A re-run skips existing day files, and gives the
  vendor-written ones among them a verdict — a crash after writing but before recording used to
  leave those days unjudged. Collector-written days are judged by `tdata quality rebuild`.
  One unit failing (`tdata vendor import`) is reported and the rest continue; exit status 1.
- **A renamed stock is split by its underlying.** The vendor keeps old and new contracts in one
  folder (`GMRINFRA`→`GMRAIRPORT`, `LTIM`→`LTM`, `TATAMOTORS`→`TMPV`, `ZOMATO`→`ETERNAL`; found
  when the first stock batch aborted on `GMRINFRA`). Each symbol becomes its own partition
  family, instrument set and resume chunks — the catalog already keeps a stock under its
  symbol at the time — rather than being rejected or forced under one name.
- **Duplicates are resolved deterministically**: two names for one instrument at the same
  minute keep the higher-volume row, then the lower vendor name — never an arbitrary one.
- **Verified:** a vendor-imported day and a Fyers-written day with the same prices give identical
  legwise trades, fills and MTM curve (`option-backtesting/tests/unit/test_vendor_day_legwise.py`);
  on the real data, NIFTYNXT50's 3,700,483 staged rows came out as exactly 3,700,483 lake rows.

---

## Lot sizes are keyed by the contract's expiry, and checked against the data — 2026-10-07

BL-034 Phase 2. `ref_lot_sizes` now holds the history 2024-10 → today for all six indices, and
its `effective_date` means the **first expiry** a size applies to, not the first trading day.

- **Why per expiry.** NSE and BSE apply a revision to contracts listed from the revision date and
  let the existing weekly and monthly contracts run to expiry on the old size. So on one trading
  day two contracts of one underlying can differ (NIFTY on 2025-01-15: the 16 Jan weekly is 75,
  the 30 Jan monthly 25), and the 30 Jan 2025 monthly sits between weeklies on the new size. A
  day-keyed lookup would size every NIFTY weekly between 2024-11-20 and 2025-01-01 at 75 instead
  of 25. The legwise engine now sizes each leg from its own expiry (`_DaySim._select`).
- **Where the values come from, and the check.** Dates from the NSE/BSE circulars (revisions of
  2024-11-20, 2025-04-25, 2025-10-28 and the SEBI index-derivative framework). Each expiry was then
  checked against the lake: a contract's per-minute volume is a quantity, so its greatest common
  divisor is the lot size. Every expiry of the six indices from 2024-10 to 2026-09 agrees with the
  table (the probe over every day around each transition; the rest on every 9th day).
  Two circular-derived dates were wrong by a day or two in the summaries read (BANKNIFTY/FINNIFTY/
  MIDCPNIFTY monthly handover is the 2025-02-27 expiry, SENSEX weekly 2025-01-07): the data
  decided.
- **Known limit.** A quarterly-month expiry (Mar/Jun/Sep/Dec monthly) changed size mid-life at the
  quarterly cut-over (NIFTY: after 2024-12-26 for the March 2025 expiry). The table gives the
  size from the cut-over; a strategy that traded the 3-months-out contract before then would be
  sized wrong. The "monthly" selector picks the nearest month, so it does not.
- **Strike steps** for FINNIFTY (50), MIDCPNIFTY (25) and NIFTYNXT50 (100) were added; the modal
  gap between the listed strikes near the money agrees for every month since 2024-10.
- **Rows before 2024-10** are deliberately absent: a day earlier than the first row raises
  ("No lot_sizes row") rather than guessing.

---

## Expiries come from the lake, and the holiday list was checked against it — 2026-10-07

BL-034 Phase 2. `ref_expiries` (migration 009, `expiries_observed.csv`) lists every expiry each
index's options actually had, taken from the lake's option files for days from 2024-10-01
(`tdata reference derive-expiries`). `ReferenceData.current_expiry` answers from it inside its
span and falls back to the weekday rule outside it; days-to-expiry is emitted from 2024-10.

- **Why not fix the weekday rule.** Expiry weekdays changed more than once (NIFTY Thursday →
  Tuesday on 2025-09-01; SENSEX Friday → Tuesday → Thursday) and every holiday moves one expiry
  (NIFTY's 2025-10-20 Monday, SENSEX's 2024-10-31 Thursday). A list of the real dates is simpler
  and exact; the rule stays for days beyond the lake.
- **Only from 2024-10.** Earlier vendor history covers expiry weeks only (Phase 5), so a list
  built from it would have holes.
- **Holes the lake has, filled by hand (`source = 'added'`).** The derivation prints any gap
  longer than the cadence (8 days weekly, 9 for SENSEX's weekday move, 38 monthly). Three were
  real holes: NIFTY 2026-09-22 and SENSEX 2026-09-24 (inside the vendor gap, BL-040) and
  SENSEX 2024-10-25 (absent from the vendor's files). The rest were genuine (SENSEX Tuesday →
  Thursday, a Christmas-shifted BANKNIFTY monthly). A re-derivation keeps `added` rows and turns
  them into `observed` once the lake has the contracts.
- **Holidays, audited.** A weekday with no bars from any source (NIFTY spot, NIFTY options,
  SENSEX spot) between 2024-10-01 and 2026-10-06 was closed; a listed holiday with a session was
  not. Result: 8 closures added (2024-11-20 and 2026-01-15 elections, 2025-10-22, 2026-03-26,
  03-31, 05-28, 06-26, 09-14), 3 wrong rows removed (2025-10-20 traded — the Muhurat day was
  10-21; 2026-03-20 and 2026-04-02 traded), "(provisional)" dropped from the verified rows. The
  two Muhurat days stay listed: the normal session was closed, and `data_quality` labels them
  special. Rows after 2026-10-06 are still the published list, unverified.

---

## Backtests leave out excluded days, read from a lock-free file — 2026-10-07

BL-034 Phase 2. `obt legwise run`, the dashboard's backtest route and the daily/rerun runner now
skip the days `data_quality` excludes (special and short sessions, thin chains, option days
without index spot), and report each skipped day with its reason instead of zero-filling it or
crashing. `--include-excluded` keeps them.

- **Why a Parquet copy of the verdicts.** The engine must not depend on the catalog: DuckDB has
  one writer, and `mbt serve` holds the catalog for hours, so even a read-only open fails while it
  runs. `quality/data_quality.parquet` (asset, name, day, verdict, reason, session kind; ~50 KB)
  is rewritten atomically by every rebuild and vendor import and by `tdata quality export`. It is
  outside `lake/`, whose files are immutable day partitions, and is regenerable, so not backed up.
- **No verdict file → every day runs**, with a warning. A day with no verdict row (a Fyers day
  collected after the last rebuild) runs: only an explicit `excluded` leaves a day out.
- **Unrunnable days are named, not fatal.** A missing index or option file and a missing
  reference row (`MissingReferenceData`, e.g. a lot size before 2024-10) used to stop the whole
  run at the first such day; each is now a skipped day with its reason.

