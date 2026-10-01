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

The weekly job (`mbt weekly`) itself now runs from a `launchd` LaunchAgent on the owner's own
laptop (`scripts/install-launchd.sh`/`uninstall-launchd.sh`, two plists — Friday 14:40
preview, 16:45 final IST), replacing the retired `.github/workflows/momentum-weekly.yml`. The
plists explicitly `source` the repo root `.env` before running — launchd's own environment
does not inherit it the way an interactive shell's profile usually does, and without it the
job would compute a signal but silently never reach Telegram. Also triggerable any time
without waiting for the schedule: `POST /api/weekly/run` (`api.py`, proxied at
`/api/momentum/weekly/run`) backs the dashboard Momentum tab's "Weekly signal" section, and
runs the exact same `weekly.run_weekly()` the CLI and the scheduled job call.

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
  detection and price adjustment for the survivorship-free stock layer; see
  the "Known limitation" docstring in `categories/prices.py` for a
  documented gap (a real bonus issue can defeat the mechanical split
  detector) before assuming this layer's output is bulletproof.
- `tax.py` — per-purchase tax-lot STCG/LTCG accounting, shared by every
  portfolio rule in `engine.py`.
- `trade_prices.py` — the `--track etf` price-substitution logic (booking
  P&L on the traded ETF instead of the ranked index).
- `sweep.py` — the parameter-sweep harness used for every "is this lever
  worth it" investigation (see `TODO.md` §3.9.18 for the most recent one).
- `notify.py` — the Python-side mirror of `@trading/notify`'s `Notification`
  shape, used by the weekly Telegram signal job.
- `local_store.py` — the weekly job's price/signal storage, since 2026-09-30
  (TODO 3.11.5): `push_dir`/`pull_dir`/`save_signal`/`load_signal` against
  the shared catalog's `momentum_prices`/`momentum_signals` tables, replacing
  the retired Neon `store.py` functions of the same names/signatures (a
  drop-in swap for `weekly.py`'s call sites). `store.py` itself still holds
  the pure file<->rows conversion both this and `db_migrate.py` share.
- `runs_store.py` — the dashboard's "Saved runs" feature, server-side since
  2026-09-30 (TODO 3.11.9): `save_run`/`list_runs`/`update_run`/
  `delete_run` against the shared catalog's `strategies`/`strategy_versions`/
  `backtest_runs` tables (`package='momentum'`), the same tables
  `option_backtesting/legwise/store.py` uses with `package='options_legwise'`.
  One `strategies` row per dataset groups its runs (matching the old
  `localStorage` key's scope); the whole record (name, kpis, weekly equity
  series, overlay flag) lives in `backtest_runs.summary` JSON, not
  `backtest_days`/`backtest_trades` — those are shaped for day-by-day option
  trades, not a momentum run's weekly curve. Capped at 10 runs/dataset,
  pruned oldest-first on save. `api.py`'s `/api/saved-runs` routes call this;
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
