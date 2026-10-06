"""circuit_exposure._runs classifies every bar at once (BL-005 Phase 3). It must find exactly the
runs the per-bar loop it replaced found, on random bars built to hit every edge: moves on and just
outside each band edge, both directions, back-to-back runs of opposite sign, gaps, missing moves."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories import circuit_exposure as ce

BANDS = ((0.019, 0.0205), (0.049, 0.0505), (0.099, 0.1005), (0.199, 0.2005))
LABELS = (0.02, 0.05, 0.10, 0.20)


def _band_of(abs_move: float):
    for (lo, hi), label in zip(BANDS, LABELS, strict=True):
        if lo <= abs_move <= hi:
            return label
    return None


def _summarise(run):
    cumulative = 1.0
    for _, _, move, _ in run:
        cumulative *= 1 + move
    return {
        "start": run[0][0],
        "end": run[-1][0],
        "days": len(run),
        "direction": "UC" if run[0][1] > 0 else "LC",
        "band": max(b for _, _, _, b in run),
        "move": cumulative - 1,
    }


def reference_runs(bars: pd.DataFrame) -> list[dict]:
    """`_runs` exactly as it was: one Python iteration per bar."""
    out: list[dict] = []
    current: list = []
    prev_sign = 0
    for row in bars.itertuples():
        move = float(row.move)
        band = _band_of(abs(move))
        sign = 0 if band is None else (1 if move > 0 else -1)
        if sign != 0 and sign == prev_sign:
            current.append((row.date, sign, move, band))
        else:
            if current:
                out.append(_summarise(current))
            current = [(row.date, sign, move, band)] if sign != 0 else []
        prev_sign = sign
    if current:
        out.append(_summarise(current))
    return out


def random_bars(seed: int, n: int = 400) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    edges = [0.019, 0.02, 0.0205, 0.0206, 0.049, 0.05, 0.0505, 0.0506, 0.099, 0.1, 0.1005, 0.2]
    choice = rng.random(n)
    moves = np.where(
        choice < 0.30,
        rng.choice(edges, n) * rng.choice([-1, 1], n),  # on or around a band edge
        rng.normal(0, 0.015, n),  # an ordinary day
    )
    moves = np.where(rng.random(n) < 0.04, np.nan, moves)  # a session with no previous close
    moves = np.where(rng.random(n) < 0.03, 0.0, moves)
    return pd.DataFrame({"date": pd.bdate_range("2021-01-04", periods=n), "move": moves})


@pytest.mark.parametrize("seed", range(40))
def test_runs_match_the_per_bar_loop_on_random_bars(seed):
    bars = random_bars(seed)
    new, old = ce._runs(bars), reference_runs(bars)
    assert new == old
    assert [type(r["start"]) for r in new] == [type(r["start"]) for r in old]
    # the same rows after the callers' own preparation (windowing, dropping missing moves)
    window = bars.iloc[50:300].dropna(subset=["move"]).reset_index(drop=True)
    assert ce._runs(window) == reference_runs(window)


def test_enough_of_the_random_bars_are_runs_to_mean_something():
    total = sum(len(reference_runs(random_bars(seed))) for seed in range(40))
    long_runs = sum(
        1 for seed in range(40) for r in reference_runs(random_bars(seed)) if r["days"] >= 3
    )
    assert total > 400 and long_runs > 20


@pytest.mark.parametrize("seed", range(10))
def test_a_date_slice_is_the_rows_the_comparison_selected(seed):
    rng = np.random.default_rng(seed)
    bars = random_bars(seed, n=120)
    dates = bars["date"]
    picks = [dates.iloc[int(i)] for i in rng.integers(0, len(bars), 6)]
    picks += [dates.iloc[0] - pd.Timedelta(days=9), dates.iloc[-1] + pd.Timedelta(days=9)]
    for start in [*picks, None]:
        for end in [*picks, None]:
            old = bars
            if start is not None:
                old = old[old["date"] >= start]
            if end is not None:
                old = old[old["date"] <= end]
            pd.testing.assert_frame_equal(ce._between(bars, start, end), old)
    scrambled = bars.sample(frac=1, random_state=seed)  # not sorted: the comparison is used
    pd.testing.assert_frame_equal(
        ce._between(scrambled, picks[0], picks[1]),
        scrambled[(scrambled["date"] >= picks[0]) & (scrambled["date"] <= picks[1])],
    )


def test_empty_and_edgeless_bars_have_no_runs():
    empty = pd.DataFrame({"date": pd.DatetimeIndex([]), "move": []})
    assert ce._runs(empty) == reference_runs(empty) == []
    calm = pd.DataFrame({"date": pd.bdate_range("2021-01-04", periods=5), "move": [0.01] * 5})
    assert ce._runs(calm) == reference_runs(calm) == []
