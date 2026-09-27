"""How far index-based P&L is from what trading the ETFs would really have made (`mbt tracking`).

Three questions, each answered from data rather than assumed:
  1. Per ETF, over the weeks it actually existed: how far did it drift from its index (tracking
     difference a year, tracking error), and at what premium to NAV did it trade?
  2. Did the strategy buy at higher premiums than it sold at? Momentum buys what has just run
     up, which is when retail money - and the premium - piles in. The gap between the average
     premium paid on buys and received on sells is a cost the index backtest can't see.
  3. The headline: the same strategy, P&L on the index vs on the ETFs, at Friday close vs
     Monday open vs Monday 10:00 - CAGR, drawdown and Sharpe side by side.
"""

import math
from dataclasses import replace

import pandas as pd

from . import analysis
from .engine import Config, Result, run_backtest
from .sweep import quick_stats
from .trade_prices import EXECUTIONS, TRACKS, TradePrices, build_trade_prices

WEEKS_PER_YEAR = 52
MIN_WEEKS = 26  # fewer weeks of real ETF history than this and the statistics are noise


def etf_tracking(signal: pd.DataFrame, etf: TradePrices, premiums: pd.DataFrame) -> pd.DataFrame:
    """Question 1. `etf` must be the track=etf, execution=fri_close table."""
    rows = []
    for name in etf.prices.columns:
        if pd.isna(etf.notes.at[name, "ETF listed"]):
            continue
        real = ~etf.proxy[name] & etf.prices[name].notna() & signal[name].notna()
        idx, fund = signal.loc[real, name], etf.prices.loc[real, name]
        row = {"instrument": name, "ETF": etf.notes.at[name, "priced on"], "weeks": int(real.sum())}
        if real.sum() >= MIN_WEEKS:
            years = (idx.index[-1] - idx.index[0]).days / 365.25
            idx_cagr = (idx.iloc[-1] / idx.iloc[0]) ** (1 / years) - 1
            fund_cagr = (fund.iloc[-1] / fund.iloc[0]) ** (1 / years) - 1
            gap = fund.pct_change() - idx.pct_change()
            row.update(
                {
                    "from": idx.index[0].date(),
                    "index CAGR": idx_cagr,
                    "ETF CAGR": fund_cagr,
                    "tracking difference / yr": fund_cagr - idx_cagr,
                    "tracking error / yr": gap.std() * math.sqrt(WEEKS_PER_YEAR),
                    "worst week vs index": gap.min(),
                    "best week vs index": gap.max(),
                }
            )
        if name in premiums:
            p = premiums[name].dropna()
            if len(p):
                row.update(
                    {
                        "premium mean": p.mean(),
                        "premium p5": p.quantile(0.05),
                        "premium p95": p.quantile(0.95),
                        "premium max": p.max(),
                        "premium latest": p.iloc[-1],
                    }
                )
        rows.append(row)
    return pd.DataFrame(rows).set_index("instrument") if rows else pd.DataFrame()


def premium_on_trades(result: Result, premiums: pd.DataFrame) -> pd.DataFrame:
    """Question 2: average premium to NAV on the strategy's buys vs its sells, per ETF."""
    trades = result.trades
    if trades.empty or premiums.empty:
        return pd.DataFrame()
    rows = []
    for asset, group in trades.groupby("asset"):
        if asset not in premiums:
            continue
        series = premiums[asset].dropna()
        if series.empty:
            continue

        def at(weeks: pd.Series, _series: pd.Series = series) -> pd.Series:
            known = weeks[weeks >= _series.index[0]]
            return pd.Series([_series.asof(w) for w in known], dtype=float)

        buys = at(group.loc[group["action"].isin(["BUY", "ADD"]), "week"])
        sells = at(group.loc[group["action"].isin(["SELL", "TRIM"]), "week"])
        rows.append(
            {
                "instrument": asset,
                "buys with NAV": len(buys),
                "avg premium paid": buys.mean() if len(buys) else None,
                "sells with NAV": len(sells),
                "avg premium received": sells.mean() if len(sells) else None,
                "premium lost per round trip": (
                    buys.mean() - sells.mean() if len(buys) and len(sells) else None
                ),
            }
        )
    return pd.DataFrame(rows).set_index("instrument") if rows else pd.DataFrame()


