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
and a local-only web UI (`mbt ui`). See `README.md` and `TODO.md` §3.9 for
what's built vs. still open.

## Cross-package links

**This package is fully independent — it shares no code with any other
package in the monorepo, including `packages/option-backtesting`.** They are
both Python/uv but have entirely separate `pyproject.toml`/`uv.lock` files;
the only connection is a comment in this package's `pyproject.toml` noting
it pins the *same library versions* as `option-backtesting` for the local
UI's dependencies (Plotly etc.), purely to avoid an unrelated version-skew
bug — not a functional dependency. Do not add a cross-import between them;
if the two ever need to genuinely share logic, that logic should move to a
new, deliberately-shared location, not be imported from one into the other.

No TypeScript package imports this or is imported by it. It talks to
`MOMENTUM_DATABASE_URL` (a separate Neon Postgres instance from the main
app's `DATABASE_URL`) for its own price history and weekly signal storage,
and to `DATABASE_URL`'s `broker_tokens` table only as one of several places
`fyers.py` looks for a Fyers access token (see the precedence order in root
`technical.md`'s Environment Variables table).

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

## Commands

See `README.md` for the full walkthrough. From `packages/momentum-backtesting/`:
```bash
uv sync
uv run pytest
uv run mbt ui              # local web UI on 127.0.0.1:8765
uv run mbt fetch            # refresh price history
uv run mbt categories backtest   # Custom Index mode
```
