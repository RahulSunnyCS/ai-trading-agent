# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this package.

For setup, data-source details, and the full `mbt` command reference, see
this package's own `README.md` first — this file stays a short orientation
pointer plus the cross-package/utility-function summary the README doesn't
cover. For open work items (Broad Momentum, Momentum Scores, the mass-exit
trigger, the multi-lever sweep, etc.) see the root `TODO.md`'s §3.9 rows —
that is the single source of truth for this package's in-flight work, not
this file.

## What this package does

Python 3.12/uv weekly momentum-rotation research tool: ranks ~21 NSE
sector/broad indices plus gold, silver, Nasdaq 100, Hang Seng and a
defensive cash/gilt pair on trailing returns, holds the top N until they
fall out of the top M (hysteresis). Three additional layers build on the
same ranking mechanics: `stocks/` (a from-scratch, survivorship-free Nifty
50 stock data layer), `categories/` (sector/category momentum, including the
Broad Momentum three-layer funnel and per-stock/sector Momentum Scores page),
and a private FastAPI service (`mbt serve`) used by the shared Next.js dashboard. See `README.md` and `TODO.md` §3.9 for
what's built vs. still open.

## Cross-package links

**Shares no code directly with `packages/option-backtesting`** — still true,
and do not add a cross-import between them. They are both Python/uv with
entirely separate `pyproject.toml`/`uv.lock` files; the pinned-same-library-
versions comment for the FastAPI service remains cosmetic, not
functional.

**Since 2026-09-30, both depend on `packages/trading-data`** (an editable
path dependency), the new, deliberately-shared location this file's older
version above was already anticipating — not a cross-import between the two
backtesting packages, one shared local database both read/write
(`TRADING_DATA_ROOT`). `db_migrate.py` (`mbt local migrate`) is the one-off
copy of this package's own data into it: companies/renames/corporate-actions/
membership (`companies`, `company_symbols`, `corporate_actions`,
`index_membership`, `category_membership` tables), stock daily bars
(`lake/bars_1d/asset=stock/`), and the index/ETF/premium/weekly price series
(`momentum_prices` table, mirroring the — now superseded — Neon schema
below). See `packages/trading-data/DECISIONS.md` and this repo's root
`technical.md` (TODO 3.11) for the full design.

