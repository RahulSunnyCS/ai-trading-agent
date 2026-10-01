"""Research levers for the momentum alpha study (TODO 3.9.23, Step 1), built without touching the
engine's ranking or selection: each is a rank table for `run_backtest(external_ranks=...)`, a
`no_buy` mask (blocks fresh buys only, never forces a sale), or a post-hoc overlay on a finished
equity curve. All are point-in-time: week t only uses closes up to week t.

Weekly closes only. For stocks, daily highs/volume exist (`data/stocks/daily.parquet`), but the
Broad Momentum price frame is weekly raw closes, so "52-week high" here is the highest weekly
close, a slight understatement of the true intraday high.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np
import pandas as pd

from .engine import Config, compute_ranks

# --- Rank tables (external_ranks) ---------------------------------------------------------------


def skip_month_ranks(prices: pd.DataFrame, config: Config, skip: int = 4):
    """Experiment 1b: ranksum on returns that END `skip` weeks ago, so the most recent month
    (which tends to mean-revert) is left out. Lookbacks no longer than `skip + 4` weeks are
    dropped and the rest are shortened by `skip` and measured on prices shifted back `skip`
    weeks: from the default (1, 4, 13, 26, 52) that is t-13..t-4, t-26..t-4 and t-52..t-4, the
    classic 3-1, 6-1 and 12-1 month windows. Returns (ranks, scores) for external_ranks."""
    lookbacks = tuple(lb - skip for lb in config.lookbacks if lb > skip + 4)
    if not lookbacks:
        raise ValueError("no lookback is longer than the skipped weeks")
    shifted = replace(config, lookbacks=lookbacks, weights=None)
    return compute_ranks(prices.shift(skip), shifted)


def high52_proximity(prices: pd.DataFrame, weeks: int = 52) -> pd.DataFrame:
    """Close / highest weekly close over the last `weeks` weeks (1.0 = at the high). NaN until a
    full window exists."""
    return prices / prices.rolling(weeks, min_periods=weeks).max()


def rerank(score: pd.DataFrame) -> pd.DataFrame:
    """Lower score = better; ties broken by column order (stable); NaN stays NaN."""
    return score.rank(axis=1, method="first")


def blend_ranks(*tables: pd.DataFrame) -> pd.DataFrame:
    """Average of several rank tables, re-ranked; a name missing from any table is NaN."""
    total = sum(tables[1:], tables[0])
    return rerank(total)


def high52_ranks(prices: pd.DataFrame, config: Config):
    """Experiment 3b: the usual ranksum blended 50/50 with a 52-week-high proximity rank (closer
    to the high ranks better). Returns (ranks, scores) for external_ranks."""
    base, _ = compute_ranks(prices, config)
    near_high = rerank(-high52_proximity(prices)).where(base.notna())
    ranks = blend_ranks(base, near_high)
    return ranks, ranks.astype(float)


def grouped_momentum_ranks(
    prices: pd.DataFrame,
    config: Config,
    long_lookbacks: tuple[int, ...] = (26, 52),
    tilt: float = 0.3,
    screen_top_pct: float = 0.0,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Owner's turnaround idea (TODO 3.9.23 follow-up), done as two SEPARATE rank-sums instead
    of one mixed-sign one. The original failure mode: a single rank-sum with a negative weight
    on the 26/52-week lookbacks lets that lookback's rank (which can be in the hundreds) swamp
    the short lookbacks, so the result is just "worst 52-week losers", most of which are still
    falling - not a turnaround screen at all.

    Here the short lookbacks (`config.lookbacks` minus `long_lookbacks`, e.g. 1/4/13) are
    ranked on their own, ranksum, equal weights - call that rank R_short (1 = best). The long
    lookbacks are ALSO ranked on their own, ranksum, with weight -1 on each - this reuses the
    negative-weight-rewards-the-worst-performer mechanism
    (`test_negative_weight_rewards_the_worst_performer_on_that_lookback`), but scoped to only
    the long group, so "how beaten-down over 6-12 months" never gets to dominate the short-term
    read. Call that rank R_long (1 = most beaten-down). Both are converted to a 0-1 percentile
    WITHIN THAT WEEK'S eligible names (1.0 = best/most-beaten-down) before combining, so neither
    group's raw rank range can swamp the other - percentiles are what actually fixes the
    original bug, not merely separating the sums.

    Final score = short_pct + `tilt` * long_pct, re-ranked (ascending score = better). `tilt=0`
    is plain short-only momentum (the control any tilt > 0 must beat); the handover's own
    "sort by short, prefer beaten-down as a second preference" reading is `screen_top_pct > 0`:
    only names in the top `screen_top_pct` share by short-term momentum are ranked at all (a
    hard qualifier), and the long-term tilt only orders WITHIN that qualifying group. 0 (default)
    skips the screen - every eligible name is ranked, ordered by the blended score.

    Pair with `fresh_52w_low_mask` as a `no_buy` gate: this function ranks a stock that just
    made a new 52-week low just as well as one that bottomed months ago and has started to
    recover - the falling-knife guard needs a separate mask, same reasoning as the reversal
    sleeve's own "not at a new 52-week low" turned condition in `reversal.py`.
    """
    short_lookbacks = tuple(lb for lb in config.lookbacks if lb not in long_lookbacks)
    kept_long = tuple(lb for lb in config.lookbacks if lb in long_lookbacks)
    if not short_lookbacks or not kept_long:
        raise ValueError("need at least one short and one long lookback")
    short_cfg = replace(config, lookbacks=short_lookbacks, weights=None, score="ranksum")
    long_cfg = replace(
        config,
        lookbacks=kept_long,
        weights=tuple(-1.0 for _ in kept_long),
        score="ranksum",
    )
    short_rank, _ = compute_ranks(prices, short_cfg)
    long_rank, _ = compute_ranks(prices, long_cfg)
    eligible = short_rank.notna() & long_rank.notna()

    def to_pct(ranks: pd.DataFrame) -> pd.DataFrame:
        n = ranks.notna().sum(axis=1).clip(lower=2) - 1
        return 1 - (ranks.sub(1).div(n, axis=0))

    short_pct, long_pct = to_pct(short_rank), to_pct(long_rank)
    combined = (short_pct + tilt * long_pct).where(eligible)
    if screen_top_pct > 0:
        cut = short_pct.where(eligible).quantile(1 - screen_top_pct, axis=1)
        combined = combined.where(short_pct.ge(cut, axis=0))
    return rerank(-combined), combined


