"""BL-042 Phase 5: the three ways a pattern can re-rank the Broad pool (bl042_criteria.json
`phase_5_ranking_test.shapes`), and a backtest on the result.

Every shape works on `UniverseRanking.stock_pool_ranks` (week x column, dense pool rank 1..N,
NaN outside the pool) and a pattern score table on the same axes (0..1; >= 0.5 is a
detection). It returns a new dense rank table over exactly the same pool names, which replaces
`stock_pool_ranks` for a `category_mode="off"` Broad run. The engine itself is unchanged.
"""

from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd

from . import criteria

DETECTED = 0.5


def _dense(key: pd.DataFrame, pool: pd.DataFrame) -> pd.DataFrame:
    """Rank `key` ascending per week (1 = best) over the pool names only; ties cannot happen
    because every key carries the pool rank as its last component."""
    return key.where(pool.notna()).rank(axis=1, method="first")


def blend(pool: pd.DataFrame, score: pd.DataFrame, weight: float) -> pd.DataFrame:
    """(1 - w) x momentum percentile + w x pattern score, best first; ties by pool rank."""
    size = pool.max(axis=1)
    pct = 1 - (pool.sub(1)).div((size - 1).where(size > 1), axis=0)
    mixed = (1 - weight) * pct.fillna(1.0) + weight * score.fillna(0.0)
    return _dense(-mixed + pool * 1e-9, pool)


def filter_top(pool: pd.DataFrame, score: pd.DataFrame, top_n: int) -> pd.DataFrame:
    """Detected names with pool rank <= top_n first (in momentum order), then everyone else."""
    first = (score.fillna(0.0) >= DETECTED) & (pool <= top_n)
    return _dense(pool + (~first) * 1e6, pool)


def bonus(pool: pd.DataFrame, score: pd.DataFrame, ranks: int) -> pd.DataFrame:
    """Detected names move up `ranks` places; ties by pool rank."""
    detected = score.fillna(0.0) >= DETECTED
    return _dense(pool - detected * ranks + pool * 1e-6, pool)


def variants() -> list[tuple[str, str, float]]:
    """(name, shape, parameter) for the pre-registered 7 shapes."""
    shapes = criteria()["phase_5_ranking_test"]["shapes"]
    out = [(f"blend_{w}", "blend", w) for w in shapes["blend"]["weights"]]
    out += [(f"filter_{n}", "filter", n) for n in shapes["filter"]["top_n"]]
    out += [(f"bonus_{b}", "bonus", b) for b in shapes["bonus"]["ranks"]]
    return out


def apply(
    shape: str,
    pool: pd.DataFrame,
    score: pd.DataFrame,
    value: float,
    *,
    blend: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """`score` is the state score (>= 0.5 = detected) the filter and bonus read; the blend
    reads `blend` (state score x quality, addendum 1) when given, else `score`."""
    if shape == "blend":
        return globals()["blend"](pool, score if blend is None else blend, value)
    if shape == "filter":
        return filter_top(pool, score, int(value))
    if shape == "bonus":
        return bonus(pool, score, int(value))
    raise ValueError(shape)


def column_scores(score_by_symbol: pd.DataFrame, ranking) -> pd.DataFrame:
    """week x symbol score -> week x column on the ranking's own columns (a split symbol's
    segments share its score; only the live one is ever in the pool)."""
    cols = list(ranking.stock_pool_ranks.columns)
    symbols = [ranking.column_to_base_symbol.get(c) for c in cols]
    table = score_by_symbol.reindex(index=ranking.stock_pool_ranks.index)
    data = (
        np.column_stack(
            [table[s].to_numpy() if s in table.columns else np.zeros(len(table)) for s in symbols]
        )
        if cols
        else np.empty((len(table), 0))
    )
    return pd.DataFrame(data, index=table.index, columns=cols).fillna(0.0)


def backtest(ranking, pool_ranks: pd.DataFrame | None, *, start: str, end: str, locks=None):
    """One Broad run with the pre-registered baseline settings; `pool_ranks` None = baseline."""
    from .. import api
    from ..categories import broad

    base = criteria()["phase_5_ranking_test"]["baseline"]
    used = (
        ranking if pool_ranks is None else dataclasses.replace(ranking, stock_pool_ranks=pool_ranks)
    )
    uc, lc = locks if locks is not None else (None, None)
    return broad.run_broad_backtest(
        outer_prices=api.DATA.get(),
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
        curated_dir=api.CATEGORIES_CURATED_DIR,
        category_mode=base["category_mode"],
        start=start,
        end=end,
        lookbacks=tuple(base["lookbacks"]),
        weights=base["weights"],
        score=base["score"],
        voladj_skip_recent_month=base["voladj_skip_recent_month"],
        pool_top_n=base["pool_top_n"],
        pool_exit_rank=base["pool_exit_rank"],
        off_top_n=base["off_top_n"],
        off_exit_rank=base["off_exit_rank"],
        rebalance=base["rebalance"],
        rebalance_every=base["rebalance_every"],
        signal_delay=base["signal_delay"],
        cost_model=base["cost_model"],
        slippage_bps=base["slippage_bps"],
        capital=base["capital"],
        max_position=base["max_position"],
        max_stock_price=base["max_stock_price"],
        min_ranked=base["min_ranked"],
        entry=base["entry"],
        ranking=used,
        uc_locked=uc,
        lc_locked=lc,
    )
