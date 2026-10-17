"""BL-116: the sector score reads nothing after the decision week (look-ahead check)."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bl116_sector_tests.py"


@pytest.fixture(scope="module")
def bl116():
    spec = importlib.util.spec_from_file_location("bl116", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _universe(seed=3):
    rng = np.random.default_rng(seed)
    weeks = pd.date_range("2016-01-01", periods=160, freq="W-FRI")
    cols = ["AAA", "BBB", "CCC", "CCC#2", "DDD"]
    prices = pd.DataFrame(
        100 * np.exp(np.cumsum(rng.normal(0.003, 0.04, (len(weeks), len(cols))), axis=0)),
        index=weeks,
        columns=cols,
    )
    membership = pd.DataFrame(True, index=weeks, columns=cols)
    membership["CCC"] = weeks < weeks[100]  # the old segment stops, the new one takes over
    membership["CCC#2"] = weeks >= weeks[100]
    base = {"AAA": ["AAA"], "BBB": ["BBB"], "CCC": ["CCC", "CCC#2"], "DDD": ["DDD"]}
    return prices, membership, base


def test_the_sector_score_ignores_everything_after_the_decision_week(bl116):
    prices, membership, base = _universe()
    members = {"AAA", "BBB", "CCC", "DDD"}
    for d in prices.index[60:150:13]:
        full = bl116.sector_score(prices, membership, base, members, d, [13, 26, 52])
        later = prices.copy()
        later[later.index > d] *= 5.0
        moved = bl116.sector_score(later, membership, base, members, d, [13, 26, 52])
        cut = bl116.sector_score(prices.loc[:d], membership.loc[:d], base, members, d, [13, 26, 52])
        assert full[0] == pytest.approx(moved[0]) == pytest.approx(cut[0])
        assert full[1] == moved[1] == cut[1] == 4


def test_the_sector_score_is_the_mean_of_its_live_members_and_needs_three(bl116):
    prices, membership, base = _universe()
    d = prices.index[120]
    want = np.mean([bl116.stock_score(prices[c], d, [4, 13]) for c in ["AAA", "BBB", "CCC#2"]])
    got, n = bl116.sector_score(prices, membership, base, {"AAA", "BBB", "CCC"}, d, [4, 13])
    assert n == 3 and got == pytest.approx(want)
    missing, n = bl116.sector_score(prices, membership, base, {"AAA", "BBB"}, d, [4, 13])
    assert n == 2 and np.isnan(missing)
