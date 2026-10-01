"""Reversal sleeve as a diversifier (TODO 3.9.23, Step 2) on real local data.

For ETF mode and for stocks (the point-in-time Nifty Total Market frame Broad Momentum ranks), run
the turnaround sleeve (`reversal.py`) and the momentum baseline from alpha_experiments.py over 28
rolling 3-year windows plus full / last-5y / last-3y, and ask the question that matters: does
80% momentum + 20% reversal beat momentum alone on Sharpe and drawdown, especially in momentum's
own worst falls? And is it any better than 80% momentum + 20% liquid fund (the sleeve sits in
cash much of the time)? The standalone sleeve is reported, but not expected to beat Nifty.

    uv run python scripts/reversal_experiment.py [--dataset etf|stocks|both]
        [--rank-on acceleration|momentum]

Writes data/backtests/reversal_<dataset>_<rank_on>_summary.csv.
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

from momentum_backtesting import api, metrics, sweep  # noqa: E402
from momentum_backtesting.categories import broad  # noqa: E402
from momentum_backtesting.config import DATA_DIR  # noqa: E402
from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest  # noqa: E402
from momentum_backtesting.fetch import load_universe  # noqa: E402
from momentum_backtesting.reference_benchmarks import compare  # noqa: E402
from momentum_backtesting.reversal import (  # noqa: E402
    ReversalParams,
    blend_curves,
    reversal_signals,
    weekly_volume,
)

WEIGHT = 0.2


class _Curve:
    def __init__(self, equity, cash):
        self.equity, self.cash = equity, cash


PARAMS = ReversalParams()


def etf_sleeves():
    study = ax.etf_study()
    momentum = study.variants[0].run  # live config baseline (memoised)
    prices = api.DATA.get()
    names = [i.name for i in load_universe() if i.include == "core" and i.name in prices]
    signals = reversal_signals(prices[names], params=PARAMS)
    includes = {n: "core" for n in names} | {CASH: "defensive"}
    config = Config(top_n=3, exit_rank=6, cost_pct=0.10, max_position=0.35, lookbacks=(13,))
    fills = api.DATA.fills("etf", "fri_close").prices

    def reversal(start, end):
        c = replace(config, start=ax._ts(start), end=ax._ts(end))
        return run_backtest(
            prices,
            includes,
            c,
            None,
            None,
            fills,
            external_ranks=signals.external_ranks,
            no_buy=signals.no_buy,
        )

    return momentum, reversal, signals


def stock_sleeves():
    study = ax.broad_study()
    momentum = study.variants[0].run
    universe = api.DATA.get_momentum_universe()
    outer = api.DATA.get()
    frame = universe.frame
    t = time.time()
    volume = weekly_volume(
        DATA_DIR / "stocks" / "daily.parquet", universe.column_to_base_symbol, frame.index
    )
    print(f"weekly volume {time.time() - t:.0f}s", flush=True)
    signals = reversal_signals(
        frame, membership=universe.stock_membership, volume=volume, params=PARAMS
    )
    ceiling = broad.price_ceiling_mask(frame, broad.DEFAULT_MAX_STOCK_PRICE)
    no_buy = signals.no_buy | ceiling.fillna(False).astype(bool)
    prices = frame.copy()
    prices[CASH] = outer.reindex(prices.index)[CASH]
    prices[BENCHMARK] = outer.reindex(prices.index)[BENCHMARK]
    includes = {c: "core" for c in frame.columns} | {CASH: "defensive", BENCHMARK: "defensive"}
    config = Config(
        top_n=10, exit_rank=20, cost_pct=0.10, max_position=0.15, lookbacks=(13,), universe=None
    )

    def reversal(start, end):
        c = replace(config, start=ax._ts(start), end=ax._ts(end))
        return run_backtest(
            prices,
            includes,
            c,
            external_ranks=signals.external_ranks,
            no_buy=no_buy,
            membership=universe.stock_membership,
        )

    return momentum, reversal, signals


def episodes(momentum_full) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Momentum's own three worst falls over the full window, plus COVID (Feb-Jun 2020)."""
    worst = metrics.worst_episodes(momentum_full.equity, 3)
    covid = (pd.Timestamp("2020-01-17"), pd.Timestamp("2020-06-26"))
    return [*worst, covid]


