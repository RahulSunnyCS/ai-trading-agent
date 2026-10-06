"""categories.prices._forward_filled (BL-005 Phase 3): the same fill as the per-column loop it
replaced, without leaving the frame in hundreds of internal blocks."""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories.prices import _forward_filled

WEEKS = pd.date_range("2020-01-03", periods=60, freq="W-FRI")


def gappy_frame(columns: int, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    data = rng.normal(100, 5, (len(WEEKS), columns))
    data[rng.random(data.shape) < 0.15] = np.nan  # holes in the middle
    for j in range(0, columns, 3):  # every third column stops early
        data[int(rng.integers(20, 55)) :, j] = np.nan
    return pd.DataFrame(data, WEEKS, [f"C{j}" for j in range(columns)])


def loop_version(frame: pd.DataFrame, columns) -> pd.DataFrame:
    out = frame.copy()
    for col in columns:
        out[col] = out[col].ffill()
    return out


@pytest.mark.parametrize("seed", range(5))
def test_it_fills_exactly_what_the_column_loop_filled(seed):
    frame = gappy_frame(40, seed)
    rng = np.random.default_rng(seed)
    chosen = {c for c in frame.columns if rng.random() < 0.5}
    new = _forward_filled(frame, chosen)
    old = loop_version(frame, chosen)
    pd.testing.assert_frame_equal(new, old)
    assert list(new.columns) == list(frame.columns)  # same order
    untouched = [c for c in frame.columns if c not in chosen]
    pd.testing.assert_frame_equal(new[untouched], frame[untouched])  # the others keep their holes


def test_it_leaves_the_frame_alone_when_there_is_nothing_to_fill():
    frame = gappy_frame(5)
    assert _forward_filled(frame, set()) is frame
    assert _forward_filled(frame, {"not-a-column"}) is frame


def test_the_result_can_take_new_columns_without_the_fragmentation_warning():
    frame = gappy_frame(400)
    everything = set(frame.columns)
    looped = loop_version(frame, everything)
    filled = _forward_filled(frame, everything)
    assert filled._mgr.nblocks < 10 <= looped._mgr.nblocks  # the loop split it into hundreds
    with warnings.catch_warnings():
        warnings.simplefilter("error", pd.errors.PerformanceWarning)
        for i in range(5):
            filled[f"new{i}"] = 1.0  # what Broad does next (cash, benchmark)
        with pytest.raises(pd.errors.PerformanceWarning):
            for i in range(5):
                looped[f"new{i}"] = 1.0
