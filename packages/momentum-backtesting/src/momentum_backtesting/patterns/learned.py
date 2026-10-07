"""A score learned from how earlier setups of the same kind paid (bl042 addendum 2,
`learned_score`): the owner's "rank it by how it has done historically", done causally.

For a detection at week t, the score comes from EARLIER detections in the same cell (pattern x
state x quality third) whose `horizon`-week outcome had fully ended by t. Each outcome is the
detection's forward return minus the mean forward return of non-pattern pool stocks in the same
momentum decile that week, the same comparison the event study makes. Until a cell has
`min_past_cases` finished cases the score is neutral (0.5).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import criteria
from .study import forward_returns


def spec() -> dict:
    return criteria()["learned_score"]


def quality_cuts(graded: pd.DataFrame) -> dict[str, tuple[float, float]]:
    """pattern -> the two quality cut points (thirds) of its development detections."""
    out = {}
    for pattern, part in graded.groupby("pattern"):
        q = part["quality"].dropna()
        if len(q):
            out[pattern] = (float(q.quantile(1 / 3)), float(q.quantile(2 / 3)))
    return out


def _third(quality: pd.Series, cuts: tuple[float, float]) -> pd.Series:
    return pd.Series(
        np.where(quality <= cuts[0], "low", np.where(quality <= cuts[1], "mid", "high")),
        index=quality.index,
    )


def outcomes(
    graded: pd.DataFrame, prices: pd.DataFrame, pool_ranks: pd.DataFrame, column_of
) -> pd.DataFrame:
    """One row per detection that sat in the pool: its decile-matched excess return over the
    horizon, and the week that outcome became known. `column_of(symbol, week)` names the
    ranking column the symbol traded under that week (None if none)."""
    horizon = spec()["horizon_weeks"]
    fwd = forward_returns(prices, horizon)
    rows = []
    for pattern, part in graded.groupby("pattern"):
        for week, day in part.groupby("week"):
            if week not in fwd.index:
                continue
            rank = pool_ranks.loc[week]
            ret = fwd.loc[week]
            ok = rank.notna() & ret.notna()
            if not ok.any():
                continue
            decile = np.ceil(rank[ok] / rank[ok].max() * 10).clip(1, 10)
            hit_cols = {column_of(s, week) for s in day["symbol"]}
            controls = ret[ok][[c not in hit_cols for c in ret[ok].index]]
            control_mean = controls.groupby(decile.reindex(controls.index)).mean()
            for row in day.itertuples(index=False):
                col = column_of(row.symbol, week)
                if col is None or col not in decile.index or decile[col] not in control_mean:
                    continue
                rows.append(
                    {
                        "pattern": pattern,
                        "symbol": row.symbol,
                        "week": week,
                        "state": row.state,
                        "quality": row.quality,
                        "excess": float(ret[col] - control_mean[decile[col]]),
                        "known": week + pd.Timedelta(weeks=horizon),
                    }
                )
    return pd.DataFrame(
        rows, columns=["pattern", "symbol", "week", "state", "quality", "excess", "known"]
    )


def scores(
    graded: pd.DataFrame, past: pd.DataFrame, cuts: dict[str, tuple[float, float]]
) -> pd.Series:
    """Learned score for every row of `graded` (index aligned), from `past` outcomes only:
    those with `known` on or before the row's week."""
    rule = spec()
    out = pd.Series(0.5, index=graded.index, dtype=float)
    if past.empty:
        return out
    past = past.assign(third=pd.Series("", index=past.index, dtype=object))
    for pattern, cut in cuts.items():
        mask = past["pattern"] == pattern
        past.loc[mask, "third"] = _third(past.loc[mask, "quality"], cut)
    for (pattern, state, third), cell in past.groupby(["pattern", "state", "third"]):
        cell = cell.sort_values("known")
        known = cell["known"].to_numpy()
        csum = np.cumsum(cell["excess"].to_numpy())
        rows = graded[(graded["pattern"] == pattern) & (graded["state"] == state)]
        if rows.empty or pattern not in cuts:
            continue
        rows = rows[_third(rows["quality"], cuts[pattern]) == third]
        n = np.searchsorted(known, rows["week"].to_numpy(), side="right")
        mean = np.where(n > 0, csum[np.maximum(n - 1, 0)] / np.maximum(n, 1), np.nan)
        value = np.clip(0.5 + 0.5 * mean / rule["excess_for_full_score"], 0, 1)
        out.loc[rows.index] = np.where(n >= rule["min_past_cases"], value, 0.5)
    return out