**`db_read.py` is the live (not one-off) read path — all four datasets, since
2026-09-30 (TODO 3.11.8).** Every raw-file read behind `api.py`'s `_Data.get()`
(ETF), `_Data.get_stock()` (Stock), and the shared functions Custom Index and
Broad Momentum both call (`categories/resolve.py::_load_membership`,
`categories/compose.py::_category_available_years`,
`categories/broad.py::total_market_members_by_year`, and — the one piece both
of those datasets' inner backtests actually price stocks through —
`categories/prices.py::load_daily_prices`) now prefers the shared database
over its file, falling back to the file when the catalog has no rows yet (a
fresh checkout, or a test fixture — none of which touch `TRADING_DATA_ROOT`,
isolated by `tests/conftest.py`'s autouse fixture). This is the backend the
new Next.js dashboard's Momentum tab
(`apps/dashboard/src/components/MomentumBacktestingView.tsx` → Fastify
`/api/momentum/*` → this same `api.py` process on :8765) serves from — the
REST contract never changed, only what's behind each read.

**Only the raw-data read functions above were touched — never the ranking/
selection algorithms themselves** (`engine.run_backtest`,
`categories/broad.py`'s category-selection funnel,
`categories/compose.py`'s per-category inner backtests are all unmodified).
Verified live, not just unit-tested, for every dataset: ran a real request
against the running service, moved the real source files aside (including
`daily.parquet`, 175 MB), reran the identical request, confirmed a
byte-for-byte identical response, restored the files. This caught two real
bugs unit tests missed — leftover `path.exists()` gates in `api.py` that
would 409 even with the database fully populated (`_Data.get_stock()`, then
five more sites across Custom Index/Broad Momentum/Momentum Scores) — see
`TODO.md` §3.11.8 for the full list and `trading-data/DECISIONS.md` for why
`total_market_membership.csv` shares the `category_membership` table.

No TypeScript package imports this or is imported by it. It no longer talks to Neon
(`MOMENTUM_DATABASE_URL`, retired 2026-09-30 — TODO 3.11.5): the weekly job's price history
and signal storage now go through `local_store.py` into the shared `trading_data` catalog's
`momentum_prices`/`momentum_signals` tables, the same ones `db_migrate.py`'s `mbt local
migrate` writes — `local_store.push_dir` literally calls `db_migrate.import_momentum_prices`
rather than duplicating it, so there is exactly one writer of that table now, not two
separate paths. `store.py` is reduced to the pure file<->rows conversion
(`rows_from_dir`/`write_dir`) both `db_migrate.py` and `local_store.py` still share. It talks
to `DATABASE_URL`'s `broker_tokens` table only as one of several places `fyers.py` looks for
a Fyers access token (see the precedence order in root `technical.md`'s Environment
Variables table) — that connection is unrelated and still live.

The weekly job (`mbt weekly`) itself runs from the repo's scheduler (`apps/scheduler`,
BL-012 — four jobs: Friday 14:40 preview, 16:45 final, 19:30 stock-data ingest, 21:00
forward-journal check IST), replacing first the retired `.github/workflows/momentum-weekly.yml`
and then the per-job launchd plists. The scheduler passes the repo root `.env` to each run
and still writes `data/launchd-weekly-<run>.log`, which `GET /api/weekly/status` reads. The CLI's `weekly()` command is a thin wrapper around
`api._execute_weekly_run` (the same function the API route calls) — there is exactly one
orchestration, not two copies that can drift.

**A blocked or missing active favourite now sends a Telegram warning** (not silence), except
that a stock-based headline (Stock, Custom Index, Broad) is not reported as blocked by the 14:40
preview or 16:45 final, which cannot evaluate it: the 19:30 rerun sends it (BL-051) —
previously a favourite that failed (e.g. the tax-config bug below) meant the job computed a
signal, found no usable active result, and exited 0 with nothing sent and no alert, for every
run, for over a week, before anyone noticed.

**Backtest runs are background jobs too** (2026-10-03): `POST /api/backtest/jobs` (202) →
`GET /api/backtest/jobs/{id}` / `GET /api/backtest/jobs` (list, no results), proxied at
`/api/momentum/backtest/jobs*`. `_BacktestJobs` in `api.py` keeps many jobs in memory (30 max,
lost on restart), runs at most 3 at once (CPU-bound — more only slows each) and queues the
rest; a `fresh: true` run (`DATA.reset()`) runs alone so it never wipes caches under another
run. The synchronous `POST /api/backtest` still exists (tests, scripts).

**Catalog rule (2026-10-07): never hold a catalog connection across a request or a long
computation.** `mbt serve` holding `catalog.duckdb` made `tdata` and `obt` (and so the evening
`obt daily` save) time out on its lock. Every connection in this package goes through
`db_read.open_catalog()` (a `with` block around one short unit of work; binds only
`bars_1d_stock`, since binding the 1-minute lake views cost ~20-35 s per connection with the file
locked) or `db_read.stock_bars()` (the heavy daily-bar reads — Broad's prices, the liquidity and
circuit windows — on an in-memory DuckDB over the Parquet; the catalog is open only to copy the
stock rows of `instruments`). A read opens it read-only: `db_read.read_catalog()` when the
endpoint used to open it for writing only so that it migrated (migrates once per process, then
read-only), since a read-write connection holds off every other request's (`trading_data.db`'s
in-process lock) and other processes' readers; `tests/test_catalog_concurrency.py` pins the
polled GETs to read-only. Never import `trading_data.db.connect` directly, never keep a
connection on the app, a module or a cache, and never pass an open one into code that fetches or
backtests: the weekly run takes a `catalog` factory (`weekly.run_weekly(catalog=open_catalog)`)
and opens it around each store; `fyers_topup.run_fyers_topup` reads, fetches, then writes in
separate connections. `tests/golden/test_catalog_release.py` runs the heavy endpoints on the golden
fixture with an unreadable 1-minute lake file and, after each, opens the catalog for writing from
another process; `test_weekly.py` checks no connection is open during the refresh or the backtest.
Still a single long write by design: `mbt local migrate` (`db_migrate.migrate`, the 19:30 sync).

**Caching rule (BL-005, 2026-10-06): key any cache of shared-database data on
`db_read.data_version()`, never on `db_read.catalog_mtime()`.** The catalog file's mtime moves on
every write, and the dashboard saves each finished run into it (`POST /api/saved-runs`), so an
mtime key emptied every cache (prices, rank tables, the ~20 s Broad ranking, liquidity features,
circuit masks) before the next run. `data_version` is a content hash of every table except the
run-record ones (`RUN_RECORD_TABLES`), recomputed only when the mtime moves (~0.1 s), plus the
stock lake files' sizes and times (`db_read.table_fingerprints`); if the catalog is locked it keeps the last
known version instead of changing the key; `catalog_mtime` stays only as the "is there a catalog" check.
On top of those caches, `_dispatch_backtest` keeps the last 8 whole results
(`DATA.result_cache`), keyed on the canonical request (`request_key`) and `input_version()`
(`data_version` plus every input file under `data/` and the curated folders). Every response
carries `cache: {hit, computed_at}`; `fresh: true` clears it with everything else. Responses are
gzipped (`GZipMiddleware`).

**A background job's result is the core only; the heavy sections are fetched on their own
(BL-005 Phase 2).** `analysis.payload_parts` / each dataset's `_*_parts` return `(core, lazy)`:
`lazy` maps `trades`, `instruments`, `timeline`, `latest` (and, Broad only, `circuit_exposure`,
which costs a second engine run) to builders. `run_parts.RunParts` holds them, builds each once on
first use and drops the builder (it holds the run's frames, and for Broad its whole ranking). The
result cache stores `RunParts`; only the newest `DATA.LIVE_RESULTS` = 4 keep sections they have not
built (`RunParts.release()`), so memory does not grow with how many settings a session tries.
`_dispatch_backtest` (the synchronous `POST /api/backtest`) and the `_*_backtest(req)` functions the
weekly job calls still return the **whole** payload (`core + every section`), so goldens, journals
and `payload["latest"]` readers see no change. A job's `result` is `core + cache +
sections_available`, and `GET /api/backtest/jobs/{id}/sections/{name}` returns `{section, data}`
(404 unknown job or a section the run lacks, 409 not finished or failed, 410 released: only the 4
jobs that finished most recently, `_BacktestJobs.MAX_PARTS`, keep their sections, and a `fresh`
run releases them all). The weekly prices a section needs are held from the run (`outer_prices`
for the circuit card); the circuit card also reads daily bars and lock masks from the database
when it is opened, so a data refresh in between can move it slightly. Dashboard:
`store/momentumRuns.ts` `loadSection` merges a section into the run's result;
`hooks/useRunSection.ts` asks for it when the tab or card that shows it mounts. A new section needs
its name in `api.BacktestSection` and `MomentumSectionName` in `types/momentum.ts` (the Fastify
proxy and the Next rewrite take any well-formed name; the service rejects unknown ones).

**Speed work and how it is checked (BL-005 Phase 3).** `scripts/bench-backtest.py` times a golden
scenario cold, warm (result cache cleared), cached and through the job route, with inclusive
seconds per stage; it builds its data from the golden fixture so two runs are comparable
(`--live` for real data, `--profile` for cProfile). The engine reads its tables through
`engine._Grid` (an array and two dicts: ~10 µs a `DataFrame.at` call became a dict lookup), and
`top_names` finds the end of the sorted top-N prefix with `searchsorted`. Each such rewrite is
pinned against a verbatim copy of the original on random data (`tests/test_engine_grid.py`,
`test_analysis_rotations.py`, `test_circuit_runs_equivalence.py`,
`categories/test_effective_ranks_equivalence.py`, `categories/test_forward_filled.py`): the goldens
prove a result did not move on 16 scenarios, these prove the replaced code still does the same
thing on the cases the scenarios miss (ties, gaps, missing values). Building a DataFrame from an
object array infers a string dtype in this pandas: pass `dtype=object` where object is meant.
Replacing many columns one at a time (`frame[col] = ...`) fragments the frame: build it in one step.

**A running job says which step it is in (BL-005 Phase 4).** `_BacktestJobs` hands a job's work a
`report(stage)` callback (a plain zero-argument callable still works: the executor checks the
signature); `_dispatch_parts(req, report)` passes it to `_etf_parts` / `_stock_parts` /
`_custom_index_parts` / `_broad_parts`, which call it with `loading` -> `ranking` (Custom Index's
category build, Broad's Step 2) -> `simulating` -> `analysing`. The job record carries `stage` (None
before and after, and in the job list) and `stages` (`api.JOB_STAGES`, the ordered list: the
dashboard numbers "Step 2 of 4 · Ranking" from it, so a new step needs adding there and to
`STAGE_LABELS` in `MomentumRunProgress.tsx` only for a nicer label), and `compute_ms`, the
computation time in milliseconds (the `*_at` timestamps are whole seconds). The dashboard keeps the
median of the last five real (non-cache-hit) `compute_ms` per dataset in localStorage to say
"usually about 20 s" (`lib/momentumDurations.ts`), and past twice that it explains the slow run
instead (cold runs rebuild rankings). A job's work takes `report` only if it declares a required
positional parameter (`_takes_report`). The synchronous callers (`_*_backtest(req)`) pass nothing.

**Checking that a change leaves results alone on live data:**
`scripts/result-baseline.py capture` stores every golden scenario and every saved favourite as
the real API returns them today; `compare` re-runs them and reports differences, whether the data
changed since, and each run's time and size then and now. The goldens cover frozen data; this
covers the real data and the real favourites. The dashboard side is
`apps/dashboard/src/store/momentumRuns.ts`: a module-level store + poller (so runs survive
leaving the page; in-flight ones are mirrored to localStorage) rendered as one tab per run in
`MomentumBacktestingView.tsx`; finished runs are auto-saved as Saved runs by the store.

`POST /api/weekly/run` (`api.py`, proxied at `/api/momentum/weekly/run`) backs the dashboard
Momentum tab's "Weekly signal" section and runs the same all-favourites orchestration as the
CLI and scheduled job: every favourite is evaluated, while only the one global active
favourite is sent to Telegram. Since 2026-10-02 this runs as a **background job**
(`_SingleFlightJob` in `api.py`; `GET /api/weekly/jobs/latest` polls it) so a manual run
survives the browser tab closing or the user switching sections — the Momentum tab itself
shows a pulsing dot while one is in flight. `GET /api/weekly/status` reports, per dataset, the
date it's ingested through vs. the week a final run needs, the last few saved signals, and
each scheduled job's last-run time (flagging one that fired >10 minutes late — typically the
laptop was asleep at 14:40/16:45/19:30 and the scheduler caught the slot up on wake).

ETF strategies share one refreshed Fyers/public-source snapshot and are always current. Stock,
Custom Index and Broad strategies are gated on the processed bhavcopy-backed dataset reaching
the completed Friday-labelled week — **nothing refreshed that data weekly until the
2026-10-02 19:30 IST job**: `mbt stocks sync` (`stocks_fetch` + `local_migrate`, in that
order). `stocks_fetch` alone is not enough once the catalog has been migrated once —
`stock_dataset_from_db_or_none`/`daily_prices_from_db_or_none` (`db_read.py`) keep serving the
already-migrated rows regardless of what's on disk, so the migrate step has to run every time
too, or the "data through" date silently stops moving. A "Refresh stock data" button in the
dashboard's Data panel runs the same `mbt stocks sync` as a background job. The 19:30 job
reruns the weekly orchestration with `--only-dataset stock --only-dataset custom_index
--only-dataset broad` so it only sends to Telegram if the active favourite is one of those —
otherwise it would resend (or misreport as "blocked") an ETF favourite the 16:45 job already
handled.

**`mbt stocks deadlines` (BL-012, 2026-10-07)** prints one read-only JSON line — the age of
each corporate-action change not yet pinned (`adjust.diff_ca_events`, the same age
`check_ca_diff_age` fails the Friday sync on above 30 days) and `stock_actions.review_snapshot`'s
pending split/bonus count. The scheduler's `check-stock-*` jobs (08:40 IST) call it; it never
writes and opens the catalog read-only.

**Forward-signal journal (BL-024, 2026-10-06).** Every weekly run also appends each signal it
produced to `momentum_forward_journal` (`forward_journal.py`; trading-data migration 007): every
favourite's final, ETF previews only on a Friday, and the Nifty200 Momentum 30 TRI level once its
data covers the week (so in practice from the 19:30 job). Append-only and hash-chained — DuckDB
has no triggers, so an edit cannot be refused, only detected (`mbt journal verify`); the chain
head goes into that run's Telegram message (or a separate "forward journal" message when the
run sends nothing else, e.g. the 19:30 rerun) as an outside witness. A rerun with an identical
signal writes nothing; a changed one is a new row with `supersedes`. `holdings_before` is the
model portfolio **before** the signal's own actions — `run_backtest` never trades its newest
week (`trade_weeks` excludes it), so the post-trade portfolio first appears in next week's row.
Use `momentum_signals` for the latest signal (it is overwritten on rerun); use the journal for
evidence. A journal failure never blocks the signal and is reported in Telegram.
After the Friday runs, a 4th LaunchAgent (21:00 IST, `momentum-weekly-journal-check`) runs
`mbt journal check --send`: every favourite's final, each ETF favourite's Friday preview and the
benchmark level should be in under this week; a favourite whose signal is labelled an earlier
week is reported as "wrong week", not missing. The dashboard's **Momentum › Journal** page
(`MomentumJournalView.tsx`, `GET /api/journal` → Fastify `/api/momentum/journal`) shows the
same check, the chain status and every entry by week.

**Gotcha found live, not by a test:** `stocks_fetch`/`local_migrate` are Typer commands whose
parameters default to `typer.Option(...)` sentinel objects — Typer only resolves those into
real values (e.g. `"2011-01-01"`) when its own CLI runner invokes the function. Calling them
directly as plain Python, which `stocks_sync`/`_execute_stock_sync` do, needs every argument
passed explicitly or the first one crashes with `TypeError: fromisoformat: argument must be
str`. `mbt stocks sync` and the 19:30 IST job also need real network access to `nseindia.com`
specifically — `mbt sources-check` does not cover it (only Yahoo/AMFI/niftyindices/Fyers), so
a machine can look healthy on `sources-check` while this still fails.

**`nseindia.com` itself is frequently unreachable, by design on NSE's side, not an
environment problem.** Confirmed live (2026-10-02): the last successful fetch was 6 days
earlier with no code change in between, so NSE's Akamai WAF tightened sometime in that
window. A `curl`/`urllib` request with a complete, correct real-browser header set still
gets an instant 403 from Akamai's edge (`errors.edgesuite.net`) while an actual browser on
the same network loads the site fine — this is TLS/behavioural fingerprinting, not header
matching, so `nse.py`'s `warm_up()` now gets its session cookie from a real Chromium
instance (Playwright, pinned `1.63.0`, matching `packages/broker-login`'s) instead of a
bare `urllib` GET. It specifically launches **headed, not headless** — confirmed live that
headless Chromium is itself detected and blocked (`net::ERR_HTTP2_PROTOCOL_ERROR` or a flat
30s hang) while the identical browser launched headed-but-positioned-off-screen
(`--window-position`) passes. Needs a GUI session to open that window at all, which is why
this only runs from a `launchd` LaunchAgent (has GUI session access), never a LaunchDaemon
or headless CI runner. Even that path is intermittently flaky (1 failure in 6 back-to-back
live attempts), so it retries with the same bounded backoff every other NSE call has — but
a whole run can still fail if NSE has a bad stretch. **Fyers fallback, both datasets:**
`mbt stocks sync` (default `--fallback-to-fyers`) catches specifically `nse.NseError`
(never a bare `Exception` — a real data-quality guard failure, e.g. the dividend check,
must still fail loudly) and runs TWO stopgaps in `stocks/fyers_topup.py`:
`run_fyers_topup` fills just the missing week for the ~50 currently-listed Nifty 50
companies from Fyers daily closes — a plain-price stopgap (Fyers has no corporate-actions
feed, so no true total-return), written directly into `stock_weekly_prices`/
`stock_membership_weekly`. `run_fyers_topup_total_market` does the same for Broad
Momentum/Custom Index's much larger ~755-symbol Total Market pool, writing directly into
the `bars_1d_stock` **lake parquet** (not a plain table — merged into the current year's
partition file, reading it back first so older rows survive, never wholesale-overwritten)
with real daily OHLCV bars (Fyers gives a full bar, not just a close) tagged
`synthetic_close=True`, the same flag `stocks/adjust.py`'s own archive-gap fill already
uses, so `stocks/guards.py`'s pipeline already knows not to flag these as suspicious price
jumps. New symbols get registered into `instruments` on the fly
(`db_migrate.register_stock_instruments`), same as a real sync would. Both are
self-healing: everything they touch is wholesale-replaced by the next successful real NSE
sync (`db_migrate.import_stock_weekly`/`migrate_stock_bars`), so a stopgap row never
outlives it. Live-verified end to end (2026-10-03): NSE failed, both fallbacks ran, Total
Market filled 745/755 symbols (2,980 rows) in a few minutes, and a subsequent `mbt weekly`
produced real BUY/SELL/ADD signals for all three previously-blocked favourites (Stock
Weekly Core, Broad Weekly Core, Fav 1).

Python callers here do not import `@trading/notify` — `notify.py` mirrors
the `Notification` shape directly rather than importing the TypeScript
package (see that package's `CLAUDE.md` for why the boundary is the
contract, not a shared service).

## Utility functions / key modules worth knowing before you duplicate one

- `engine.py` — the core backtest engine: `run_backtest`, `Config`, the
  buffer/fixed-slots portfolio rules, hysteresis (`top_n`/`exit_rank`). Every
  dataset mode (ETF, Stock, Custom Index, Broad Momentum) ultimately calls
  into this — see its own docstrings before adding a new portfolio rule.
- `categories/broad.py` — Broad Momentum's category-selection funnel
  (`compute_universe_ranking`, `compute_category_selection*`,
  `run_broad_backtest`) — a pure, no-P&L ranking layer that feeds `engine.py`
  a derived rank table rather than duplicating its buy/sell logic.
- `categories/liquidity.py` — Broad Momentum's tradability gate (turnover, price, EQ-series, circuit
  rules; TODO 3.9.24) and the whole-market member list (`market_members_by_year`, INE ISINs only).
  `broad.load_stock_universe_frame(liquidity=..., universe="all_liquid")` applies it to point-in-time
  membership, and `compute_universe_ranking` re-applies it to the quarterly pool every week. The
  expensive SQL features are cached per catalog version, so thresholds are cheap to change. The
  newest bhavcopy day can lag the Fyers top-up (which covers only the Total Market pool), so
  `preview` reports the last *full* week and a warning. `rebalance.live_broad_ranking` accepts the
  gate, but the API refuses the whole-market and `turnover_rank` universes there (they preview from the
  latest stored close). Keep new Broad request fields in
  `get_broad_ranking`'s cache key, or stale rankings will be served.
- `categories/circuit_exposure.py` — post-hoc, display-only: walks a Broad backtest's holding periods
  (`holding_periods`) over the daily bars and reports the worst lower/upper-circuit runs it held
  through (`circuit_exposure`, payload key `circuit_exposure`). An open position has a `NaT` sell
  date, not `None` — use `pd.isna`. It must never change a backtest's result or fail a run.
  `lock_masks` builds the `uc_locked`/`lc_locked` tables `engine.run_backtest` accepts (buy blocked
  while upper-locked, sell/trim blocked while lower-locked, fill-week aligned); only
  `broad_respect_circuits` turns them on, and `api._circuit_realism` runs the opposite setting so
  the card can show CAGR both ways.
- `categories/momentum_scores.py` — per-stock/sector percentile momentum
  scoring for the Momentum Scores UI page (a cheap single-week snapshot, not
  a full backtest).
- `stocks/adjust.py` / `stocks/corporate_actions.py` — corporate-action
  detection and price adjustment for the survivorship-free stock layer.
- `stock_actions.py` — scans daily drops over 20.1%, matches explicit split/
  bonus ratios in the cached NSE feed, stores candidates and cumulative
  share factors in the shared catalog, and preserves browser-verified crash
  classifications. `categories/prices.py` back-adjusts confirmed factors;
  Broad Momentum's entry price ceiling reads raw closes. New unresolved
  events after the first-scan baseline appear in the dashboard for review.
  Demergers and rights are flagged as evidence, not valued as simple splits.
- `tax.py` — per-purchase tax-lot STCG/LTCG accounting, shared by every
  portfolio rule in `engine.py`.
- `trade_prices.py` — the `--track etf` price-substitution logic (booking
  P&L on the traded ETF instead of the ranked index).
- `sweep.py` — the parameter-sweep harness used for every "is this lever
  worth it" investigation (see `TODO.md` §3.9.18 for the most recent one).
- `metrics.turnover(result)` — the ONE turnover figure (everything sold / mean equity / years).
  The dashboard KPI, the search's `turnover_x` and every tier cap call it; never recompute
  turnover from the trade log elsewhere. Search results logged before 2026-10-05 carry an older
  buys-only `turnover_x` (BL-010 E7).
- Trade log audit columns — every fill row in `Result.trades` carries `fill_price`, `units`,
  `prev_units` and `cost` (see `_Sim.record`), enough to rebuild positions and equity without
  the simulation. Keep them filled on any new trade path (BL-010 E8).
- `search_spaces/bl010_criteria.json` — the pre-registered objective, drawdown baskets and
  pass/kill thresholds for the evaluation review (BL-010). Never edit after results are seen;
  supersede with a new file. A step added later gets its own `bl010_criteria_addendum_N.json`,
  committed before that step runs (addendum 1: Monday-open repricing; addendum 2: selection and
  validation windows never meet; addendum 3: the Phase 5 choice rule). `criteria.py` reads them
  all; code never restates a threshold.
- `choose.py` / `phase5.py` (`mbt search choose <results>`) — BL-010 Phase 5 from stored curves:
  drawdown baskets, the third-worst-FY rank, correlation clusters, the walk-forward of the
  choice rule (selects only on data 13 weeks before each FY), factor regression and bootstrap.
  The walk-forward must never read past its cut; `tests/test_choose.py` pins that.
- `phase6.py` (`mbt search ensemble <results> --space <toml> [--freeze]`) — addendum 4's
  ensemble pick and its walk-forward; `--freeze` writes `search_spaces/bl010_phase6_frozen.json`
  (configs, rebalance offsets, code commit, data snapshot) only if the rule passed. That file
  is what BL-010 Phase 6 tracks: never edit it, supersede it. `phase6.favourite_requests(frozen)`
  turns each frozen config into the complete `BacktestRequest` dict the live path needs
  (`broad_universe="turnover_rank"`, gated like the search). **Trap:** a config's effective
  offset is the TOP-LEVEL `rebalance_offset`; `light.rebalance_offset` is the search's raw
  sample and is never used. The Broad weekly signal (`api._broad_engine_signal`, used by
  `_research_weekly_result`) is the engine's own decision from a flat sentinel week appended
  after the newest week (as `rebalance_preview` does), not `analysis.latest_signal`, which
  ignores cadence, `sell_every_week`, the price ceiling and circuit locks.
  `tests/test_broad_parity.py` pins both paths to identical engine arguments and trades. The
  tilt-rank caches (`levers.tilt_cache_get/put`) hold the keyed frame so a recycled `id()`
  cannot serve another frame's ranks.
- `live_rules.py` + `live_rules.toml` (`mbt live-rules check [--send] [--simulate ...]`, BL-025) — the
  owner's live-money rules (paper first; cut half at a 20% fall, exit at 30%; review at 5 points
  behind the backtest over 13 weeks; the money gate) and the weekly check that measures them and
  sends a Telegram message naming the rule and quoting the action written in the file. Never
  trades. **Numbers in the TOML are the owner's:** change one only in a commit that also updates
  `tests/test_live_rules.py` and logs the reason in BL-025. Drawdown and the money gate read the
  frozen ensemble's model portfolio rebased at `stage.paper_start` (`tracker.run_config`); the
  trailing rule needs the journal-scored live series (BL-024 Phase 2, not built) and says "not
  measurable" until then; stage `live` is reported as blocked until real fills are recorded
  (BL-024 Phase 3). A breach is sent untagged (never switchable); the routine status is the
  `momentum.live_rules` type. Exit 0 on a breach, 1 only when the check cannot run or the data is
  stale. Scheduler job `momentum-live-rules`, Fri 21:30 IST.
- `this_week.py` (BL-051) — Momentum › This week's data: `week_view` builds one card per
  favourite (a group's from its sleeves via `groups.combine`, sleeves never shown alone) from the
  **forward journal** of that week and the week before, so it survives restarts and covers the
  scheduled CLI runs the API never sees. `GET /api/week?week=` serves it. The weekly run keeps the
  headline's message (`save_message` → `weekly_messages.json`, last 40) and the live-rules check
  keeps its last report (`live_rules.save_last` → `live_rules_last.json`, written by `mbt
  live-rules check` and by `POST /api/live-rules/run`, a background job; `GET /api/live-rules`).
  Both files live in `this_week.state_dir()`: `data/`, or `MOMENTUM_STATE_DIR`, which
  `tests/conftest.py` points at a temp folder so no test writes the real ones. "Room to exit" is
  only given for a strategy with a single exit rank (`_exit_rank`); Broad in category mode sells on
  its category and pool ranks too, so it gets none.
- `orders.py` + `holdings_store.py` (BL-051 Phase 3) — Your orders. `orders.plan` is pure: holdings
  in shares, prices, target weights -> orders (exits and new names always; top-ups/trims under the
  owner's minimum, ₹10,000 by default, skipped; whole shares; blocked names held; charges at
  `engine`'s itemised rates, no brokerage). `holdings_store` keeps per-owner settings (`MOMENTUM_OWNER`,
  default `rahul`; paper capital ₹1 lakh), holdings snapshots (Fyers `fyers.holdings`, read-only,
  or pasted), holding rules and the orders made (trading-data migration 012). `api._compute_orders`
  is the body of `mbt orders run [--send]` (scheduler job `momentum-orders`, Fri 14:15) and of
  `POST /api/orders/run`: the headline's target from `_orders_signal`, which for a stored week one
  short of the target and a signal delay of 1 uses `_broad_sentinel_run(ahead=True)` - deciding the
  NEXT week on a flat stand-in row. `tests/test_broad_parity.py` pins that the week-ahead decision
  buys and fully sells exactly what the full backtest did; trims and top-ups read the week's own
  prices and are not pinned. Broad only for now; delay-0 strategies get no orders before 19:30.
- `alerts.py` (BL-051 Phase 5) — `GET /api/alerts`: what needs a person, for the dashboard's bell
  and once-a-day pop-up. One pure function per kind over the data its Telegram job already reads:
  `split` (`stock_actions.review_snapshot`), `data` (`/weekly/status` readiness, for the
  **headline's** dataset only, once its Friday run is past: 16:45 ETF, 19:30 stock, +15 min),
  `journal` (`forward_journal.check`, once the 21:00 check is past, never on an empty journal; a
  broken chain at any time), `change` (`runs_store.list_changes(unreviewed=True)`: Not reproducible
  = error, Check = warning) and `rules` (the saved `live_rules_last.json`: a finding that
  `needs_you`, or a stale check; never re-runs the check). `collect` reads the catalog once via
  `read_catalog()` (never held across the weekly-status call), keeps ids stable (kind + subject)
  and records `opened_at` / `resolved_at` in `alerts_state.json` (`this_week.state_dir()`); a kind
  whose source cannot be read keeps its previous open alerts and is listed in `unchecked`, so a
  locked catalog never looks like "all clear". An alert resolves when its check clears (classify
  the split, Mark reviewed, the entry recorded, the next rules check passes).
- `holdout.py` (`mbt search backcast`) — the one-shot 2012–2016 backcast (criteria addendum 5):
  claims the run before it starts and writes its result once; never run it twice, never edit
  `search_spaces/bl010_phase6_backcast_result.json`. `tracker.py` (`mbt search track <results>
  --space <toml> --since <Friday>`) — read-only paper tracking of the frozen ensemble against its
  median companion and Nifty200 Momentum 30 TRI, with addendum 5's two fail lines; it saves nothing.
- `tests/golden/` — frozen backtest results (BL-001). 16 scenarios run through the real API on
  a frozen slice of real data (`fixture/`, rebuilt only by `scripts/build-golden-fixture.py`).
  A code change that moves any result fails `test_golden.py`; if the move was intended, run
  `uv run python scripts/update-goldens.py --accept-results --reason "..."` and commit the
  changelog entry it writes. A new request field needs a scenario (`test_coverage.py`).
  `test_lookahead.py` re-runs each dataset on data cut off at a date; never weaken it.
- `patterns/` (`mbt patterns detect|formation|gallery|study|rank|holdout`) — BL-042's chart-pattern
  POC (tight range, flag, cup and handle). Research only: nothing here reaches `api.py`, the
  default ranking or the weekly signal. Rules live in `search_spaces/bl042_criteria.json` (+
  addenda) and are read, never restated. Daily bars are forward-adjusted by the confirmed share
  factors so every bar depends only on events up to its own date; `patterns.guard` refuses any
  read of the sealed hold-out (2024-01-01 on), except the one-shot `holdout.run`, which claims
  itself before reading. `study`/`rank`/`holdout` refuse to run until an addendum with `detectors_frozen: true` (the
  detector freeze from the owner's gallery labels) is committed. `quality.py` grades each base
  0-1 from its own geometry (addendum 1); the blend shapes use state score x quality. `tests/test_patterns.py` pins the
  no-look-ahead property (detections up to a cut are identical with and without later bars).
- `audit/` — `mbt audit bundle|replay|study|outside` (BL-010 Phase 2). `bundle.py` writes a
  run's orders and the backtest's claims; `replay.py` rebuilds the result from the orders and
  the lake's raw bars and compares. `replay.py`, `studies.py` and `outside.py` must never import
  from the rest of the package (a test enforces it): shared code would hide a shared mistake.
- `search.py` + `search_spaces/*.toml` — `mbt search run|analyze`: resumable parallel parameter search over
  Broad Momentum (TODO 3.9.25). Parameters are *heavy* (change the global ranking; one
  `broad.compute_universe_base` per combination) or *light* (everything after, incl. the pool cut via
  `broad.finish_universe_ranking`); a run is heavy × light points, light ones from a shifted Halton
  sequence. Results append to `data/search/<name>/results-<pid>.jsonl`; a run id hashes its full
  parameters, so re-running skips finished runs. Space files are TOML (no PyYAML here; `"none"` = None).
  `broad.ordered_categories_by_week` caches each week's category order per (ranking, groups, floor), so
  `load_stock_groups` returns one shared dict — treat it as read-only.
- `categories/wide_tags.py` + `curated/stock_groups_wide.csv` — tags for the ~1,100 gate-passing NSE stocks
  outside the 755-name Total Market, which `curated/stock_groups.csv` does not cover (so in category mode they
  could never be bought; arm C1 was effectively arm A with a harder pool cut). Built from BSE's own
  Sector > Industry > Group > Sub-group classification (fetched once per ISIN from BSE's `ComHeader` API through
  the in-app browser: plain scripts get 403, and an unthrottled burst got the whole site blocked for ~30 min).
  Opt in per run with `category_tags="extended"` (`run_broad_backtest`, `BacktestRequest.broad_category_tags`;
  search arm C1 only, `search.EXTENDED_TAG_ARMS`); the default keeps every existing result unchanged. Tags are the
  CURRENT classification applied to all years. Stocks BSE does not list (NSE-only, delisted) stay untagged.
- `categories/exit_reasons.py` — display-only: for Broad Momentum closed trades the engine records as
  "ineligible" (rank NaN: the stock stopped being selected), fills the blank `exit_rank` (pool rank, else
  momentum rank) and sets a specific `reason` + `exit_cause` (`liquidity` with the failing gate test and its
  numbers, `pool` = dropped at the quarterly pool re-selection, `category`, `series_break`, `unranked`). Ranks are
  shifted by `signal_delay` in the engine, so it explains the decision week, not the fill week. Called from
  `api._broad_backtest`; never changes a result. `series_break` marks a real artifact: a one-day drop of about
  20% (e.g. the 23 Mar 2020 circuit day) makes the price builder start a new `SYMBOL#2` column, which retires the
  held segment and force-sells it.
- Broad Momentum gotcha: a stock with a gap in its EQ price history (suspension, or a move to trade-for-trade)
  has NaN weekly prices in the middle; `run_broad_backtest` now forward-fills the prices it values positions with
  (rankings still use the unfilled frame), otherwise a held stock hitting a gap turns the whole equity curve NaN
  (found in search arm B: 9 of the first 409 runs; A, which holds only the 755, never hit it).
- `bias.py` (`mbt search bias`) — tries to break a search's best configs: random-ranking placebo, stricter
  liquidity gate, removing the top-profit stocks, shifted/cut windows (never opens a sealed period). Re-runs
  `run_broad_backtest` with one thing changed; writes `<results>/bias.json` only.
- `reference_benchmarks.py` — Nifty 50 TRI and Nifty200 Momentum 30 TRI comparison lines
  (`load_references`, `compare`), added to every backtest payload as `comparisons`. Four more
  comparison-only TRIs (Midcap 150, Smallcap 250, Midcap150 Momentum 50, Nifty500 Momentum 50;
  `EXTRA_REFERENCES`, BL-010 Phase 5) are loaded by `load_references` but never displayed by
  `compare`, and stay out of `ui_data._BENCHMARK_COLUMNS` (the stock dataset); `mbt stocks
  fetch-benchmarks` refreshes just them, `mbt stocks fetch`/`local migrate` carry them too. Use it,
  not the dataset's own `benchmark`, when judging edge: index-mode benchmarks are price-only
  (TODO 3.9.23).
- `tranches.py` — overlapping tranches (K sub-portfolios on staggered `rebalance_every`
  phases, averaged) to remove start-date luck from a comparison; works with any dataset via a
  `run_one(config) -> Result` closure (TODO 3.9.23).
- `levers.py` / `reversal.py` — research levers from the 2026-10-01 alpha study (rank tables,
  `no_buy` masks, post-hoc overlays; the turnaround sleeve). `scripts/alpha_experiments.py`,
  `scripts/reversal_experiment.py` and `scripts/param_dry_run.py` reproduce every number in
  `docs/momentum-parameters-reference.md`. Score any new lever over `sweep.rolling_windows`
  with `sweep.rerun_windows` + `compare_rolling`, never on the full sample alone.
- Broad Momentum gotcha: `engine.run_backtest` skips weeks with fewer than `top_n` ranked
  names unless `Config.min_ranked` is set; Broad needs `min_ranked=1` (API
  `broad_every_week`) or about 190 of 508 weeks silently vanish (TODO 3.9.23).
- `notify.py` — the Python-side mirror of `@trading/notify`'s `Notification`
  shape, used by the weekly Telegram signal job.
- `local_store.py` — the weekly job's price/signal storage, since 2026-09-30
  (TODO 3.11.5): `push_dir`/`pull_dir`/`save_signal`/`load_signal` against
  the shared catalog's `momentum_prices`/`momentum_signals` tables, replacing
  the retired Neon `store.py` functions of the same names/signatures (a
  drop-in swap for `weekly.py`'s call sites). `store.py` itself still holds
  the pure file<->rows conversion both this and `db_migrate.py` share.
- `runs_store.py` — the dashboard's saved runs and scheduled favourites, server-side since
  2026-09-30 (TODO 3.11.9): `save_run`/`list_runs`/`update_run`/
  `delete_run` against the shared catalog's `strategies`/`strategy_versions`/
  `backtest_runs` tables (`package='momentum'`), the same tables
  `option_backtesting/legwise/store.py` uses with `package='options_legwise'`.
  One `strategies` row per dataset groups its runs (matching the old
  `localStorage` key's scope); the whole record (name, kpis, weekly equity
  series, overlay/favourite/active flags) lives in `backtest_runs.summary` JSON, not
  `backtest_days`/`backtest_trades` — those are shaped for day-by-day option
  trades, not a momentum run's weekly curve. Ordinary history is capped at 10 runs/dataset and
  pruned oldest-first; favourites are never pruned. **Favourite status (BL-051):** Watching /
  Paper / Invested (`status_of`; older favourites read as Watching, or Paper if active), Paper +
  Invested capped at `MAX_FOLLOWED` = 8 (`FavouriteError` → HTTP 409). Exactly one followed
  favourite is the *headline*, still stored and returned as `active` so every reader keeps
  working: Telegram sends it. A **group** (`create_group`, `POST /api/saved-runs/groups`) is one
  favourite made of several runs of one dataset (the Phase 6 ensemble's four sleeves): one status,
  one slot; its members stay favourites with `member_of` set, so they are still run and
  journalled one by one. `list_favorites` leaves groups out (they have no config to run);
  `list_groups` returns them with their members; `/api/favorite-strategies` returns both.
  `groups.py` combines the members' signals into the group's (sleeves weighted by value since the
  last April reset, `choose.ensemble_curve`'s convention) and its one Telegram message. **One strategy per set of
  settings (BL-052):** a version is the run's *normalised* settings
  (`saved_identity.fingerprint`: request-model defaults filled, the fields the dataset never reads
  dropped, `weights` only for `ranksum`), so rerunning the same settings is a `repeat` of one
  strategy, not a new row. Every run stores `versions` (data + code fingerprints, carried by each
  backtest result) and an `outcome`; a moved result appends a row to the append-only
  `momentum_result_changes` (a run-record table: listed in `db_read.RUN_RECORD_TABLES`, so it
  never moves the data version) labelled by `saved_identity.explain` — data revised, intended (a
  same-dataset accepted golden change), check, not reproducible (Telegram for a favourite) or
  unknown. Strategy state (name, notes, status) stays on the *anchor* run (the favourite, else the
  oldest), so the run ids the journal keys on never change; a run's config is
  `backtest_runs.params`. Each strategy keeps its last 3 repeats; each dataset its newest 10
  unkept strategies. `/api/saved-strategies*` and `/api/result-changes*` serve it;
  `mbt saved merge [--apply]` folded the runs saved before. `api.py`'s `/api/saved-runs` routes call this;
  the Fastify proxy (`apps/server/src/server/routes/momentum-backtest.ts`)
  forwards `/api/momentum/saved-runs*` to it unchanged.

## Commands

See `README.md` for the full walkthrough. From `packages/momentum-backtesting/`:
```bash
uv sync
uv run pytest
uv run mbt serve           # private API on 127.0.0.1:8765
uv run mbt fetch            # refresh price history
uv run mbt categories backtest   # Custom Index mode
uv run mbt local migrate    # copy companies/actions/membership/stock bars/price series
                             # into the shared local database (packages/trading-data)
```
