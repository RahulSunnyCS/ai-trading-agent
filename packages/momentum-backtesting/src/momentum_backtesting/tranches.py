"""Overlapping tranches: K sub-portfolios that trade on staggered weeks, averaged.

A weekly-or-slower momentum backtest has start-date luck: shift the trading Fridays by one week
and the same rules can land a crash differently. Splitting capital into K equal tranches, each
trading every K weeks on its own calendar phase (`Config.rebalance_every` / `rebalance_offset`),
and averaging their curves removes most of that luck. The spread between tranches measures how
big it was; the blend is what the rule is worth without it (TODO 3.9.23, Step 0c).

Modelling choices, stated so nobody mistakes them for facts:
- `blend` is the mean of the tranche curves: K equal pots at the start, never rebalanced
  against each other (the research scripts, BL-054). `blend_reset` (BL-056: the dashboard's
  "All Fridays" backtest and the followed group) restores equal capital at each April reset
  (`groups.reset_weeks`, the ensemble's convention) and returns a whole `Result`. The money moved
  between tranches at a reset is not traded in the log: no cost or tax is charged for it.
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

import numpy as np
import pandas as pd

from . import groups, metrics
from .engine import IDLE, Config, Result, run_backtest
from .tax import TaxLedger

#: Trade-log and open-position columns in portfolio units (1.0 = a tranche's starting capital):
#: `blend_reset` rescales them into the blend's units. Prices, returns and weeks stay as they are.
MONEY_COLUMNS = ("value", "tax", "cost", "units", "prev_units", "entry_value")


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


def _reset_factors(results: list[Result]) -> pd.DataFrame:
    """week x tranche: what one unit of a tranche's own curve is worth in the blend's units.

    The blend restores equal capital at each April reset (`groups.reset_weeks`), so from the reset
    `r` that opens a span, a tranche is worth `level(r) / K * equity(t) / equity(r)`. A reset
    week itself belongs to the span it closes: its trades and holdings happen before the money
    is evened out, and the blend's value there is the same either way."""
    curves = pd.concat([r.equity for r in results], axis=1, keys=range(len(results)))
    if curves.isna().any().any():
        raise ValueError("tranches cover different weeks - run them over the same window")
    weeks, k = curves.index, len(results)
    resets = groups.reset_weeks(weeks)
    factors = pd.DataFrame(np.nan, index=weeks, columns=curves.columns)
    level = 1.0
    for i, start in enumerate(resets):
        end = resets[i + 1] if i + 1 < len(resets) else weeks[-1]
        base = curves.loc[start]
        span = (weeks > start) & (weeks <= end) if i else (weeks >= start) & (weeks <= end)
        factors.loc[span] = (level / k / base).to_numpy()
        level = float((curves.loc[end] / base).mean() * level)
    return factors


def blend_reset(results: list[Result]) -> Result:
    """K tranches (`tranche_configs`, same window) as one `Result` of the whole account: equal
    capital restored each April, so `equity` is `choose.ensemble_curve` of the tranche curves.
    Every per-week and per-trade figure is rescaled into the blend's units, so the payload code
    reads it as it reads any run:

    - `weights`: each tranche's weights mixed by its share of the account that week;
    - `trades`: every tranche's log, money columns rescaled, plus `friday` (the tranche's
      `rebalance_offset`), in week order;
    - `open_positions`: summed per asset across tranches; `idle_value`, the tax ledger's money
      likewise. Separate ledgers: a loss in one tranche never offsets a gain in another.
    - `ranks`, `scores`, `benchmark`, `cash`, `ranked_names`: the first tranche's (the ranking
      does not depend on the calendar phase); `config`: the first's, with offset 0 and the
      whole capital.
    """
    if not results:
        raise ValueError("no tranches to blend")
    first = results[0]
    if len(results) == 1:
        return first
    factors = _reset_factors(results)
    values = pd.concat(
        [r.equity * factors[i] for i, r in enumerate(results)], axis=1, keys=range(len(results))
    )
    equity = values.sum(axis=1).rename(first.equity.name)
    shares = values.div(equity, axis=0)

    # The engine writes no weights row for a week a tranche holds nothing: that tranche is all
    # idle cash then (it has not bought yet, or sold everything).
    columns = list(dict.fromkeys([IDLE, *(c for r in results for c in r.weights.columns)]))
    index = results[0].weights.index
    for r in results[1:]:
        index = index.union(r.weights.index)
    parts = []
    for i, r in enumerate(results):
        frame = r.weights.reindex(index=index, columns=columns)
        idle = frame.isna().all(axis=1)
        frame = frame.fillna(0.0)
        frame.loc[idle, IDLE] = 1.0
        parts.append(frame.mul(shares[i].reindex(index), axis=0))
    weights = sum(parts)
    if IDLE not in first.weights.columns and not weights[IDLE].any():
        weights = weights.drop(columns=[IDLE])

    logs = []
    for i, r in enumerate(results):
        if r.trades.empty:
            continue
        log = r.trades.copy()
        scale = factors[i].reindex(log["week"]).to_numpy()
        for column in MONEY_COLUMNS:
            if column in log:
                log[column] = log[column] * scale
        log["friday"] = r.config.rebalance_offset
        logs.append(log)
    trades = (
        pd.concat(logs, ignore_index=True).sort_values("week", kind="stable", ignore_index=True)
        if logs
        else first.trades.copy()
    )

    last = factors.iloc[-1]
    held = [
        r.open_positions.assign(
            **{c: r.open_positions[c] * last[i] for c in ("value", "entry_value")}
        )
        for i, r in enumerate(results)
        if len(r.open_positions)
    ]
    open_positions = _merge_open(held) if held else first.open_positions

    return Result(
        config=replace(
            first.config, rebalance_offset=0, capital=first.config.capital * len(results)
        ),
        equity=equity,
        benchmark=first.benchmark,
        cash=first.cash,
        weights=weights,
        holdings=first.holdings,
        trades=trades,
        ranks=first.ranks,
        scores=first.scores,
        ranked_names=first.ranked_names,
        tax_ledger=_merge_ledgers(results, factors),
        open_positions=open_positions,
        idle_value=float(sum(r.idle_value * last[i] for i, r in enumerate(results))),
    )


