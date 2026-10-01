"""Overlapping tranches: K sub-portfolios that trade on staggered weeks, averaged.

A weekly-or-slower momentum backtest has start-date luck: shift the trading Fridays by one week
and the same rules can land a crash differently. Splitting capital into K equal tranches, each
trading every K weeks on its own calendar phase (`Config.rebalance_every` / `rebalance_offset`),
and averaging their curves removes most of that luck. The spread between tranches measures how
big it was; the blend is what the rule is worth without it (TODO 3.9.23, Step 0c).

Modelling choices, stated so nobody mistakes them for facts:
- The blend is the mean of the tranche curves: K equal pots at the start, never rebalanced
  against each other.
- Each tranche is an independent `run_backtest`. With tax on, each has its own ledger, so a loss
  in one tranche never offsets a gain in another (slightly pessimistic).
- `cost_model="itemised"` sizes its flat per-sale DP charge on `capital`; each tranche gets
  `capital / K`, so K tranches pay K small DP charges, as they would in real life.
- Trade counts are summed across tranches: K tranches place about K times as many (smaller)
  orders as one portfolio trading every K weeks.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace

import pandas as pd

from . import metrics
from .engine import Config, Result, run_backtest


@dataclass
class TrancheRun:
    every: int
    tranches: list[Result]
    equity: pd.Series  # blended curve, 1.0 at the start
    benchmark: pd.Series
    cash: pd.Series

    def buys_per_year(self) -> float:
        years = (self.equity.index[-1] - self.equity.index[0]).days / 365.25
        buys = sum(int((r.trades["action"] == "BUY").sum()) for r in self.tranches if len(r.trades))
        return buys / years

    def table(self) -> pd.DataFrame:
        """One row per tranche plus the blend: CAGR, Sharpe, max drawdown, buys a year."""
        rows = {}
        for offset, result in enumerate(self.tranches):
            stats = metrics.curve_stats(result.equity, result.cash)
            years = (result.equity.index[-1] - result.equity.index[0]).days / 365.25
            buys = int((result.trades["action"] == "BUY").sum()) if len(result.trades) else 0
            rows[f"phase {offset}"] = {**stats, "buys/yr": buys / years}
        rows["blend"] = {
            **metrics.curve_stats(self.equity, self.cash),
            "buys/yr": self.buys_per_year(),
        }
        return pd.DataFrame(rows).T

    def luck(self) -> dict[str, float]:
        """How much the trading Fridays alone moved the result: the spread across tranches."""
        cagrs = [metrics.cagr(r.equity) for r in self.tranches]
        depths = [metrics.max_drawdown(r.equity)[0] for r in self.tranches]
        return {
            "CAGR spread": max(cagrs) - min(cagrs),
            "max drawdown spread": max(depths) - min(depths),
        }


def blend(results: list[Result]) -> TrancheRun:
    if not results:
        raise ValueError("no tranches to blend")
    curves = pd.concat([r.equity for r in results], axis=1)
    if curves.isna().any().any():
        raise ValueError("tranches cover different weeks - run them over the same window")
    first = results[0]
    return TrancheRun(
        every=len(results),
        tranches=results,
        equity=curves.mean(axis=1).rename("strategy"),
        benchmark=first.benchmark,
        cash=first.cash,
    )


def tranche_configs(config: Config, every: int) -> list[Config]:
    if config.rebalance != "weekly":
        raise ValueError("tranches need rebalance='weekly' (they stagger the weekly calendar)")
    if every < 1:
        raise ValueError("every must be at least 1")
    capital = config.capital / every
    return [
        replace(config, rebalance_every=every, rebalance_offset=offset, capital=capital)
        for offset in range(every)
    ]


def run_tranches(run_one: Callable[[Config], Result], config: Config, every: int) -> TrancheRun:
    """`run_one(config) -> Result` once per phase. Any dataset works: pass a closure over
    `run_backtest` (or `run_backtest_tranches` below), or over Broad Momentum's
    `run_broad_backtest(...).result` with its cached `ranking=`."""
    return blend([run_one(c) for c in tranche_configs(config, every)])


def run_backtest_tranches(
    prices: pd.DataFrame,
    includes: dict[str, str],
    config: Config,
    every: int,
    **kwargs,
) -> TrancheRun:
    """`run_tranches` over `engine.run_backtest`; `kwargs` go straight to it (tax_classes,
    rank_cache, trade_prices, external_ranks, ...)."""
    return run_tranches(lambda c: run_backtest(prices, includes, c, **kwargs), config, every)
