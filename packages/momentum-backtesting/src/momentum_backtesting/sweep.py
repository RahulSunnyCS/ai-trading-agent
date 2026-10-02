"""Parameter sweep and walk-forward test.

The sweep answers "is the result a broad plateau or a single lucky spike?". The walk-forward
test answers "do settings chosen on the past hold up on data they never saw?" - in particular
whether a configuration's rank in the earlier period predicts its rank in the later one.
"""

import itertools
import math
import statistics
from collections.abc import Callable
from dataclasses import dataclass, replace

import pandas as pd

from . import metrics
from .engine import Config, RankCache, Result, run_backtest

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
    trade_prices: pd.DataFrame | None = None,
) -> pd.DataFrame:
    cache = {} if cache is None else cache
    rows = []
    for config in configs:
        result = run_backtest(prices, includes, config, tax_classes, cache, trade_prices)
        stats = quick_stats(result)
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
    trade_prices: pd.DataFrame | None = None,
) -> WalkForward:
    """Choose the best configuration in `fit_window`, then measure it in `test_window`."""
    cache = {} if cache is None else cache
    fit = run_grid(
        prices,
        includes,
        [replace(c, start=fit_window[0], end=fit_window[1]) for c in configs],
        tax_classes,
        cache,
        trade_prices,
    )
    test = run_grid(
        prices,
        includes,
        [replace(c, start=test_window[0], end=test_window[1]) for c in configs],
        tax_classes,
        cache,
        trade_prices,
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


# --- Rolling-window evaluation (TODO 3.9.23, Step 0d) -------------------------------------------
#
# A lever earns a place only if it wins in most rolling windows, not just on the full sample:
# the full sample is one path, dominated by whichever crash it happened to contain. Windows are
# 3 years long and start every quarter, so they overlap heavily - treat a win share as a
# robustness score, not as N independent experiments.

_EULER_MASCHERONI = 0.5772156649015329
_NORMAL = statistics.NormalDist()

Window = tuple[pd.Timestamp, pd.Timestamp]


def rolling_windows(
    weeks: pd.DatetimeIndex, years: float = 3.0, step_weeks: int = 13
) -> list[Window]:
    """(start, end) week pairs `years` long, a new one every `step_weeks`, inside `weeks`."""
    weeks = pd.DatetimeIndex(weeks).sort_values()
    span = pd.Timedelta(days=round(years * 365.25))
    out = []
    for i in range(0, len(weeks), step_weeks):
        start = weeks[i]
        ends = weeks[weeks <= start + span]
        end = ends[-1]
        if end - start < span - pd.Timedelta(days=7):
            break
        out.append((start, end))
    return out


def window_row(
    equity: pd.Series, cash: pd.Series, references: pd.DataFrame | None = None
) -> dict[str, float]:
    """Stats for one window's curve (rebased inside): CAGR, Sharpe, max drawdown, and the CAGR
    edge over each reference line (reference_benchmarks)."""
    from .reference_benchmarks import compare  # noqa: PLC0415 (keeps sweep importable alone)

    equity = equity / equity.iloc[0]
    stats = metrics.curve_stats(equity, cash.reindex(equity.index))
    row = {k: stats[k] for k in ("CAGR", "Sharpe", "max drawdown")}
    for line in compare(equity, references) if references is not None else []:
        row[f"excess vs {line['name']}"] = line["excess_cagr"]
    return row


def sliced_windows(
    equity: pd.Series,
    cash: pd.Series,
    windows: list[Window],
    references: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Score one full-history run inside each window (same portfolio, no restart)."""
    rows = {}
    for start, end in windows:
        part = equity.loc[start:end]
        if len(part) > 2:
            rows[start] = window_row(part, cash, references)
    return pd.DataFrame(rows).T.rename_axis("window start")


def rerun_windows(
    run_window: Callable[[pd.Timestamp, pd.Timestamp], Result],
    windows: list[Window],
    references: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Score a fresh run started at each window's start: `run_window(start, end) -> Result`.
    Every variant starts each window from the same empty portfolio, so a difference is the
    lever's, not years of diverged holdings (the cold-start fork caveat of TODO 3.9.18 still
    applies to anything computed before `start`, e.g. Broad Momentum's category selection)."""
    rows = {}
    for start, end in windows:
        result = run_window(start, end)
        rows[start] = window_row(result.equity, result.cash, references)
    return pd.DataFrame(rows).T.rename_axis("window start")


def compare_rolling(variants: dict[str, pd.DataFrame], baseline: str) -> pd.DataFrame:
    """Per variant vs `baseline`, over the windows both have: share of windows it is better on
    CAGR, Sharpe and max drawdown (shallower), plus the median and worst CAGR/Sharpe/MaxDD
    differences. `wins most` = better Sharpe AND better CAGR in more than half the windows."""
    base = variants[baseline]
    rows = {}
    for label, frame in variants.items():
        joined = frame.join(base, rsuffix=" base", how="inner")
        d_cagr = joined["CAGR"] - joined["CAGR base"]
        d_sharpe = joined["Sharpe"] - joined["Sharpe base"]
        d_dd = joined["max drawdown"] - joined["max drawdown base"]  # positive = shallower
        rows[label] = {
            "windows": len(joined),
            "median CAGR": joined["CAGR"].median(),
            "median Sharpe": joined["Sharpe"].median(),
            "median MaxDD": joined["max drawdown"].median(),
            "CAGR win share": (d_cagr > 1e-12).mean(),
            "Sharpe win share": (d_sharpe > 1e-12).mean(),
            "MaxDD win share": (d_dd > 1e-12).mean(),
            "median dCAGR": d_cagr.median(),
            "worst dCAGR": d_cagr.min(),
            "median dSharpe": d_sharpe.median(),
            "median dMaxDD": d_dd.median(),
            "wins most": label != baseline
            and (d_sharpe > 1e-12).mean() > 0.5
            and (d_cagr > 1e-12).mean() > 0.5,
        }
    return pd.DataFrame(rows).T


@dataclass(frozen=True)
class DeflatedSharpe:
    sharpe: float  # per-period (weekly) Sharpe of the candidate
    expected_max_sharpe: float  # per-period, the best of `n_trials` skill-free trials
    probability: float  # P(true Sharpe > expected best-of-N | observed), Bailey & Lopez de Prado
    n_trials: int
    n_obs: int


def deflated_sharpe(
    excess_returns: pd.Series, trial_sharpes: list[float], n_trials: int | None = None
) -> DeflatedSharpe:
    """Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014) for one candidate's per-period
    excess returns, given the per-period Sharpes of every variant tried. Unlike the simplified
    copy in option-backtesting (reimplemented here, not imported - CLAUDE.md), this keeps the
    skewness/kurtosis term, since weekly strategy returns are fat-tailed. `n_trials` defaults to
    len(trial_sharpes); pass the total tried across the whole study to be honest about it."""
    r = excess_returns.dropna()
    n_obs = len(r)
    if n_obs < 3:
        raise ValueError("need at least 3 observations")
    n = n_trials or len(trial_sharpes)
    sr = r.mean() / r.std()
    spread = statistics.pstdev(trial_sharpes) if len(trial_sharpes) > 1 else 0.0
    if n < 2 or spread == 0:
        expected = 0.0
    else:
        expected = spread * (
            (1 - _EULER_MASCHERONI) * _NORMAL.inv_cdf(1 - 1 / n)
            + _EULER_MASCHERONI * _NORMAL.inv_cdf(1 - 1 / (n * math.e))
        )
    skew, kurt = float(r.skew()), float(r.kurt()) + 3.0  # pandas kurt() is excess kurtosis
    variance = (1 - skew * sr + (kurt - 1) / 4 * sr**2) / (n_obs - 1)
    probability = _NORMAL.cdf((sr - expected) / math.sqrt(variance)) if variance > 0 else math.nan
    return DeflatedSharpe(sr, expected, probability, n, n_obs)


def weekly_excess(result: Result) -> pd.Series:
    """Per-week strategy return minus the liquid fund's - the series Sharpe is computed on."""
    return result.equity.pct_change() - result.cash.pct_change()
