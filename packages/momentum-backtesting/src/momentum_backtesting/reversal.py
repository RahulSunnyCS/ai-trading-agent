"""Reversal / turnaround sleeve (TODO 3.9.23, Step 2): gate, confirm, rank, hold.

Why negative lookback weights did not find turnarounds: a rank-sum cannot express a condition. A
name ranked 700 of 755 on 52-week return adds about -700 to its score, which swamps the short
windows, so the result is a "worst 52-week losers" screen; and at the 6-12 month horizon past
losers keep losing (that is momentum). This module expresses the condition directly, then hands
`engine.run_backtest` an ordinary rank table (`external_ranks`) plus an entry mask (`no_buy`),
so the engine is unchanged.

1. Gate, "was beaten down" (any week in the last `sticky_weeks`): 52-week return in the bottom
   `bottom_quantile` of eligible names, or more than `drawdown` below the 52-week high, or
   below the `ma_weeks`-week average in at least `below_ma_weeks` of the last 52 weeks.
2. Turned: 13-week return positive and not at a new 52-week low (a fresh 52-week low makes the
   name ineligible, so a held name is sold - the "fell back below its old low" exit, using the
   rolling 52-week low as a stand-in for the pre-entry low).
3. Rank the gated, turned names on acceleration: the latest 13-week return minus the 13 weeks
   before it (lower rank = better), or on the plain 13-week return (`rank_on="momentum"`).
4. Entry confirmation, `no_buy` only (so a holding is not sold the moment it recovers): the
   26-week return is still negative, the close is above its `confirm_ma_weeks`-week average,
   and, when volume is supplied, up-week volume beat down-week volume over `volume_weeks`.

Holding then follows the engine's usual top_n / exit_rank hysteresis. Price-only turnaround
screens usually trail momentum on their own; the sleeve is judged as a diversifier (a 20%
blend), not as a Nifty-beater. A true earnings-inflection screen needs fundamentals, which this
repo does not have, and no fundamentals proxy is invented here.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

#: Rank given to tradeable-but-ineligible names (see reversal_signals).
FAR = 10_000.0


@dataclass(frozen=True)
class ReversalParams:
    bottom_quantile: float = 0.2
    drawdown: float = 0.40
    ma_weeks: int = 40  # ~200 trading days
    below_ma_weeks: int = 26
    sticky_weeks: int = 52
    confirm_ma_weeks: int = 10  # ~50 trading days
    volume_weeks: int = 8
    # "acceleration": latest 13-week return minus the 13 weeks before it; "momentum": the plain
    # 13-week return. The handover allowed either; both were measured (TODO 3.9.23).
    rank_on: str = "acceleration"


@dataclass
class ReversalSignals:
    ranks: pd.DataFrame
    scores: pd.DataFrame
    no_buy: pd.DataFrame
    gate: pd.DataFrame  # beaten down this week (before the sticky window)
    eligible: pd.DataFrame  # ranked this week

    @property
    def external_ranks(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        return self.ranks, self.scores


def _ret(prices: pd.DataFrame, weeks: int) -> pd.DataFrame:
    return prices / prices.shift(weeks) - 1


def reversal_signals(
    prices: pd.DataFrame,
    membership: pd.DataFrame | None = None,
    volume: pd.DataFrame | None = None,
    params: ReversalParams | None = None,
) -> ReversalSignals:
    """`prices`: week x name weekly closes of the names to consider (no cash/benchmark).
    `membership` (optional, same shape, booleans): a name is only considered while a member.
    `volume` (optional, same shape): weekly traded volume for the entry confirmation."""
    p = params or ReversalParams()
    live = prices.notna()
    if membership is not None:
        live &= membership.reindex_like(prices).fillna(False).astype(bool)

    r52 = _ret(prices, 52).where(live)
    high52 = prices.rolling(52, min_periods=52).max()
    low52 = prices.rolling(52, min_periods=52).min()
    average = prices.rolling(p.ma_weeks, min_periods=p.ma_weeks).mean()

    bottom = r52.le(r52.quantile(p.bottom_quantile, axis=1), axis=0) & r52.notna()
    deep = (prices / high52 - 1) < -p.drawdown
    below = (prices < average).astype(float).where(average.notna())
    long_below = below.rolling(52, min_periods=52).sum() >= p.below_ma_weeks
    gate = (bottom | deep | long_below) & live
    sticky = gate.astype(float).rolling(p.sticky_weeks, min_periods=1).max().astype(bool)

    r13 = _ret(prices, 13)
    turned = (r13 > 0) & (prices > low52)
    eligible = sticky & turned & live & prices.notna()

    if p.rank_on not in ("acceleration", "momentum"):
        raise ValueError(f"unknown rank_on {p.rank_on!r}")
    signal = r13 - r13.shift(13) if p.rank_on == "acceleration" else r13
    acceleration = signal.where(eligible)
    # Tradeable names that are not eligible get a far-away rank instead of NaN: the engine drops
    # any week with fewer than top_n ranked names, and a sparse sleeve must still run (holding
    # fewer names plus cash). FAR is beyond any exit_rank, so they are sold and never bought.
    tradeable = prices.notna() & live
    far = pd.DataFrame(
        np.tile(FAR + np.arange(prices.shape[1], dtype=float), (len(prices), 1)),
        index=prices.index,
        columns=prices.columns,
    )
    ranks = (-acceleration).rank(axis=1, method="first").where(eligible, far.where(tradeable))
    scores = (-acceleration).where(eligible, far.where(tradeable))

    confirm = (_ret(prices, 26) < 0) & (
        prices > prices.rolling(p.confirm_ma_weeks, min_periods=p.confirm_ma_weeks).mean()
    )
    if volume is not None:
        vol = volume.reindex_like(prices)
        change = prices.pct_change()
        up = vol.where(change > 0, 0.0).rolling(p.volume_weeks, min_periods=p.volume_weeks).sum()
        down = vol.where(change < 0, 0.0).rolling(p.volume_weeks, min_periods=p.volume_weeks).sum()
        confirm &= up > down
    no_buy = ~(confirm.fillna(False).astype(bool) & eligible)
    return ReversalSignals(ranks=ranks, scores=scores, no_buy=no_buy, gate=gate, eligible=eligible)


def weekly_volume(daily_parquet: Path, column_to_symbol: dict[str, str], weeks) -> pd.DataFrame:
    """Weekly (Friday-labelled) traded volume per price column from the stock daily bars, mapped
    through `column_to_symbol` (Broad's split segments share their base symbol's volume)."""
    symbols = sorted(set(column_to_symbol.values()))
    daily = pd.read_parquet(
        daily_parquet, columns=["date", "symbol", "volume"], filters=[("symbol", "in", symbols)]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    wide = daily.pivot_table(index="date", columns="symbol", values="volume", aggfunc="sum")
    weekly = wide.resample("W-FRI").sum(min_count=1).reindex(pd.DatetimeIndex(weeks))
    return pd.DataFrame(
        {col: weekly[sym] for col, sym in column_to_symbol.items() if sym in weekly},
        index=weekly.index,
    )


def blend_curves(
    momentum: pd.Series, reversal: pd.Series, weight: float = 0.2, rebalance: bool = False
) -> pd.Series:
    """Split capital `1 - weight` / `weight` between two sleeves. rebalance=False holds the split
    from the start and never trades between them (no extra cost); rebalance=True restores the
    split every week (an upper bound on the diversification benefit - the switching cost is
    ignored)."""
    m = momentum / momentum.iloc[0]
    r = reversal.reindex(m.index) / reversal.reindex(m.index).iloc[0]
    if not rebalance:
        return (1 - weight) * m + weight * r
    weekly = (1 - weight) * m.pct_change() + weight * r.pct_change()
    return (1 + weekly.fillna(0.0)).cumprod()