def fill_matrix(
    signal: pd.DataFrame,
    includes: dict[str, str],
    base: Config,
    tables: dict[tuple[str, str], TradePrices | None],
) -> tuple[pd.DataFrame, dict[tuple[str, str], Result]]:
    """Question 3: every track x execution run of the same strategy, vs index/fri_close."""
    results, rows, cache = {}, [], {}
    for (track, execution), table in tables.items():
        config = replace(base, track=track, execution=execution)
        prices = table.prices if table is not None else None
        result = run_backtest(signal, includes, config, None, cache, prices)
        results[(track, execution)] = result
        rows.append({"track": track, "execution": execution, **quick_stats(result)})
    matrix = pd.DataFrame(rows).set_index(["track", "execution"])
    if ("index", "fri_close") in matrix.index:
        baseline = matrix.loc[("index", "fri_close")]
        matrix["CAGR vs index/fri_close"] = matrix["CAGR"] - baseline["CAGR"]
        matrix["max DD vs index/fri_close"] = matrix["max drawdown"] - baseline["max drawdown"]
    return matrix, results


def attribution(index_run: Result, etf_run: Result) -> pd.DataFrame:
    """Per instrument: P&L (Rs, per 1 lakh) on the index vs on the ETF, and the difference."""
    groups: dict[str, str] = {}

    def pnl(result: Result) -> pd.Series:
        rows = analysis.instrument_table(result, analysis.closed_trades(result), groups)
        return pd.Series({r["asset"]: r["pnl"] for r in rows}, dtype=float)

    table = pd.DataFrame({"P&L on index": pnl(index_run), "P&L on ETF": pnl(etf_run)}).fillna(0.0)
    table["ETF minus index"] = table["P&L on ETF"] - table["P&L on index"]
    table.index.name = "instrument"
    return table.sort_values("ETF minus index")


def verdict(matrix: pd.DataFrame, premium_trades: pd.DataFrame) -> list[str]:
    """Plain-English reading of the numbers against the plan's decision rule."""
    lines = []
    if ("etf", "fri_close") in matrix.index and "CAGR vs index/fri_close" in matrix:
        gap = matrix.at[("etf", "fri_close"), "CAGR vs index/fri_close"]
        size = "small" if abs(gap) < 0.005 else "material"
        lines.append(
            f"ETF vs index P&L at Friday close: {gap:+.2%} CAGR a year ({size}; the threshold "
            "is 0.5 points)."
        )
    for execution in ("mon_open", "mon_10am"):
        if ("etf", execution) in matrix.index:
            cost = (
                matrix.at[("etf", execution), "CAGR"] - matrix.at[("etf", "fri_close"), "CAGR"]
                if ("etf", "fri_close") in matrix.index
                else float("nan")
            )
            lines.append(f"Trading {execution} instead of Friday close: {cost:+.2%} CAGR a year.")
    if not premium_trades.empty:
        lost = premium_trades["premium lost per round trip"].dropna()
        if len(lost):
            lines.append(
                f"Premium paid on buys minus premium received on sells: {lost.mean():+.2%} per "
                f"round trip on average (worst: {lost.idxmax()} {lost.max():+.2%})."
            )
    else:
        lines.append(
            "No premium data: fill `amfi_code` in universe.csv (`mbt amfi-codes`) and re-run "
            "`mbt fetch`."
        )
    return lines


def all_tables(
    signal: pd.DataFrame, executions: tuple[str, ...] = EXECUTIONS
) -> dict[tuple[str, str], TradePrices | None]:
    return {(t, e): build_trade_prices(signal, t, e) for t in TRACKS for e in executions}
