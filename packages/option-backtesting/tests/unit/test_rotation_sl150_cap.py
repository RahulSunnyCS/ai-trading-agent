"""BL-192, the SL150% cap: on a day NIFTY does not expire, Adaptive holds at most one `N_wide-t1s4`,
from Fri 2026-10-30 (`rotation/sl150_cap.py`).

The cap must be a FILTER of the ranking (the composite never recomputed), applied identically by the
09:16 pick (`pick.score_history`), its next-best line (`pick.next_best`) and the morning rule
(`morning.choose` / `_reproduces`), and must leave every day before the start, every NIFTY expiry
day and every day with fewer than two copies exactly as it was.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pytest

from option_backtesting.rotation import morning, pick, sl150_cap
from option_backtesting.rotation.algtst_export import DayPicks
from option_backtesting.rotation.score import select

BEFORE = date(2026, 10, 29)
FIRST = date(2026, 10, 30)

NAMES = [
    "S_ditm1-t1s44_0917",  # dir, 09:17
    "N_wide-t1s4_1017",  # the setting
    "N_wide-t1s4_1032",  # the setting
    "N_wide-t1s4_1347",  # the setting
    "N_wide_1032",  # wide
    "N_p100_1032",  # wide
    "N_ditm1_0932",  # dir
    "N_buy_1117",  # buy
]
SCORES = {
    "S_ditm1-t1s44_0917": 9.0,
    "N_wide-t1s4_1017": 8.0,
    "N_wide-t1s4_1032": 7.0,
    "N_wide_1032": 6.0,
    "N_p100_1032": 5.0,
    "N_wide-t1s4_1347": 4.0,
    "N_ditm1_0932": 3.0,
    "N_buy_1117": 8.5,
}


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    """The switch is read at call time: no test inherits one from the shell."""
    monkeypatch.delenv(sl150_cap.ENV, raising=False)


def comp(scores: dict[str, float] = SCORES) -> np.ndarray:
    return np.array([scores.get(n, 0.0) for n in NAMES])


# --- when it applies ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "dte_n", "want"),
    [
        (FIRST, "2", True),
        (FIRST, "0", False),  # NIFTY expires: two copies stay allowed
        (BEFORE, "2", False),  # before the start: as recorded
        (date(2026, 11, 2), "1", True),
        (FIRST, "unknown", True),  # not shown to expire
    ],
)
def test_applies(day, dte_n, want):
    assert sl150_cap.applies(day, dte_n) is want


def test_switch_moves_or_disables_and_rejects_a_typo(monkeypatch):
    monkeypatch.setenv(sl150_cap.ENV, "off")
    assert not sl150_cap.applies(FIRST, "2")
    monkeypatch.setenv(sl150_cap.ENV, "2026-11-02")
    assert not sl150_cap.applies(FIRST, "2")
    assert sl150_cap.applies(date(2026, 11, 2), "2")
    monkeypatch.setenv(sl150_cap.ENV, "tomorrow")
    with pytest.raises(sl150_cap.CapError):
        sl150_cap.effective_from()


# --- the filter --------------------------------------------------------------------------------


def test_two_copies_keep_the_best_and_the_next_best_takes_the_slot():
    c = comp()
    picks = select(c, NAMES)
    assert picks.core == ["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide-t1s4_1032"]
    capped = sl150_cap.cap_picks(c, NAMES, picks)
    assert capped.core == ["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide_1032"]
    assert capped.buy == picks.buy  # the add-on is never touched
    assert capped.composite["N_wide_1032"] == 6.0  # the composite is the unrestricted one


def test_one_copy_is_left_alone():
    scores = {**SCORES, "N_wide-t1s4_1032": 1.0}
    c = comp(scores)
    picks = select(c, NAMES)
    assert sum(n.startswith(sl150_cap.SETTING) for n in picks.core) == 1
    assert sl150_cap.cap_picks(c, NAMES, picks) is picks


def test_three_copies_leave_one():
    scores = {**SCORES, "N_wide-t1s4_1347": 8.8, "S_ditm1-t1s44_0917": 0.5}
    c = comp(scores)
    picks = select(c, NAMES)
    assert sum(n.startswith(sl150_cap.SETTING) for n in picks.core) == 3
    capped = sl150_cap.cap_picks(c, NAMES, picks)
    assert [n for n in capped.core if n.startswith(sl150_cap.SETTING)] == ["N_wide-t1s4_1347"]


def test_runners_up_never_name_a_capped_out_copy():
    c = comp()
    picks = select(c, NAMES)
    capped = sl150_cap.cap_picks(c, NAMES, picks)
    nxt = sl150_cap.capped_runners_up(c, NAMES, picks, capped)
    assert nxt["wide"] == "N_p100_1032"


# --- the 09:16 pick ----------------------------------------------------------------------------


class _Hist:
    cols = NAMES


def _rank_stub(c):
    def fake(hist, day, vix_open, dte):
        for key in ("A", "C"):
            yield key, NAMES, c, select(c, NAMES)

    return fake


def test_score_history_caps_list_c_only_from_the_start(monkeypatch):
    monkeypatch.setattr(pick, "_rank", _rank_stub(comp()))
    dte = {"dte_n": "2", "dte_s": "4"}
    on = pick.score_history(_Hist(), FIRST, 15.1, dte)
    assert on["C"]["core"] == ["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide_1032"]
    assert on["C"]["sl150_capped"]["core"][2] == "N_wide-t1s4_1032"
    assert "sl150_capped" not in on["A"]  # only the rule lists
    before = pick.score_history(_Hist(), BEFORE, 15.1, dte)
    assert before["C"]["core"][2] == "N_wide-t1s4_1032" and "sl150_capped" not in before["C"]
    expiry_day = pick.score_history(_Hist(), FIRST, 15.1, {"dte_n": "0", "dte_s": "2"})
    assert "sl150_capped" not in expiry_day["C"]


def test_next_best_follows_the_cap(monkeypatch):
    monkeypatch.setattr(pick, "_rank", _rank_stub(comp()))
    out = pick.next_best(_Hist(), FIRST, 15.1, {"dte_n": "2", "dte_s": "4"})
    assert out["C"]["wide"] == "N_p100_1032"


# --- the morning rule --------------------------------------------------------------------------


def _picks(core, source="recorded"):
    return DayPicks(FIRST, "t1", source, list(core), [])


def test_morning_rule_drops_the_second_copy_of_last_evenings_list():
    c = comp()
    evening = _picks(["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide-t1s4_1032"], "preview")
    recorded = _picks(["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide_1032"])
    m = morning.choose(evening, recorded, c, NAMES, None, cap=True)
    assert m.picks.core == ["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide_1032"]
    assert m.removed == ["N_wide-t1s4_1032"] and m.added == ["N_wide_1032"]
    uncapped = morning.choose(evening, recorded, c, NAMES, None)
    assert uncapped.picks.core == list(evening.core)


def test_morning_rebuild_reproduces_a_capped_entry():
    c = comp()
    block = {
        "core": ["S_ditm1-t1s44_0917", "N_wide-t1s4_1017", "N_wide_1032"],
        "buy": ["N_buy_1117"],
        "composite": {},
    }
    assert morning._reproduces(block, NAMES, c, None, cap=True) == ""
    assert morning._reproduces(block, NAMES, c, None) != ""
