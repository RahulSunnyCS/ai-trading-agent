# Handover: improving the momentum lab's alpha, and adding a reversal/turnaround sleeve

Written 2026-09-30 from a read-only analysis session. Nothing was run and no code was changed.
No real price data exists in the cloud container, so every performance claim below is a
hypothesis to test, not a result. Package: `packages/momentum-backtesting` (Python 3.12 / uv).

## The owner's two questions

1. Pure weekly momentum (rank on 1/4/13/26/52-week returns, buy the top N, sell when rank falls
   past exit_rank) beats Nifty. What extra criteria would make it better?
2. How can the lab find reversal / turnaround / bottoming stocks? The owner tried negative
   weights on the 26/52-week lookbacks with positive weights on 1/4/13. It did not work. The
   owner's own idea: treat 52/26 and 1/4/13 as two separate groups and rank accordingly.

The owner also asked for any other ways to get alpha over Nifty. They think of the rebalance as
"every 2 weeks".

## Read first (in this order)

1. `CLAUDE.md` (repo root) and `packages/momentum-backtesting/CLAUDE.md`
2. `TODO.md` section 3.9, especially rows 3.9.8, 3.9.13, 3.9.18, 3.9.20. It is the single source
   of truth for open work. Add rows for anything you start, and update them in the same commit.
3. `packages/momentum-backtesting/src/momentum_backtesting/engine.py`: `Config`,
   `_compute_ranks_ranksum`, `_compute_ranks_voladj`, `_run_buffer`, and the `external_ranks`
   parameter of `run_backtest`.
4. `sweep.py` (`walk_forward`, `run_grid`, `plateau_summary`), `metrics.py`, `tax.py`.
5. `stocks/benchmarks.py` (TRI fetchers), `stocks/bhavcopy.py` (daily OHLC plus volume columns),
   `categories/broad.py` (how a derived rank table is fed in through `external_ranks`).

## Verified facts about the current system (from reading code)

- Score is a weighted sum of cross-sectional ranks, equal weights by default, lowest wins. Ties
  break on the middle lookback's return. Eligibility needs history for the longest lookback.
- Negative weights are allowed on purpose. Test:
  `tests/test_engine.py::test_negative_weight_rewards_the_worst_performer_on_that_lookback`.
- Rebalance options are only `weekly` and `monthly`. There is no fortnightly or every-K-weeks
  mode. `signal_delay` (0/1/2 weeks) is a fill delay, not a cadence.
- `engine.py` already has an alternative score, `voladj` (NSE-style 6m/12m return divided by
  26-week vol, z-scored, with an optional skip of the last 4 weeks), plus `blend`.
- Fyers `-INDEX` history is price-return (no dividends). ETFs keep dividends in NAV. The default
  benchmark is the `Nifty 50` price column.
- `stocks/benchmarks.py` can already fetch Nifty 50 TRI and Nifty200 Momentum 30 TRI from
  niftyindices.com. The Momentum 30 series is back-calculated before 2020-08-11.
- Stock daily data (`data/stocks/daily.parquet`) carries open/high/low/close/volume/turnover.
  ETF/index mode only has weekly closes, so 52-week highs there must be approximated from
  weekly closes.
- `external_ranks=(ranks, scores)` lets any caller supply a rank table and leaves `engine.py`
  untouched. Broad Momentum already does this.
- `no_buy` (week x instrument booleans) blocks new purchases only and never forces a sale.

## Already tested and rejected or neutral: do not retry

- `momentum_sizing` (rolling win-rate sizing): gives up roughly 4 to 5 points of CAGR with no
  reliable risk benefit (3.9.8, re-confirmed on Broad Momentum in 3.9.18).
- Mass-exit throttle and halve-top_n response: no repeatable edge (3.9.20).
- `defensive="filter"` (per-instrument 13-week return vs cash): no meaningful help (3.9.8,
  3.9.18).
- Lower `max_position` alone: a risk/return dial, not free alpha.
- Zero-cost run: drawdown improved only 0.5 to 2 points, so an exit debounce is not worth
  building.
- Positive results worth acting on: `entry="make_room"` won on CAGR, MaxDD and Sharpe in all
  three windows and is still not the shipped default. `coverage_floor=0.25` and `score="blend"`
  look promising but carry the cold-start fork caveat below.
- Known confound from 3.9.18: levers that change category selection fork the portfolio before
  the backtest start date, so their full-window MaxDD comparisons compare unrelated portfolios.

## Work plan, in order

### Step 0. Fix measurement before adding any lever

a. Benchmarks. Add Nifty 50 TRI and Nifty200 Momentum 30 TRI as comparison lines on every run.
   Check whether ETF mode (`track="etf"`) is being compared with a price-only Nifty. If so the
   reported edge is overstated by roughly the dividend yield (an estimate of 1.2 to 1.5 points a
   year, unverified). In index mode both sides are price-return, so that case is like-for-like.
   Report excess return against the TRI series.
b. Cadence. Add a `Rebalance` option for every K weeks with an offset (for example
   `rebalance_every=2, rebalance_offset=0|1`). This needs a small `engine.py` change next to
   `_month_end_weeks`. Keep default behaviour byte-identical and add regression tests.