def fresh_52w_low_mask(prices: pd.DataFrame, weeks: int = 52) -> pd.DataFrame:
    """Block a fresh buy of a name making a new `weeks`-week low this week - the falling-knife
    guard a beaten-down screen needs (see `grouped_momentum_ranks`)."""
    low = prices.rolling(weeks, min_periods=weeks).min()
    return prices.le(low).fillna(False)


# --- no_buy masks -------------------------------------------------------------------------------


def below_high52_mask(prices: pd.DataFrame, threshold: float = 0.85) -> pd.DataFrame:
    """Experiment 3a: block a fresh buy while the close is more than (1 - threshold) below its
    52-week high."""
    return (high52_proximity(prices) < threshold).fillna(False)


def choppy_mask(prices: pd.DataFrame, weeks: int = 26, min_up_share: float = 0.5) -> pd.DataFrame:
    """Experiment 4: path smoothness. Block a fresh buy when fewer than `min_up_share` of the last
    `weeks` weekly returns were positive - a gain made in a few jumps rather than many small
    steps (the "frog in the pan" idea, Da, Gurun and Warachka 2014, on weekly data)."""
    up = (prices.pct_change() > 0).astype(float).where(prices.pct_change().notna())
    share = up.rolling(weeks, min_periods=weeks).mean()
    return (share < min_up_share).fillna(False)


def trend_gate_mask(prices: pd.DataFrame, market: pd.Series, weeks: int = 40) -> pd.DataFrame:
    """Experiment 5a: block ALL fresh buys in weeks when `market` closes below its `weeks`-week
    average. Holdings are untouched (unlike the rejected per-instrument defensive filter)."""
    weak = market < market.rolling(weeks, min_periods=weeks).mean()
    weak = weak.reindex(prices.index).fillna(False)
    return pd.DataFrame(
        np.repeat(weak.to_numpy()[:, None], prices.shape[1], axis=1),
        index=prices.index,
        columns=prices.columns,
    )


