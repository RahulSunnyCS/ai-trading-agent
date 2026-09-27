"""Excel output for backtest results."""

from pathlib import Path

import pandas as pd

from . import metrics
from .engine import Result

PERCENT_ROWS = {
    "CAGR",
    "benchmark CAGR",
    "cash CAGR",
    "total return",
    "volatility",
    "max drawdown",
    "benchmark max drawdown",
    "time in cash/debt",
    "max position share",
}


def pretty(summary: dict) -> dict:
    out = {}
    for key, value in summary.items():
        if key in PERCENT_ROWS:
            out[key] = f"{value:.1%}"
        elif isinstance(value, float):
            out[key] = round(value, 2)
        else:
            out[key] = value
    return out


def write_result(result: Result, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    curves = pd.concat(
        [
            result.equity,
            result.benchmark,
            result.cash,
            metrics.drawdown(result.equity).rename("strategy drawdown"),
            metrics.drawdown(result.benchmark).rename("benchmark drawdown"),
        ],
        axis=1,
    )
    curves.index.name = "week"
    settings = {k: str(v) for k, v in vars(result.config).items()}
    with pd.ExcelWriter(path) as xl:
        pd.Series(pretty(metrics.summary(result)), name="value").to_frame().to_excel(
            xl, sheet_name="summary"
        )
        pd.Series(settings, name="value").to_frame().to_excel(xl, sheet_name="settings")
        metrics.yearly(result).to_excel(xl, sheet_name="yearly")
        metrics.crash_table(result).to_excel(xl, sheet_name="crashes", index=False)
        curves.to_excel(xl, sheet_name="equity")
        result.holdings.to_excel(xl, sheet_name="holdings")
        result.weights.to_excel(xl, sheet_name="weights")
        result.trades.to_excel(xl, sheet_name="trades", index=False)
        result.ranks.to_excel(xl, sheet_name="ranks")
        result.scores.to_excel(xl, sheet_name="scores")


def write_comparison(results: dict[str, Result], path: Path) -> pd.DataFrame:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pd.DataFrame({name: pretty(metrics.summary(r)) for name, r in results.items()})
    yearly = pd.concat({name: metrics.yearly(r)["strategy"] for name, r in results.items()}, axis=1)
    first = next(iter(results.values()))
    yearly["benchmark"] = metrics.yearly(first)[first.benchmark.name]
    crashes = pd.concat(
        {
            name: metrics.crash_table(r).set_index(["benchmark peak", "benchmark trough"])[
                "strategy"
            ]
            for name, r in results.items()
        },
        axis=1,
    )
    crashes["benchmark"] = metrics.crash_table(first).set_index(
        ["benchmark peak", "benchmark trough"]
    )["benchmark"]
    curves = pd.concat({name: r.equity for name, r in results.items()}, axis=1)
    curves["benchmark"] = first.benchmark
    with pd.ExcelWriter(path) as xl:
        table.to_excel(xl, sheet_name="summary")
        yearly.to_excel(xl, sheet_name="yearly")
        crashes.to_excel(xl, sheet_name="crashes")
        curves.to_excel(xl, sheet_name="equity")
    return table


def write_tables(tables: dict[str, pd.DataFrame], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path) as xl:
        for name, table in tables.items():
            table.to_excel(xl, sheet_name=name[:31])
