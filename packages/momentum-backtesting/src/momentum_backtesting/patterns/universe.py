"""The Broad Momentum ranking BL-042 measures against (bl042_criteria.json `universe` and
`phase_5_ranking_test.baseline`), and per-symbol views of its rank tables.

The ranking is built from the whole price history, as every Broad run is; its ranks only look
back (`tests/golden/test_lookahead.py`), and callers before Phase 6 keep only weeks up to the
end of the development window (`through`).
"""

from __future__ import annotations

from functools import cache

import pandas as pd

from . import criteria


@cache
def broad_ranking():
    """broad.UniverseRanking for the pre-registered universe and baseline ranking settings."""
    from .. import api
    from ..categories import broad
    from ..categories.liquidity import LiquidityConfig

    spec = criteria()
    universe, base = spec["universe"], spec["phase_5_ranking_test"]["baseline"]
    liq = universe["liquidity"]
    built = broad.compute_universe_base(
        outer_prices=api.DATA.get(),
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
        lookbacks=tuple(base["lookbacks"]),
        weights=base["weights"],
        score=base["score"],
        voladj_skip_recent_month=base["voladj_skip_recent_month"],
        liquidity=LiquidityConfig(
            min_turnover_cr=liq["min_turnover_cr"],
            floor_ratio=liq["floor_ratio"],
            min_price=liq["min_price"],
            circuit=liq["circuit"],
            circuit_run=liq["circuit_run"],
        ),
        universe_kind=universe["universe_kind"],
        series_breaks=universe["series_break_policy"],
    )
    return broad.finish_universe_ranking(
        built, pool_top_n=base["pool_top_n"], pool_exit_rank=base["pool_exit_rank"]
    )


def by_symbol(ranks: pd.DataFrame, column_to_base_symbol: dict[str, str]) -> pd.DataFrame:
    """week x column ranks -> week x symbol (a split symbol's `#N` segments never overlap, so the
    best rank across them is the live one). Columns with no base symbol (Gold, Silver, ...)
    are dropped."""
    stocks = [c for c in ranks.columns if c in column_to_base_symbol]
    grouped = ranks[stocks].T.groupby(lambda c: column_to_base_symbol[c]).min().T
    return grouped.sort_index()


def rank_tables(through: str | pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(global momentum rank, pool rank) as week x symbol, weeks up to `through` only."""
    ranking = broad_ranking()
    mapping = ranking.column_to_base_symbol
    cut = pd.Timestamp(through)
    global_ranks = by_symbol(ranking.global_ranks, mapping)
    pool_ranks = by_symbol(ranking.stock_pool_ranks, mapping)
    return global_ranks.loc[:cut], pool_ranks.loc[:cut]