def _merge_open(held: list[pd.DataFrame]) -> pd.DataFrame:
    """One open position per asset: values summed, held since its earliest buy."""
    rows = []
    for asset, part in pd.concat(held, ignore_index=True).groupby("asset", sort=False):
        value, basis = float(part["value"].sum()), float(part["entry_value"].sum())
        oldest = part.loc[part["entry_week"].idxmin()]
        rows.append(
            {
                "slot": None,
                "asset": asset,
                "value": value,
                "rank": oldest["rank"],
                "entry_week": oldest["entry_week"],
                "entry_value": basis,
                "weeks_held": float(part["weeks_held"].max()),
                "price_return": oldest["price_return"],
                "position_return": value / basis - 1 if basis else float("nan"),
            }
        )
    return pd.DataFrame(rows)


def _merge_ledgers(results: list[Result], factors: pd.DataFrame) -> TaxLedger | None:
    """The tranches' ledgers added up in the blend's units (tax is paid on each tranche's own
    sales: separate ledgers, slightly pessimistic). Tax paid is rescaled at the weeks each
    tranche paid it, from its trade log."""
    ledgers = [r.tax_ledger for r in results]
    if all(ledger is None for ledger in ledgers):
        return None
    last = factors.iloc[-1]
    merged = TaxLedger(next(ledger for ledger in ledgers if ledger is not None).rules)
    for i, (result, ledger) in enumerate(zip(results, ledgers, strict=True)):
        if ledger is None:
            continue
        trades = result.trades
        raw = float(trades["tax"].sum()) if "tax" in trades and len(trades) else 0.0
        if raw:
            scaled = float((trades["tax"] * factors[i].reindex(trades["week"]).to_numpy()).sum())
            ratio = scaled / raw
        else:
            ratio = float(last[i])
        merged.paid += ledger.paid * ratio
        merged.short_loss += ledger.short_loss * float(last[i])
        merged.long_loss += ledger.long_loss * float(last[i])
        merged.sales += ledger.sales
        merged.long_term_sales += ledger.long_term_sales
    return merged


def friday_spread(results: list[Result], blended: Result) -> dict:
    """Each calendar phase's figures next to the blend's: how much picking one Friday was luck.
    Curves are whatever the runs produced (after tax when the runs were taxed)."""

    def row(equity: pd.Series) -> dict:
        depth = metrics.max_drawdown(equity)[0]
        return {
            "cagr": float(metrics.cagr(equity)),
            "max_drawdown": float(depth),
            "ulcer": float(metrics.underwater_stats(equity)["ulcer"]),
        }

    phases = [{"offset": r.config.rebalance_offset, **row(r.equity)} for r in results]
    cagrs = [p["cagr"] for p in phases]
    return {
        "every": len(results),
        "phases": phases,
        "blend": row(blended.equity),
        "cagr_spread": max(cagrs) - min(cagrs),
    }