def breadth_gate_mask(
    prices: pd.DataFrame, weeks: int = 40, min_share: float = 0.4
) -> pd.DataFrame:
    """Experiment 5b: block ALL fresh buys when fewer than `min_share` of the universe (names with
    a full `weeks` history) close above their own `weeks`-week average."""
    average = prices.rolling(weeks, min_periods=weeks).mean()
    above = (prices > average).where(average.notna())
    share = above.mean(axis=1)
    weak = (share < min_share).fillna(False)
    return pd.DataFrame(
        np.repeat(weak.to_numpy()[:, None], prices.shape[1], axis=1),
        index=prices.index,
        columns=prices.columns,
    )


def high_vol_mask(prices: pd.DataFrame, weeks: int = 26, quantile: float = 0.8) -> pd.DataFrame:
    """Experiment 8a: block a fresh buy of the most volatile names (trailing `weeks`-week weekly
    volatility above that week's cross-sectional `quantile`)."""
    vol = prices.pct_change().rolling(weeks, min_periods=weeks).std()
    cut = vol.quantile(quantile, axis=1)
    return vol.gt(cut, axis=0).fillna(False)


# --- Post-hoc overlays on a finished curve ------------------------------------------------------


@dataclass
class Curve:
    """The parts of a Result that window scoring reads, for overlays that rebuild the curve."""

    equity: pd.Series
    cash: pd.Series
    benchmark: pd.Series
    trades: pd.DataFrame
    exposure: pd.Series


def _overlay(result, exposure: pd.Series, cost_pct: float) -> Curve:
    """Hold `exposure` of the strategy and the rest in the liquid fund, week by week. Moving
    exposure costs `cost_pct` (per side, percent) on the strategy share traded; the liquid fund
    leg is free. Ignores tax on the extra sales - a known optimism, stated in TODO 3.9.23."""
    strat = result.equity.pct_change()
    cash = result.cash.reindex(result.equity.index).pct_change()
    exposure = exposure.reindex(result.equity.index).fillna(1.0).clip(0.0, 1.0)
    turnover = exposure.diff().abs().fillna(0.0)
    weekly = exposure * strat + (1 - exposure) * cash - turnover * cost_pct / 100
    equity = (1 + weekly.fillna(0.0)).cumprod()
    return Curve(
        equity=equity / equity.iloc[0],
        cash=result.cash,
        benchmark=result.benchmark,
        trades=result.trades,
        exposure=exposure,
    )


def vol_target(result, target: float, weeks: int = 26, cost_pct: float = 0.10) -> Curve:
    """Experiment 2: scale exposure to min(1, target / trailing realised volatility), using only
    returns up to the previous week. Never levers above 1."""
    strat = result.equity.pct_change()
    realised = strat.rolling(weeks, min_periods=weeks).std().shift(1) * math.sqrt(52)
    return _overlay(result, (target / realised).clip(upper=1.0), cost_pct)


def dispersion_timing(
    result,
    prices: pd.DataFrame,
    lookback: int = 13,
    history: int = 156,
    low_quantile: float = 0.2,
    low_exposure: float = 0.5,
    cost_pct: float = 0.10,
) -> Curve:
    """Experiment 8b: when the cross-sectional spread of `lookback`-week returns is in the bottom
    `low_quantile` of its own trailing `history` weeks (momentum has little to choose between),
    hold only `low_exposure` of the strategy. Decided on last week's data."""
    returns = prices / prices.shift(lookback) - 1
    spread = returns.std(axis=1)
    cut = spread.rolling(history, min_periods=52).quantile(low_quantile)
    low = (spread < cut).shift(1).fillna(False).astype(bool)
    exposure = pd.Series(np.where(low, low_exposure, 1.0), index=spread.index)
    return _overlay(result, exposure, cost_pct)
