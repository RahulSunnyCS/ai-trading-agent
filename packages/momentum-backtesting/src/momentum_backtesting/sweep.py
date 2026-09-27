"""Parameter sweep and walk-forward test.

The sweep answers "is the result a broad plateau or a single lucky spike?". The walk-forward
test answers "do settings chosen on the past hold up on data they never saw?" - in particular
whether a configuration's rank in the earlier period predicts its rank in the later one.
"""

import itertools
import math
from dataclasses import dataclass, replace

import pandas as pd

from . import metrics
from .engine import Config, RankCache, run_backtest

TOP_NS = (3, 4, 5, 6, 8)
EXIT_RANKS = (6, 8, 10, 12, 15)
LOOKBACK_SETS = (
    (1, 4, 13, 26, 52),
    (4, 13, 26, 52),
    (1, 4, 13),
    (13, 26, 52),
    (4, 13, 26),
    (13, 26),
    (4, 13),
)
MODES = ("off", "ranked", "filter")


def grid(base: Config) -> list[Config]:
    """Every valid combination around the base config (exit rank must be >= top N)."""
    configs = []
    for mode, lookbacks, top, exit_rank in itertools.product(
        MODES, LOOKBACK_SETS, TOP_NS, EXIT_RANKS
    ):
        if exit_rank >= top:
            configs.append(
                replace(
                    base,
                    defensive=mode,
                    lookbacks=lookbacks,
                    weights=None,
                    top_n=top,
                    exit_rank=exit_rank,
                )
            )
    return configs


def quick_stats(result) -> dict[str, float]:
    eq, cash = result.equity, result.cash
    weekly = eq.pct_change().dropna()
    excess = weekly - cash.pct_change().dropna()
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    sharpe = excess.mean() / excess.std() * math.sqrt(52) if excess.std() > 0 else float("nan")
    return {
        "CAGR": metrics.cagr(eq),
        "benchmark CAGR": metrics.cagr(result.benchmark),
        "Sharpe": sharpe,
        "max drawdown": metrics.max_drawdown(eq)[0],
        "buys/yr": (result.trades["action"] == "BUY").sum() / years if len(result.trades) else 0.0,
    }


def run_grid(
    prices: pd.DataFrame,
    includes: dict[str, str],
    configs: list[Config],
    tax_classes: dict[str, str] | None = None,
    cache: RankCache | None = None,
) -> pd.DataFrame:
    cache = {} if cache is None else cache
    rows = []
    for config in configs:
        stats = quick_stats(run_backtest(prices, includes, config, tax_classes, cache))
        rows.append(
            {
                "mode": config.defensive,
                "lookbacks": "-".join(map(str, config.lookbacks)),
                "top_n": config.top_n,
                "exit_rank": config.exit_rank,
                **stats,
            }
        )
    return pd.DataFrame(rows)


KEY = ["mode", "lookbacks", "top_n", "exit_rank"]


def plateau_summary(full: pd.DataFrame, base: Config) -> dict[str, pd.DataFrame]:
    """Views of the full-period grid that show how sensitive the result is."""
    base_lb = "-".join(map(str, base.lookbacks))
    default = full[full["lookbacks"] == base_lb]
    tables = {}
    for metric in ("CAGR", "Sharpe"):
        tables[f"{metric} top x exit"] = pd.concat(
            {
                mode: default[default["mode"] == mode].pivot(
                    index="top_n", columns="exit_rank", values=metric
                )
                for mode in MODES
            },
            names=["mode"],
        )
    by_lookback = full.groupby(["mode", "lookbacks"])[["CAGR", "Sharpe", "max drawdown"]].agg(
        ["min", "median", "max"]
    )
    tables["by lookback set"] = by_lookback
    tables["distribution"] = full.groupby("mode")[["CAGR", "Sharpe"]].describe().T
    return tables


@dataclass
class WalkForward:
    split: str
    fit: pd.DataFrame
    test: pd.DataFrame
    joined: pd.DataFrame
    chosen: pd.Series
    summary: dict[str, float]


def walk_forward(
    prices: pd.DataFrame,
    includes: dict[str, str],
    configs: list[Config],
    fit_window: tuple[str, str],
    test_window: tuple[str, str],
    tax_classes: dict[str, str] | None = None,
    cache: RankCache | None = None,
    select_by: str = "Sharpe",
) -> WalkForward:
    """Choose the best configuration in `fit_window`, then measure it in `test_window`."""
    cache = {} if cache is None else cache
    fit = run_grid(
        prices,
        includes,
        [replace(c, start=fit_window[0], end=fit_window[1]) for c in configs],
        tax_classes,
        cache,
    )
    test = run_grid(
        prices,
        includes,
        [replace(c, start=test_window[0], end=test_window[1]) for c in configs],
        tax_classes,
        cache,
    )
    joined = fit.merge(test, on=KEY, suffixes=(" (fit)", " (test)"))
    best = joined.sort_values(f"{select_by} (fit)", ascending=False).iloc[0]
    fit_col, test_col = f"{select_by} (fit)", f"{select_by} (test)"
    top_decile = joined.nlargest(max(1, len(joined) // 10), fit_col)
    summary = {
        "configs tested": len(joined),
        "rank correlation fit vs test (Spearman)": joined[fit_col]
        .rank()
        .corr(joined[test_col].rank()),
        "chosen config CAGR (fit)": best["CAGR (fit)"],
        "chosen config CAGR (test)": best["CAGR (test)"],
        "chosen config Sharpe (fit)": best["Sharpe (fit)"],
        "chosen config Sharpe (test)": best["Sharpe (test)"],
        "chosen config test-rank percentile": (joined[test_col] < best[test_col]).mean(),
        "median config CAGR (test)": joined["CAGR (test)"].median(),
        "median config Sharpe (test)": joined["Sharpe (test)"].median(),
        "top-decile-by-fit mean Sharpe (test)": top_decile[test_col].mean(),
        "all-config mean Sharpe (test)": joined[test_col].mean(),
        "benchmark CAGR (fit)": best["benchmark CAGR (fit)"],
        "benchmark CAGR (test)": best["benchmark CAGR (test)"],
        "share of configs beating benchmark (test)": (
            joined["CAGR (test)"] > joined["benchmark CAGR (test)"]
        ).mean(),
    }
    return WalkForward(fit_window[1], fit, test, joined, best, summary)
