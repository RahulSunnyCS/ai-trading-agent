"""build_effective_stock_ranks fills arrays and builds its two frames once (BL-005 Phase 3). Pinned
against the cell-by-cell `.at` version it replaced, on random categories that overlap (a stock
tagged to two held categories keeps its better rank), atomics, missing ranks and lingering slots."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories import broad
from momentum_backtesting.categories.broad import ATOMIC_NAMES, category_picks

WEEKS = list(pd.date_range("2020-01-03", periods=30, freq="W-FRI"))
STOCKS = [f"S{i}" for i in range(24)]
CATEGORIES = [f"Cat{i}" for i in range(8)]


def reference(
    held_by_week, combined_pool_ranks, group_members, weeks, columns, *, top, exit_, picks
):
    """The loop exactly as it was: DataFrames filled one cell at a time with `.at`."""
    ranks = pd.DataFrame(index=weeks, columns=columns, dtype=float)
    groups = pd.DataFrame(index=weeks, columns=columns, dtype=object)
    top_n, exit_rank = top * picks, exit_ * picks
    for w in weeks:
        held = held_by_week.get(w, [])
        row = combined_pool_ranks.loc[w]
        for position, cid in enumerate(held, start=1):
            if position > exit_:
                break
            chosen = category_picks(cid, row, group_members, ATOMIC_NAMES, picks)
            base = 0 if position <= top else top_n
            bucket_pos = position if position <= top else position - top
            for slot, name in enumerate(chosen, start=1):
                if name not in ranks.columns:
                    continue
                if pd.notna(ranks.at[w, name]):
                    continue
                ranks.at[w, name] = base + (bucket_pos - 1) * picks + slot
                groups.at[w, name] = cid
    return ranks, groups, top_n, exit_rank


def random_inputs(seed: int):
    rng = np.random.default_rng(seed)
    names = [*STOCKS, *ATOMIC_NAMES]
    pool = pd.DataFrame(rng.integers(1, 40, (len(WEEKS), len(names))).astype(float), WEEKS, names)
    pool = pool.mask(rng.random(pool.shape) < 0.25)  # not every name is ranked every week
    members = {
        cid: {s for s in STOCKS if rng.random() < 0.3} for cid in CATEGORIES
    }  # overlapping categories
    held = {
        w: list(rng.permutation([*CATEGORIES, *ATOMIC_NAMES])[: int(rng.integers(0, 9))])
        for w in WEEKS
        if rng.random() < 0.9
    }
    # a column the ranking never offers, and a name no category knows, must both be tolerated
    columns = [*names[:-1], "EXTRA"]
    return held, pool, members, columns


@pytest.mark.parametrize("picks", [1, 2, 3])
@pytest.mark.parametrize("seed", range(12))
def test_effective_ranks_are_what_they_always_were(seed, picks):
    held, pool, members, columns = random_inputs(seed)
    new = broad.build_effective_stock_ranks(
        held,
        pool,
        members,
        WEEKS,
        columns,
        category_top_n=2,
        category_exit_rank=5,
        picks_per_category=picks,
    )
    ranks, groups, top_n, exit_rank = reference(
        held, pool, members, WEEKS, columns, top=2, exit_=5, picks=picks
    )
    pd.testing.assert_frame_equal(new.ranks, ranks)
    pd.testing.assert_frame_equal(new.groups, groups)
    pd.testing.assert_frame_equal(new.scores, -ranks)
    assert (new.top_n, new.exit_rank) == (top_n, exit_rank)


def test_the_random_inputs_exercise_real_assignments():
    held, pool, members, columns = random_inputs(3)
    out = broad.build_effective_stock_ranks(
        held, pool, members, WEEKS, columns, category_top_n=2, category_exit_rank=5
    )
    assert out.ranks.notna().sum().sum() > 80 and out.ranks.max().max() > 2
    assert out.groups.notna().sum().sum() == out.ranks.notna().sum().sum()
    assert str(out.ranks.dtypes.iloc[0]) == "float64" and str(out.groups.dtypes.iloc[0]) == "object"
