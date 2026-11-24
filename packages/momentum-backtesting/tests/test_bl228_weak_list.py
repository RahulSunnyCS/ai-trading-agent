"""BL-228: the weak list reads closes up to its own week only and keeps down-trending F&O names."""

import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load():
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("bl228_fno_puts", SCRIPTS / "bl228_fno_puts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _frame(seed=1, weeks=80, cols=12):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2020-01-03", periods=weeks, freq="W-FRI")
    names = [f"S{i:02d}" for i in range(cols)]
    drift = np.linspace(-0.01, 0.01, cols)  # S00 falls steadily, S11 rises
    steps = drift + rng.normal(0, 0.01, size=(weeks, cols))
    prices = pd.DataFrame(100 * np.exp(np.cumsum(steps, axis=0)), index=idx, columns=names)
    member = pd.DataFrame(True, index=idx, columns=names)
    return prices, member


def test_future_prices_do_not_move_earlier_lists():
    m = _load()
    prices, member = _frame()
    before = m.weak_list(prices, member, {}, 3)
    shocked = prices.copy()
    shocked.iloc[60:] *= np.linspace(0.2, 5, shocked.shape[1])  # rewrite the future
    after = m.weak_list(shocked, member, {}, 3)
    for w in prices.index[:60]:
        assert before[w] == after[w]
    assert any(before[w] != after[w] for w in prices.index[60:])


def test_only_members_with_their_own_trend_down():
    m = _load()
    prices, member = _frame()
    member["S00"] = False  # the steadiest faller is off the F&O list
    lists = m.weak_list(prices, member, {}, 3)
    week = prices.index[-1]
    assert "S00" not in lists[week]
    for s in lists[week]:
        p = prices[s]
        assert p.iloc[-1] / p.iloc[-27] - 1 < 0 and p.iloc[-1] < p.iloc[-40:].mean()
    assert all(v == [] for v in list(lists.values())[:52])  # no 52-week history yet
    # a segment column maps to its base name, once
    seg = prices.rename(columns={"S01": "S02#2"})
    seg_member = member.rename(columns={"S01": "S02#2"})
    lists = m.weak_list(seg, seg_member, {"S02#2": "S02"}, 3)
    assert all(len(v) == len(set(v)) and "S02#2" not in v for v in lists.values())


def test_mirror_pool_tilts_with_the_market_and_reads_no_future():
    m = _load()
    prices, member = _frame()
    falling = prices * np.exp(-0.02 * np.arange(len(prices)))[:, None]  # every stock falls
    lists = m.mirror_list(falling, member, {}, 4)
    late = [s for w in falling.index[55:] for s in lists[w]]
    assert late and all(s.endswith("|PE") for s in late)
    rising = prices * np.exp(0.02 * np.arange(len(prices)))[:, None]
    late = [s for w in rising.index[55:] for s in m.mirror_list(rising, member, {}, 4)[w]]
    assert late and all(s.endswith("|CE") for s in late)
    for v in m.mirror_list(prices, member, {}, 6).values():
        assert len({s.split("|")[0] for s in v}) == len(v)  # never a stock and its inverse
    shocked = prices.copy()
    shocked.iloc[60:] *= np.linspace(0.2, 5, shocked.shape[1])
    a, b = m.mirror_list(prices, member, {}, 4), m.mirror_list(shocked, member, {}, 4)
    assert all(a[w] == b[w] for w in prices.index[:60])
