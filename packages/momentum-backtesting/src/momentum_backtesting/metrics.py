"""Performance statistics for a backtest Result."""

import math

import numpy as np
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


def underwater_stats(series: pd.Series) -> dict[str, float]:
    """How long a curve spends below its previous high, in weeks (the series is weekly).

    max_underwater_weeks   the longest stretch from a peak until the next new high. A stretch
                           still open at the end counts up to the last week.
    recovery_weeks         from the trough of the deepest drawdown to the next new high; if it
                           never recovers, the weeks left in the series (a lower bound).
    recovered              1.0 if the deepest drawdown was recovered by the end, else 0.0.
    underwater_share_5     share of weeks more than 5% below the previous high.
    ulcer                  root-mean-square drawdown: penalises depth and duration together.
    """
    values = series.to_numpy(dtype=float)
    peak = np.maximum.accumulate(values)
    dd = values / peak - 1
    under = values < peak - 1e-12
    longest = run = 0
    for flag in under:
        run = run + 1 if flag else 0
        longest = max(longest, run)
    trough = int(np.argmin(dd))
    after = np.flatnonzero(values[trough:] >= peak[trough] - 1e-12)
    recovered = len(after) > 0
    recovery = float(after[0]) if recovered else float(len(values) - 1 - trough)
    return {
        "max_underwater_weeks": float(longest),
        "recovery_weeks": recovery,
        "recovered": 1.0 if recovered else 0.0,
        "underwater_share_5": float((dd < -0.05).mean()),
        "ulcer": float(np.sqrt((dd**2).mean())),
    }


def window_stats(series: pd.Series, windows: dict[str, tuple[str, str | None]]) -> dict[str, float]:
    """Per named (start, end) window of a weekly curve, judged against the curve's OWN running high
    over its whole history (so a stretch that starts under an old peak counts as under water):

      <name>_cagr      annualised growth over the weeks inside the window
      <name>_newhigh   share of those weeks that set a new all-time high of the curve
      <name>_uw        longest run of consecutive weeks inside the window below the previous high
    """
    values = series.to_numpy(dtype=float)
    peak = np.maximum.accumulate(values)
    new_high = np.zeros(len(values), dtype=bool)
    new_high[1:] = values[1:] > peak[:-1] + 1e-12
    under = values < peak - 1e-12
    out: dict[str, float] = {}
    for name, (start, end) in windows.items():
        mask = (series.index >= pd.Timestamp(start)) & (
            True if end is None else series.index <= pd.Timestamp(end)
        )
        mask = np.asarray(mask)
        if mask.sum() < 2:
            continue
        idx = np.flatnonzero(mask)
        years = (series.index[idx[-1]] - series.index[idx[0]]).days / 365.25
        out[f"{name}_cagr"] = float((values[idx[-1]] / values[idx[0]]) ** (1 / years) - 1)
        out[f"{name}_newhigh"] = float(new_high[mask].mean())
        longest = run = 0
        for flag in under[mask]:
            run = run + 1 if flag else 0
            longest = max(longest, run)
        out[f"{name}_uw"] = float(longest)
    return out