c. Overlapping tranches. Split capital into K sub-portfolios that rebalance on staggered weeks
   (needs 0b) and average the equity curves. This removes start-date luck and gives cleaner
   lever comparisons. Put it in a new module. The tranche runner should report per-tranche and
   blended results.
d. Rolling-window evaluation. Extend `sweep.py` to score each lever over many rolling 3-year
   windows and report the share of windows it wins, plus a deflated-Sharpe style correction.
   `packages/option-backtesting/src/option_backtesting/analytics/overfit.py` has CSCV/PBO and a
   simplified Deflated Sharpe to copy from. Do NOT import across packages (forbidden by
   CLAUDE.md). Reimplement the small parts you need.
   Acceptance rule for any lever: it must win in most rolling windows, not only on the full
   sample.

### Step 1. Momentum experiments (all measured through Step 0)

| # | Experiment | Hypothesis | Build path |
|---|---|---|---|
| 1 | Weights `(0,1,1,1,1)` and then a skip-month variant of ranksum | The 1-week return mean-reverts and currently holds 20% of the score. Add a `skip` param mirroring `voladj_skip_recent_month` | Config only, then a small rank change |
| 2 | Portfolio vol-targeting | Momentum crashes follow rebounds. Scale exposure by trailing realised strategy vol, park the excess in the liquid fund | First pass as a post-hoc scaling of `Result.equity`; note it ignores rebalance cost and tax |
| 3 | 52-week-high proximity as score or entry gate | Price / 52w high predicts continuation with less turnover | New score through `external_ranks`, or a `no_buy` mask below about 85% of the high |
| 4 | Path smoothness tie-break | Many small up-days continue better than one jump | Stocks only (needs daily data). R-squared of log price on time, or fraction of up-days |
| 5 | Breadth / regime gate on fresh buys | Percent of universe above its 200-day average, or Nifty vs 40-week average. Differs from the rejected per-instrument filter | `no_buy` mask, holdings unaffected |
| 6 | Tax-aware exit hysteresis | A lot near 365 days with a marginal rank should wait (STCG 20% vs LTCG 12.5%) | Needs lot age from `tax.py` inside the sell decision, so a real engine change |
| 7 | Flip the default to `entry="make_room"` | Already a clean win in 3.9.18 | One-line default plus test updates, after confirming on rolling windows |
| 8 | Volatility exclusion, score-weighted sizing, dispersion timing | Cheap secondary ideas | After 1 to 3 |

### Step 2. Reversal / turnaround sleeve

Why negative weights failed, in two parts:

- A rank-sum cannot express a condition. A stock ranked 700 of 755 on 52-week return adds about
  minus 700, which swamps the near-term ranks, so the result is a "worst 52-week losers" screen.
- At the 6 to 12 month horizon past losers keep losing (that is momentum). Reversal is a
  3 to 5 year effect, and a short-horizon (1 to 4 week) effect.

Design it as gate, confirm, rank, hold. Implement in a new `reversal.py` that returns
`(ranks, scores)` for `external_ranks`. No `engine.py` change.

1. Gate ("was beaten down"): 52-week return in the bottom quintile, or drawdown from the 52-week
   high deeper than 40%, or below the 200-day average for more than 26 weeks. Others get NaN.
2. Confirm ("has turned"): 13-week return positive while 26-week is still negative, price back
   above the 50-day average, and up-week volume above down-week volume over the last 8 weeks.
3. Rank survivors on 4/13-week momentum or on acceleration (13-week return minus the prior
   13-week return).
4. Hold with the usual top_n / exit_rank hysteresis. Exit if price falls back below the
   pre-entry 52-week low.

Evaluate it as a diversifier, not a standalone Nifty-beater. The test is whether 80% momentum
plus 20% reversal beats momentum alone on Sharpe and max drawdown, especially around momentum
crashes such as April 2020. Price-only turnaround screens usually underperform momentum. A true
earnings-inflection screen needs fundamentals and this repo has none. Do not fabricate a
fundamentals proxy.

## Correction to the earlier chat analysis

The chat said the tranche wrapper needs no engine change. That was wrong. Under `monthly`, the
trade weeks are calendar month-ends regardless of start date, so staggering start dates does not
stagger trading. Step 0b (an every-K-weeks option with an offset) is required first.

## Unverified, or to check on real data

- Whether ETF mode is compared with a price-only benchmark (Step 0a).
- The 1.2 to 1.5 point dividend figure is an estimate.
- `daily.parquet` should retain high/low/volume (the bhavcopy validator requires them) but this
  was not opened.
- No number in this document is a backtest result. The container had no `data/`.

## Repo rules that bite

- uv for Python packages, bun only for JS. No cross-imports between `momentum-backtesting` and
  `option-backtesting`.
- Run `uv run pytest` and `uv run ruff check src tests` from `packages/momentum-backtesting`.
  TODO.md last recorded 487 passed / 1 skipped.
- Update `TODO.md` (and the relevant `.claude/project/` file if a documented fact changes) in
  the same commit as the code.
- Keep `engine.py` changes minimal and byte-identical by default, each with a regression test.
  Prefer `external_ranks`, `no_buy`, `groups` and wrappers.
- Weekly sweeps: reuse `rank_cache` and the `ranking=` reuse pattern so ranking (11 to 22 s cold)
  is computed once per lever variant, not per window.
