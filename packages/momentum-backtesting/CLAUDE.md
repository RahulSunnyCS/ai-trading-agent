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

The weekly job (`mbt weekly`) itself now runs from `launchd` LaunchAgents on the owner's own
laptop (`scripts/install-launchd.sh`/`uninstall-launchd.sh`, three plists — Friday 14:40
preview, 16:45 final, and since 2026-10-02 19:30 stock-data ingest IST), replacing the retired
`.github/workflows/momentum-weekly.yml`. The plists explicitly `source` the repo root `.env`
before running — launchd's own environment does not inherit it the way an interactive shell's
profile usually does. The CLI's `weekly()` command is a thin wrapper around
`api._execute_weekly_run` (the same function the API route calls) — there is exactly one
orchestration, not two copies that can drift.

**A blocked or missing active favourite now sends a Telegram warning** (not silence) —
previously a favourite that failed (e.g. the tax-config bug below) meant the job computed a
signal, found no usable active result, and exited 0 with nothing sent and no alert, for every
run, for over a week, before anyone noticed.

`POST /api/weekly/run` (`api.py`, proxied at `/api/momentum/weekly/run`) backs the dashboard
Momentum tab's "Weekly signal" section and runs the same all-favourites orchestration as the
CLI and scheduled job: every favourite is evaluated, while only the one global active
favourite is sent to Telegram. Since 2026-10-02 this runs as a **background job**
(`_SingleFlightJob` in `api.py`; `GET /api/weekly/jobs/latest` polls it) so a manual run
survives the browser tab closing or the user switching sections — the Momentum tab itself
shows a pulsing dot while one is in flight. `GET /api/weekly/status` reports, per dataset, the
date it's ingested through vs. the week a final run needs, the last few saved signals, and
each scheduled job's last-run time (flagging one that fired >10 minutes late — typically the
laptop was asleep at 14:40/16:45/19:30, and launchd has no catch-up marker of its own when
that happens).

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
- `reference_benchmarks.py` — Nifty 50 TRI and Nifty200 Momentum 30 TRI comparison lines
  (`load_references`, `compare`), added to every backtest payload as `comparisons`. Use it,
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
  pruned oldest-first; favourites are never pruned. Exactly one favourite can be globally active
  for Telegram. `api.py`'s `/api/saved-runs` routes call this;
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