def period_return(curve: pd.Series, start, end) -> float:
    part = curve.loc[start:end]
    return part.iloc[-1] / part.iloc[0] - 1 if len(part) > 1 else float("nan")


def evaluate(name: str, momentum, reversal) -> pd.DataFrame:
    refs = api.DATA.references()
    weeks = api.DATA.get().loc[ax.FIXED["full"] : ax.END].index
    windows = sweep.rolling_windows(weeks)
    rows = {}
    per_window = {
        "momentum": {},
        "reversal": {},
        "blend held": {},
        "blend rebal": {},
        "80/20 cash held": {},
    }

    def curves(start, end):
        m, r = momentum(start, end), reversal(start, end)
        return {
            "momentum": m,
            "reversal": r,
            "blend held": _Curve(blend_curves(m.equity, r.equity, WEIGHT), m.cash),
            "blend rebal": _Curve(blend_curves(m.equity, r.equity, WEIGHT, True), m.cash),
            # the honest comparator: the sleeve sits in cash much of the time, so is it any
            # better than simply keeping 20% in the liquid fund?
            "80/20 cash held": _Curve(blend_curves(m.equity, m.cash, WEIGHT), m.cash),
        }

    t = time.time()
    for start, end in windows:
        for label, c in curves(start, end).items():
            per_window[label][start] = sweep.window_row(c.equity, c.cash, refs)
    frames = {k: pd.DataFrame(v).T for k, v in per_window.items()}
    rolling = sweep.compare_rolling(frames, "momentum")
    print(f"  rolling windows {time.time() - t:.0f}s", flush=True)

    full = None
    for window, start in ax.FIXED.items():
        cs = curves(pd.Timestamp(start), pd.Timestamp(ax.END))
        if window == "full":
            full = cs
        for label, c in cs.items():
            stats = metrics.curve_stats(c.equity, c.cash)
            row = rows.setdefault(label, {})
            row[f"{window} CAGR"] = stats["CAGR"]
            row[f"{window} Sharpe"] = stats["Sharpe"]
            row[f"{window} MaxDD"] = stats["max drawdown"]
            for line in compare(c.equity, refs):
                short = "TRI" if line["name"] == "Nifty 50 TRI" else "Mom30"
                row[f"{window} vs {short}"] = line["excess_cagr"]
    m_ret = full["momentum"].equity.pct_change()
    r_ret = full["reversal"].equity.pct_change()
    corr = m_ret.corr(r_ret)
    for start, end in episodes(full["momentum"]):
        key = f"fall {start:%Y-%m}..{end:%Y-%m}"
        for label, c in full.items():
            rows[label][key] = period_return(c.equity, start, end)
    summary = pd.DataFrame(rows).T
    for col in (
        "CAGR win share",
        "Sharpe win share",
        "MaxDD win share",
        "median dCAGR",
        "median dSharpe",
        "median dMaxDD",
    ):
        summary[f"roll {col}"] = rolling[col]
    versus_cash = sweep.compare_rolling(frames, "80/20 cash held")
    for col in ("CAGR win share", "Sharpe win share", "MaxDD win share", "median dCAGR"):
        summary[f"vs cash blend {col}"] = versus_cash[col]
    summary["weekly corr with momentum"] = corr
    reversal_full = full["reversal"]
    trades = reversal_full.trades
    years = (reversal_full.equity.index[-1] - reversal_full.equity.index[0]).days / 365.25
    summary.loc["reversal", "buys/yr"] = (trades["action"] == "BUY").sum() / years
    summary.loc["reversal", "time in cash"] = metrics.summary(reversal_full)["time in cash/debt"]
    summary.to_csv(ax.OUT_DIR / f"reversal_{name}_{PARAMS.rank_on}_summary.csv")
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["etf", "stocks", "both"], default="both")
    parser.add_argument("--rank-on", choices=["acceleration", "momentum"], default="acceleration")
    args = parser.parse_args()
    global PARAMS
    PARAMS = ReversalParams(rank_on=args.rank_on)
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 80)
    for name in ("etf", "stocks") if args.dataset == "both" else (args.dataset,):
        print(f"== {name}", flush=True)
        momentum, reversal, _ = etf_sleeves() if name == "etf" else stock_sleeves()
        summary = evaluate(name, momentum, reversal)
        print(summary.T.to_string(float_format=lambda v: f"{v:.3f}"), flush=True)


if __name__ == "__main__":
    main()
