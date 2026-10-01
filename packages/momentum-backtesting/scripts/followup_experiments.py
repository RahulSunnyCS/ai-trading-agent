"""Two owner follow-ups to the momentum alpha study (TODO 3.9.23), on real local data.

1. Cadence: "sell every week, but only buy on the slow cadence." On a slow cadence
   (`rebalance_every > 1`), a holding that drops past `exit_rank` waits for the next cadence
   Friday to be sold, same as a new buy. `Config.sell_every_week=True` sells it the week it's
   due instead; new buys and cap trims still wait. Tested on the Broad 2-tranche and 4-tranche
   blends (the cadences Step 1 found a real edge in) and the ETF 2-tranche blend, against the
   same cadence with `sell_every_week=False`.

2. Ranking: `levers.grouped_momentum_ranks` (`BacktestRequest.reversal_tilt` in the API). Ranks
   the short lookbacks (1/4/13w) and the long lookbacks (26/52w, worst performer first)
   SEPARATELY, each as its own 0-100% percentile, then blends them - the owner's "separate the
   rank-sums, prefer the beaten-down as a second preference" idea. Fixes the single-mixed-sign-
   rank-sum failure mode the earlier reversal work diagnosed: a stock ranked near the bottom on
   a 52-week rank-sum swamps the short-term read, so the old approach was really just a "worst
   52-week losers" screen. Tilt=0 is the exact control (plain 1/4/13-week momentum, since the
   long group then contributes nothing) - any tilt > 0 must beat it to be worth using. Tested on
   ETF and directly on the Total Market stock universe (not through Broad's category funnel,
   same as the earlier reversal-sleeve script).

Both parts score every variant over 28 rolling 3-year windows (fresh start each) plus full /
last-5y / last-3y, the same standard the rest of this study used.

    uv run python scripts/followup_experiments.py [--part cadence|tilt|both]
Writes data/backtests/followup_<part>_<dataset>.csv.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import replace
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import alpha_experiments as ax  # noqa: E402

from momentum_backtesting import api, levers, metrics, sweep, tranches  # noqa: E402
from momentum_backtesting.categories import broad  # noqa: E402
from momentum_backtesting.config import DATA_DIR  # noqa: E402
from momentum_backtesting.engine import Config, run_backtest  # noqa: E402
from momentum_backtesting.reference_benchmarks import compare  # noqa: E402


def _row(result, refs) -> dict:
    stats = metrics.curve_stats(result.equity, result.cash)
    row = {"CAGR": stats["CAGR"], "Sharpe": stats["Sharpe"], "MaxDD": stats["max drawdown"]}
    for line in compare(result.equity, refs):
        short = "TRI" if line["name"] == "Nifty 50 TRI" else "Mom30"
        row[f"vs {short}"] = line["excess_cagr"]
    return row


def _report(variants: dict, windows, refs, baseline: str, out_path: Path) -> pd.DataFrame:
    per_window, fixed_rows = {}, {}
    for label, run in variants.items():
        t = time.time()
        per_window[label] = sweep.rerun_windows(run, windows, refs)
        for window, start in ax.FIXED.items():
            result = run(pd.Timestamp(start), pd.Timestamp(ax.END))
            fixed_rows.setdefault(label, {}).update(
                {f"{window} {k}": v for k, v in _row(result, refs).items()}
            )
        print(f"  {label}: {time.time() - t:.0f}s", flush=True)
    summary = pd.DataFrame(fixed_rows).T
    roll = sweep.compare_rolling(per_window, baseline)
    for col in (
        "median dCAGR",
        "median dSharpe",
        "median dMaxDD",
        "CAGR win share",
        "Sharpe win share",
        "MaxDD win share",
        "wins most",
    ):
        summary[f"roll {col}"] = roll[col]
    summary.to_csv(out_path)
    return summary


# --- Part 1: sell_every_week --------------------------------------------------------------------


def broad_cadence_variants() -> dict:
    outer = api.DATA.get()
    ranking = ax.broad_ranking()

    def runner(**extra):
        def run(start, end):
            return broad.run_broad_backtest(
                outer_prices=outer,
                stocks_data_dir=DATA_DIR / "stocks",
                categories_data_dir=DATA_DIR / "categories",
                curated_dir=api.CATEGORIES_CURATED_DIR,
                start=ax._ts(start),
                end=ax._ts(end),
                ranking=ranking,
                **{**ax.BROAD_DEFAULTS, **extra},
            ).result

        return run

    def tranche_blend(every: int, sell_every_week: bool):
        def run(start, end):
            def one(config: Config):
                return runner(
                    rebalance_every=every,
                    rebalance_offset=config.rebalance_offset,
                    sell_every_week=sell_every_week,
                )(start, end)

            return tranches.run_tranches(one, Config(), every)

        return run

    variants = {"weekly (baseline)": runner()}
    for every in (2, 4):
        for sell in (False, True):
            label = f"every{every} blend, sell_every_week={sell}"
            variants[label] = tranche_blend(every, sell)
    return variants


def etf_cadence_variants() -> dict:
    ctx = ax.etf_context()

    def runner(**extra):
        def run(start, end):
            config = replace(ctx.live, start=ax._ts(start), end=ax._ts(end), **extra)
            return run_backtest(ctx.prices, ctx.includes, config, ctx.classes, ctx.cache, ctx.fills)

        return run

    def tranche_blend(every: int, sell_every_week: bool):
        def run(start, end):
            def one(config: Config):
                return runner(
                    rebalance_every=every,
                    rebalance_offset=config.rebalance_offset,
                    sell_every_week=sell_every_week,
                )(start, end)

            return tranches.run_tranches(one, Config(), every)

        return run

    variants = {"weekly (baseline)": runner()}
    for sell in (False, True):
        variants[f"every2 blend, sell_every_week={sell}"] = tranche_blend(2, sell)
    return variants


def run_cadence_part() -> None:
    refs = api.DATA.references()
    weeks = api.DATA.get().loc[ax.FIXED["full"] : ax.END].index
    windows = sweep.rolling_windows(weeks)
    for name, variants in (
        ("broad", broad_cadence_variants()),
        ("etf", etf_cadence_variants()),
    ):
        print(f"== cadence / {name}", flush=True)
        summary = _report(
            variants,
            windows,
            refs,
            "weekly (baseline)",
            ax.OUT_DIR / f"followup_cadence_{name}.csv",
        )
        cols = [
            "full CAGR",
            "full Sharpe",
            "full MaxDD",
            "roll median dCAGR",
            "roll CAGR win share",
            "roll Sharpe win share",
            "roll MaxDD win share",
            "roll wins most",
        ]
        print(summary[cols].to_string(float_format=lambda v: f"{v:.3f}"))


# --- Part 2: grouped_momentum_ranks (reversal tilt) ----------------------------------------------

TILT_GRID = [
    ("tilt 0.0 (control: short-only momentum)", 0.0, 0.0),
    ("tilt 0.3", 0.3, 0.0),
    ("tilt 0.5", 0.5, 0.0),
    ("tilt 1.0", 1.0, 0.0),
    ("tilt 0.5, screen top 30%", 0.5, 0.3),
    ("tilt 1.0, screen top 30%", 1.0, 0.3),
]


def etf_tilt_variants() -> dict:
    ctx = ax.etf_context()
    # The rank table depends only on config.lookbacks (fixed) and prices - not on the window's
    # start/end - so compute it once per tilt/screen setting and reuse it across every window,
    # same as skip_month_ranks/high52_ranks elsewhere in this study.
    no_buy = levers.fresh_52w_low_mask(ctx.signal)

    def runner(tilt: float, screen_top_pct: float):
        ranks = levers.grouped_momentum_ranks(
            ctx.signal, ctx.live, tilt=tilt, screen_top_pct=screen_top_pct
        )

        def run(start, end):
            config = replace(ctx.live, start=ax._ts(start), end=ax._ts(end))
            return run_backtest(
                ctx.prices,
                ctx.includes,
                config,
                ctx.classes,
                None,
                ctx.fills,
                external_ranks=ranks,
                no_buy=no_buy,
            )

        return run

    return {label: runner(tilt, screen) for label, tilt, screen in TILT_GRID}


def broad_tilt_variants() -> dict:
    """The ACTUAL wired path (`BacktestRequest.broad_reversal_tilt` / `run_broad_backtest`'s
    `stock_tilt`): re-orders whatever stocks the category funnel already selected (ON mode, the
    dashboard default) - never changes which categories or pool stocks qualify."""
    outer = api.DATA.get()
    ranking = ax.broad_ranking()

    def runner(tilt: float, screen_top_pct: float):
        # Same cache the real API endpoint uses (api._Data.get_broad_tilt_ranks) - the tilt
        # computation (~30s cold) is otherwise recomputed on every window call.
        stock_tilt_ranks = (
            api.DATA.get_broad_tilt_ranks(ranking, (1, 4, 13, 26, 52), tilt, screen_top_pct)
            if tilt > 0
            else None
        )

        def run(start, end):
            return broad.run_broad_backtest(
                outer_prices=outer,
                stocks_data_dir=DATA_DIR / "stocks",
                categories_data_dir=DATA_DIR / "categories",
                curated_dir=api.CATEGORIES_CURATED_DIR,
                start=ax._ts(start),
                end=ax._ts(end),
                ranking=ranking,
                stock_tilt=tilt,
                stock_tilt_screen_pct=screen_top_pct,
                stock_tilt_ranks=stock_tilt_ranks,
                **ax.BROAD_DEFAULTS,
            ).result

        return run

    return {label: runner(tilt, screen) for label, tilt, screen in TILT_GRID}


def run_tilt_part() -> None:
    refs = api.DATA.references()
    weeks = api.DATA.get().loc[ax.FIXED["full"] : ax.END].index
    windows = sweep.rolling_windows(weeks)
    baseline = TILT_GRID[0][0]
    for name, variants in (
        ("etf", etf_tilt_variants()),
        ("broad", broad_tilt_variants()),
    ):
        print(f"== tilt / {name}", flush=True)
        summary = _report(
            variants, windows, refs, baseline, ax.OUT_DIR / f"followup_tilt_{name}.csv"
        )
        cols = [
            "full CAGR",
            "full Sharpe",
            "full MaxDD",
            "full vs TRI",
            "roll median dCAGR",
            "roll CAGR win share",
            "roll Sharpe win share",
            "roll MaxDD win share",
            "roll wins most",
        ]
        print(summary[cols].to_string(float_format=lambda v: f"{v:.3f}"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--part", choices=["cadence", "tilt", "both"], default="both")
    args = parser.parse_args()
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 40)
    if args.part in ("cadence", "both"):
        run_cadence_part()
    if args.part in ("tilt", "both"):
        run_tilt_part()


if __name__ == "__main__":
    main()
