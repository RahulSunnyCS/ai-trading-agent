"""BL-042 Phase 2b (owner, 2026-10-07): does the momentum rank fall while a base forms?

A base takes from a few weeks (a tight range) to over a year (a cup), and a stock that moves
sideways loses momentum rank. If the stocks with the best patterns sit outside the top of the
momentum ranking, the filter and bonus shapes (which only act on pattern stocks near the top)
can barely reach them. This report measures that. It reads ranks only, never a forward return.

An *episode* is one base: the detections of one pattern on one symbol that share a base start.
Its detection week is the first week it was seen (forming or near the pivot).
"""

from __future__ import annotations

import pandas as pd

TOPS = (10, 20, 40, 200)


def _rank_at(table: pd.DataFrame, symbol: str, day: pd.Timestamp) -> float:
    """The rank in the last ranked week on or before `day` (the week whose close it follows)."""
    if symbol not in table.columns:
        return float("nan")
    at = table.index.searchsorted(day, side="right") - 1
    return float(table[symbol].iat[at]) if at >= 0 else float("nan")


def episodes(detections: pd.DataFrame) -> pd.DataFrame:
    seen = detections[detections["state"].isin(["forming", "near_pivot"])]
    first = seen.sort_values("week").groupby(["pattern", "symbol", "base_start"], as_index=False)
    return first.first()[["pattern", "symbol", "base_start", "week", "state"]]


def momentum_during(
    detections: pd.DataFrame, global_ranks: pd.DataFrame, pool_ranks: pd.DataFrame
) -> pd.DataFrame:
    """One row per episode with its global and pool momentum rank at base start, at the base's
    midpoint and at the detection week, and the global rank as a percentile of all ranked names
    that week (0 = best)."""
    ranked_count = global_ranks.notna().sum(axis=1)
    rows = []
    for ep in episodes(detections).itertuples(index=False):
        start, detected = pd.Timestamp(ep.base_start), pd.Timestamp(ep.week)
        mid = start + (detected - start) / 2
        row = {"pattern": ep.pattern, "symbol": ep.symbol, "week": detected, "state": ep.state,
               "base_weeks": (detected - start).days / 7}  # fmt: skip
        for label, day in (("start", start), ("mid", mid), ("detected", detected)):
            g = _rank_at(global_ranks, ep.symbol, day)
            at = ranked_count.index.searchsorted(day, side="right") - 1
            n = ranked_count.iat[at] if at >= 0 else 0
            row[f"global_{label}"] = g
            row[f"global_pct_{label}"] = (g - 1) / (n - 1) if n > 1 else float("nan")
            row[f"pool_{label}"] = _rank_at(pool_ranks, ep.symbol, day)
        rows.append(row)
    return pd.DataFrame(rows)


def summary(table: pd.DataFrame) -> pd.DataFrame:
    """Per pattern: episode count, median base length, median global-rank percentile at start /
    mid / detection, and the share of episodes inside pool top N at detection."""
    out = []
    for pattern, part in table.groupby("pattern"):
        row = {
            "episodes": len(part),
            "median_base_weeks": part["base_weeks"].median(),
            "pct_rank_start": part["global_pct_start"].median(),
            "pct_rank_mid": part["global_pct_mid"].median(),
            "pct_rank_detected": part["global_pct_detected"].median(),
            "rank_fell_share": (part["global_detected"] > part["global_start"]).mean(),
            "in_pool": part["pool_detected"].notna().mean(),
        }
        for top in TOPS:
            row[f"pool_top{top}"] = (part["pool_detected"] <= top).mean()
        out.append(pd.Series(row, name=pattern))
    return pd.DataFrame(out)


def per_year(detections: pd.DataFrame) -> pd.DataFrame:
    frame = detections.assign(year=detections["week"].dt.year)
    return frame.groupby(["pattern", "year"]).size().unstack("year", fill_value=0)
