"""Residual momentum (BL-085 lever L6): momentum left after removing the market and sector move.

For each week t and stock, regress its weekly returns over the trailing 52 weeks (t-51..t, rows
up to t only) on [1, market, group]:

  market  Nifty 50 TRI's weekly return,
  group   the equal-weight weekly return of the stocks tagged to the stock's category (today's
          curated tags, the same hindsight the search already carries; a stock in several
          categories uses the first by name, an untagged one is regressed on the market only).

The score is the sum of the residuals over weeks t-29..t-4 (the last 26, skipping the latest 4)
divided by their standard deviation; higher is better. A stock without 52 complete weekly
returns has no score that week. Everything is a rolling sum, so the whole table is a few
vectorised passes and one batched 3x3 solve per (week, stock).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

WINDOW = 52
SCORE_WEEKS = 26
SKIP = 4
_RIDGE = 1e-10  # keeps an untagged stock's all-zero group column solvable (its beta becomes 0)


def group_returns(returns: pd.DataFrame, group_of: dict[str, str]) -> pd.DataFrame:
    """Weeks x columns: each column's group's equal-weight return (0 for an ungrouped column)."""
    out = pd.DataFrame(0.0, index=returns.index, columns=returns.columns)
    members: dict[str, list[str]] = {}
    for col, group in group_of.items():
        if col in returns.columns:
            members.setdefault(group, []).append(col)
    for cols in members.values():
        mean = returns[cols].mean(axis=1, skipna=True).fillna(0.0)
        for col in cols:
            out[col] = mean
    return out


def residual_scores(
    prices: pd.DataFrame, market: pd.Series, group_of: dict[str, str], *, standardise: bool = True
) -> pd.DataFrame:
    """Weeks x columns residual-momentum score (NaN where the history is too short).
    `standardise=False` returns the plain sum of the residuals (BL-050's M2)."""
    y = prices.pct_change()
    m = market.reindex(prices.index).ffill().pct_change()
    g = group_returns(y, group_of)
    valid = y.notna() & m.notna().to_numpy()[:, None]
    y0 = y.where(valid, 0.0)
    mm = pd.DataFrame(
        np.repeat(m.fillna(0.0).to_numpy()[:, None], y.shape[1], axis=1),
        index=y.index,
        columns=y.columns,
    ).where(valid, 0.0)
    gg = g.where(valid, 0.0)
    one = valid.astype(float)

    def roll(frame: pd.DataFrame, n: int) -> np.ndarray:
        return frame.rolling(n, min_periods=1).sum().to_numpy()

    n_obs = roll(one, WINDOW)
    s = {
        "1": n_obs,
        "m": roll(mm, WINDOW),
        "g": roll(gg, WINDOW),
        "mm": roll(mm * mm, WINDOW),
        "mg": roll(mm * gg, WINDOW),
        "gg": roll(gg * gg, WINDOW),
        "y": roll(y0, WINDOW),
        "my": roll(mm * y0, WINDOW),
        "gy": roll(gg * y0, WINDOW),
    }
    xtx = np.stack(
        [
            np.stack([s["1"], s["m"], s["g"]], axis=-1),
            np.stack([s["m"], s["mm"], s["mg"]], axis=-1),
            np.stack([s["g"], s["mg"], s["gg"]], axis=-1),
        ],
        axis=-2,
    )  # T x N x 3 x 3
    xtx = xtx + np.eye(3) * _RIDGE * np.maximum(n_obs, 1)[..., None, None]
    xty = np.stack([s["y"], s["my"], s["gy"]], axis=-1)[..., None]
    full = n_obs >= WINDOW
    beta = np.full(xty.shape[:-1], np.nan)
    if full.any():
        beta[full] = np.linalg.solve(xtx[full], xty[full])[..., 0]
    a, b, c = beta[..., 0], beta[..., 1], beta[..., 2]

    def late(frame: pd.DataFrame) -> np.ndarray:
        """Sums over t-29..t-4: a 26-week rolling sum shifted by the 4 skipped weeks."""
        return frame.rolling(SCORE_WEEKS, min_periods=SCORE_WEEKS).sum().shift(SKIP).to_numpy()

    n2 = late(one)
    sy, sm, sg = late(y0), late(mm), late(gg)
    syy, smm, sgg = late(y0 * y0), late(mm * mm), late(gg * gg)
    smy, sgy, smg = late(mm * y0), late(gg * y0), late(mm * gg)
    sum_e = sy - a * n2 - b * sm - c * sg
    sum_e2 = (
        syy
        + a * a * n2
        + b * b * smm
        + c * c * sgg
        - 2 * a * sy
        - 2 * b * smy
        - 2 * c * sgy
        + 2 * a * b * sm
        + 2 * a * c * sg
        + 2 * b * c * smg
    )
    var = (sum_e2 - sum_e * sum_e / SCORE_WEEKS) / (SCORE_WEEKS - 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        score = sum_e / np.sqrt(np.where(var > 0, var, np.nan)) if standardise else sum_e
    score = np.where(full & (n2 >= SCORE_WEEKS), score, np.nan)
    return pd.DataFrame(score, index=prices.index, columns=prices.columns)


def residual_ranks(
    prices: pd.DataFrame, market: pd.Series, group_of: dict[str, str]
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(rank, score) like engine.compute_ranks: rank 1 = best, NaN = not ranked that week."""
    from ..engine import _rank_from_score  # noqa: PLC0415 (engine imports categories lazily)

    scores = residual_scores(prices, market, group_of)
    return _rank_from_score(scores, None, higher_is_better=True), scores
