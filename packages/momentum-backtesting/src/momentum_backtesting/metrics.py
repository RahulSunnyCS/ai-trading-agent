"""Performance statistics for a backtest Result."""

import math

import pandas as pd

from .engine import CASH, GILT, IDLE, Result

WEEKS_PER_YEAR = 52


def _years(series: pd.Series) -> float:
    return (series.index[-1] - series.index[0]).days / 365.25


def cagr(series: pd.Series) -> float:
    return (series.iloc[-1] / series.iloc[0]) ** (1 / _years(series)) - 1


def drawdown(series: pd.Series) -> pd.Series:
    return series / series.cummax() - 1


def max_drawdown(series: pd.Series) -> tuple[float, pd.Timestamp, pd.Timestamp]:
    """(depth, peak week, trough week)."""
    dd = drawdown(series)
    trough = dd.idxmin()
    peak = series.loc[:trough].idxmax()
    return dd.min(), peak, trough


def curve_stats(equity: pd.Series, cash: pd.Series) -> dict[str, float]:
    """CAGR, volatility, Sharpe (vs cash, same definition as `summary`) and max drawdown of a
    bare equity curve - for curves that are not a single Result (tranche blends, windows)."""
    weekly = equity.pct_change().dropna()
    excess = weekly - cash.reindex(equity.index).pct_change().dropna()
    spread = excess.std()
    depth, _, trough = max_drawdown(equity)
    return {
        "CAGR": cagr(equity),
        "volatility": weekly.std() * math.sqrt(WEEKS_PER_YEAR),
        "Sharpe": excess.mean() / spread * math.sqrt(WEEKS_PER_YEAR) if spread > 0 else math.nan,
        "max drawdown": depth,
        "max drawdown trough": f"{trough:%Y-%m-%d}",
    }


def worst_episodes(series: pd.Series, count: int = 3) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """The `count` deepest peak-to-trough falls that don't overlap each other."""
    dd = drawdown(series)
    episodes, used = [], pd.Series(False, index=series.index)
    while len(episodes) < count:
        remaining = dd[~used]
        if remaining.empty or remaining.min() >= 0:
            break
        trough = remaining.idxmin()
        peak = series.loc[:trough].idxmax()
        recovered = series.loc[trough:][series.loc[trough:] >= series[peak]]
        end = recovered.index[0] if not recovered.empty else series.index[-1]
        used |= (series.index >= peak) & (series.index <= end)
        episodes.append((peak, trough))
    return sorted(episodes)


def summary(result: Result) -> dict[str, float | str | int]:
    eq, cash = result.equity, result.cash
    weekly = eq.pct_change().dropna()
    excess = weekly - cash.pct_change().dropna()
    depth, peak, trough = max_drawdown(eq)
    trades = result.trades
    buys = trades[trades["action"] == "BUY"] if not trades.empty else trades
    sells = trades[trades["action"] == "SELL"] if not trades.empty else trades
    weights = result.weights
    defensive_cols = [c for c in (IDLE, CASH, GILT) if c in weights]
    positions = weights.drop(columns=[IDLE], errors="ignore")

    return {
        "start": f"{eq.index[0]:%Y-%m-%d}",
        "end": f"{eq.index[-1]:%Y-%m-%d}",
        "CAGR": cagr(eq),
        "benchmark CAGR": cagr(result.benchmark),
        "cash CAGR": cagr(cash),
        "total return": eq.iloc[-1] - 1,
        "volatility": weekly.std() * math.sqrt(WEEKS_PER_YEAR),
        "Sharpe (vs cash)": excess.mean() / excess.std() * math.sqrt(WEEKS_PER_YEAR),
        "max drawdown": depth,
        "max drawdown peak": f"{peak:%Y-%m-%d}",
        "max drawdown trough": f"{trough:%Y-%m-%d}",
        "benchmark max drawdown": max_drawdown(result.benchmark)[0],
        "buys": len(buys),
        "sells": len(sells),
        "buys per year": len(buys) / _years(eq),
        "avg weeks held": _avg_weeks_held(result),
        "time in cash/debt": weights[defensive_cols].sum(axis=1).mean() if defensive_cols else 0.0,
        "avg holdings": (positions > 1e-9).sum(axis=1).mean(),
        "max position share": positions.max().max() if not positions.empty else 0.0,
    }


def _avg_weeks_held(result: Result) -> float:
    """Average length of every position, closed or still open, from its first purchase."""
    lengths = []
    trades = result.trades
    if "weeks_held" in trades:
        lengths += trades.loc[trades["action"] == "SELL", "weeks_held"].tolist()
    if not result.open_positions.empty:
        lengths += result.open_positions["weeks_held"].tolist()
    return sum(lengths) / len(lengths) if lengths else float("nan")


def yearly(result: Result) -> pd.DataFrame:
    frame = pd.concat([result.equity, result.benchmark, result.cash], axis=1)
    year_end = frame.groupby(frame.index.year).last()
    start = frame.iloc[[0]].set_axis([frame.index[0].year - 1])
    returns = pd.concat([start, year_end]).pct_change().dropna()
    returns.index.name = "year"
    returns["vs benchmark"] = returns["strategy"] - returns[result.benchmark.name]
    return returns


def crash_table(result: Result) -> pd.DataFrame:
    """Strategy vs benchmark during the benchmark's three worst falls."""
    rows = []
    for peak, trough in worst_episodes(result.benchmark):
        rows.append(
            {
                "benchmark peak": f"{peak:%Y-%m-%d}",
                "benchmark trough": f"{trough:%Y-%m-%d}",
                "benchmark": result.benchmark[trough] / result.benchmark[peak] - 1,
                "strategy": result.equity[trough] / result.equity[peak] - 1,
            }
        )
    return pd.DataFrame(rows)
