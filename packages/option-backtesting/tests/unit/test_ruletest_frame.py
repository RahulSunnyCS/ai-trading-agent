"""The cached ATM-straddle feature of the rule tester (BL-120, `ruletest/frame.py`): only what is
known for good is saved, so a failed read or a day collected later is built on the next run."""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest
from trading_data import lake

from option_backtesting.ruletest import expr as E
from option_backtesting.ruletest import frame as F
from option_backtesting.ruletest import store

DAYS = ["2026-01-05", "2026-01-06"]


def _frame() -> E.Frame:
    close = np.full((len(DAYS), E.N_BARS), 23000.0)
    return E.Frame(
        days=list(DAYS),
        O=close.copy(),
        H=close + 1,
        L=close - 1,
        C=close,
        vix_close=np.full_like(close, 14.0),
        vix_open=np.full(len(DAYS), 14.0),
    )


def _collect(root, day: str) -> None:
    """An option file for the day (its contents are never read: straddle_series is faked)."""
    path = lake.bars_1m_path(root, "option", "NIFTY", date.fromisoformat(day))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


@pytest.fixture
def series(monkeypatch):
    """straddle_series stand-in: a constant premium per day, or an error for days in `failing`."""
    state = {"failing": set(), "calls": []}

    def fake(root, underlying, day, spot):
        state["calls"].append(day.isoformat())
        if day.isoformat() in state["failing"]:
            raise OSError("the volume went away")
        return np.full(E.N_BARS, 100.0 + day.day), day

    monkeypatch.setattr(F.T, "straddle_series", fake)
    return state


def test_a_failed_read_is_not_saved_and_is_built_next_time(tmp_path, series):
    for d in DAYS:
        _collect(tmp_path, d)
    series["failing"] = {"2026-01-06"}
    first = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert first[0, 0] == 105.0 and np.isnan(first[1]).all()

    series["failing"] = set()
    series["calls"].clear()
    again = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert again[1, 0] == 106.0
    assert series["calls"] == ["2026-01-06"]  # the saved day is read from the cache


def test_a_day_collected_later_is_picked_up(tmp_path, series):
    _collect(tmp_path, "2026-01-05")
    first = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert np.isnan(first[1]).all()  # no option file yet: blank, and not saved

    _collect(tmp_path, "2026-01-06")
    again = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert again[1, 0] == 106.0


def test_a_day_without_the_strike_is_saved_blank(tmp_path, series, monkeypatch):
    """An option file that lacks the ATM strike's bars is a fact about the day: saved, not re-read."""
    for d in DAYS:
        _collect(tmp_path, d)
    monkeypatch.setattr(F.T, "straddle_series", lambda *a: series["calls"].append(a[2].isoformat()))
    F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    series["calls"].clear()
    out = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert np.isnan(out).all() and series["calls"] == []


def test_blank_days_in_an_old_cache_file_are_built_once_more(tmp_path, series):
    for d in DAYS:
        _collect(tmp_path, d)
    path = store.features_dir(tmp_path) / "straddle_NIFTY_5.npz"
    path.parent.mkdir(parents=True)
    old = np.array([np.full(E.N_BARS, 1.0), np.full(E.N_BARS, np.nan)])
    np.savez_compressed(path, days=np.array(DAYS), data=old)  # no version: the first format

    out = F.StraddleLoader(tmp_path, "NIFTY", _frame())(5)
    assert out[0, 0] == 1.0  # a built row is kept as it is
    assert out[1, 0] == 106.0  # the blank one was built again
    assert series["calls"] == ["2026-01-06"]
    with np.load(path) as z:
        assert int(z["version"]) == F.FEATURE_VERSION
