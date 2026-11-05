"""Beats random over a window (`rotation/beats.py`) and its route (owner, 2026-11-05)."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_beats_routes as routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import beats, candles, warm

WIDE = [f"N_wide_{h}" for h in ("0917", "0920", "0925", "0930", "0935", "0940")]
DIR = [f"N_dir_{h}" for h in ("0917", "0920", "0925", "0930")]
BUY = ["N_buy_0917", "N_buy_0920"]
NAMES = WIDE + DIR + BUY


def _days(n: int, end: date = date(2026, 11, 5)) -> list[date]:
    out, d = [], end
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return sorted(out)


def test_months_back_clamps_to_the_month_end():
    assert beats._months_back(date(2026, 11, 5), 6) == date(2026, 5, 5)
    assert beats._months_back(date(2026, 8, 31), 6) == date(2026, 2, 28)
    assert beats._months_back(date(2026, 11, 5), 12) == date(2025, 11, 5)
    assert beats._months_back(date(2026, 1, 15), 24) == date(2024, 1, 15)


def test_window_slice_counts_sessions_and_calendar_months():
    days = _days(300)
    sl = beats.window_slice(days, {"sessions": 60})
    assert (sl.start, sl.stop) == (240, 300)
    assert beats.window_slice(days[:10], {"sessions": 60}).start == 0  # fewer days than asked
    sl = beats.window_slice(days, {"months": 6})
    assert days[sl.start] > date(2026, 5, 5) >= days[sl.start - 1]  # strictly after the cut
    assert beats.window_slice([], {"months": 6}) == slice(0, 0)


def test_share_is_the_fraction_of_random_totals_below_the_book():
    rand = np.tile(np.arange(100, dtype=float), (3, 1))  # three days, runs 0..99 each
    book = np.array([10.0, 10.0, 10.0])  # 30 in total: runs 0..99 -> sums 0, 3, ..., 297
    got = beats.share(book, rand, slice(0, 3))
    assert got["days"] == 3 and got["total"] == 30.0
    assert got["beats_random_pct"] == pytest.approx(10.0)  # sums 0..27 are below 30: 10 of 100
    assert beats.share(book, rand, slice(2, 2)) is None


@pytest.fixture
def world(monkeypatch):
    days = _days(130)
    rng = np.random.default_rng(3)
    gross = {n: {d: float(rng.normal(0, 100)) for d in days} for n in NAMES}
    monkeypatch.setattr(candles, "_pool", lambda book: list(NAMES))
    monkeypatch.setattr(beats, "_grosses", lambda names, root: gross)
    monkeypatch.setattr(beats, "MIN_POOL", 3)
    monkeypatch.setattr(beats, "_late_days", lambda root, book: set())

    def picks(root, book, start, end):
        out = {}
        for i, d in enumerate(days):
            names = [WIDE[0], WIDE[1], DIR[0]] + (BUY[:1] if i % 5 == 0 else [])
            out[d] = candles.DayPicks(
                [(n, 1) for n in names], "recorded" if i >= 120 else "rederived"
            )
        return out

    monkeypatch.setattr(candles, "picks_by_day", picks)
    return days, gross


def test_daily_sums_the_picks_and_marks_the_buy_days(world):
    days, gross = world
    d = beats.daily(None, "t1", days[0], days[-1], runs=50)
    assert d["days"] == days and d["random"].shape == (130, 50) and not d["left_out"]
    assert d["book"][0] == pytest.approx(
        gross[WIDE[0]][days[0]]
        + gross[WIDE[1]][days[0]]
        + gross[DIR[0]][days[0]]
        + gross[BUY[0]][days[0]]
    )
    assert d["source"][-1] == "recorded" and d["source"][0] == "rederived"


def test_a_day_with_a_pick_missing_is_left_out_not_counted_as_zero(world, monkeypatch):
    days, gross = world
    del gross[DIR[0]][days[5]]
    d = beats.daily(None, "core", days[0], days[-1], runs=20)
    assert days[5] not in d["days"] and d["left_out"][days[5].isoformat()] == "a pick has no result"


def test_windows_report_every_window_and_the_recorded_days(world):
    days, _ = world
    out = beats.windows(None, "t1", days[-1])
    assert out["n_days"] == 130 and out["recorded_days"] == 10
    assert set(out["windows"]) == {"sessions60", "months6", "year1", "years2", "all", "recorded"}
    assert out["windows"]["sessions60"]["days"] == 60
    assert out["windows"]["all"]["days"] == 130
    assert out["windows"]["recorded"]["days"] == 10
    assert out["windows"]["recorded"]["from"] == days[120].isoformat()
    # 130 sessions are about 6 months, so the year and two-year windows hold them all
    assert out["windows"]["year1"]["days"] == 130
    for w in out["windows"].values():
        assert 0 <= w["beats_random_pct"] <= 100 and w["random_p10"] <= w["random_p90"]


def test_a_late_journal_entry_is_left_out_as_the_registered_read_out_does(world, monkeypatch):
    days, _ = world
    monkeypatch.setattr(beats, "_late_days", lambda root, book: {days[-1]})
    d = beats.daily(None, "t1", days[0], days[-1], runs=20)
    assert days[-1] not in d["days"]
    assert d["left_out"][days[-1].isoformat()] == "recorded after the 09:16 entry"


def test_same_answer_twice(world):
    days, _ = world
    a = beats.windows(None, "core", days[-1])
    b = beats.windows(None, "core", days[-1])
    assert a == b


def test_the_route(world, monkeypatch, tmp_path):
    days, _ = world
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    routes._cache.clear()
    monkeypatch.setattr(beats, "today", lambda: days[-1])
    client = TestClient(create_app())
    assert client.get("/legwise/rotation/beats?book=other").status_code == 422
    body = client.get("/legwise/rotation/beats?book=t1").json()
    assert body["book"] == "t1" and body["windows"]["sessions60"]["days"] == 60
    monkeypatch.setattr(warm, "run_within", lambda key, fn, wait=None: (False, None))
    routes._cache.clear()
    res = client.get("/legwise/rotation/beats?book=core")
    assert res.status_code == 202 and res.json() == {"status": "warming"}


def test_the_fixed_base_is_two_wide_and_one_dir_lots_over_its_own_days(monkeypatch):
    days = _days(70)
    rng = np.random.default_rng(5)
    gross = {n: {d: float(rng.normal(0, 100)) for d in days} for n in NAMES}
    dir_leg = {d: float(rng.normal(0, 100)) for d in days}
    monkeypatch.setattr(candles, "_pool", lambda book: list(NAMES))
    monkeypatch.setattr(beats, "_grosses", lambda names, root: gross)
    monkeypatch.setattr(
        beats.base_mod, "read_column", lambda path, column="gross", root=None: dir_leg
    )
    monkeypatch.setattr(beats, "MIN_POOL", 3)
    monkeypatch.setattr(beats, "_late_days", lambda root, book: set())
    monkeypatch.setattr(
        candles,
        "picks_by_day",
        lambda root, book, start, end: {
            d: candles.DayPicks(
                [(beats.base_mod.WIDE_NAME, 2), (beats.base_mod.DIR_NAME, 1)], "fixed"
            )
            for d in days
        },
    )
    gross[beats.base_mod.WIDE_NAME] = {d: float(rng.normal(0, 100)) for d in days}
    out = beats.daily(None, "base", days[0], days[-1], runs=40)
    d0 = days[0]
    assert out["book"][0] == pytest.approx(2 * gross[beats.base_mod.WIDE_NAME][d0] + dir_leg[d0])
    res = beats.windows(None, "base", days[-1])
    assert res["fixed"] is True and res["windows"]["recorded"] is None
    assert res["windows"]["sessions60"]["days"] == 60


def _three_books(monkeypatch, days, edge):
    """core and t1 earn `edge` a lot-day more than the base each day; the pool is noise."""
    rng = np.random.default_rng(11)
    gross = {n: {d: float(rng.normal(0, 100)) for d in days} for n in NAMES}
    wide = beats.base_mod.WIDE_NAME
    gross[wide] = {d: 0.0 for d in days}
    dir_leg = {d: 0.0 for d in days}
    monkeypatch.setattr(candles, "_pool", lambda book: list(NAMES) + [wide])
    monkeypatch.setattr(beats, "_grosses", lambda names, root: gross)
    monkeypatch.setattr(
        beats.base_mod, "read_column", lambda path, column="gross", root=None: dir_leg
    )
    monkeypatch.setattr(beats, "MIN_POOL", 3)
    monkeypatch.setattr(beats, "_late_days", lambda root, book: set())

    def picks(root, book, start, end):
        if book == "base":
            names = [(wide, 2), (beats.base_mod.DIR_NAME, 1)]
            kind = "fixed"
        else:
            # three lots a day whose gross is `edge` per lot: one pick standing in for all three
            names = [(WIDE[0], 3)]
            kind = "recorded"
            for d in days:
                gross[WIDE[0]][d] = 3 * edge
        return {d: candles.DayPicks(names, kind) for d in days}

    monkeypatch.setattr(candles, "picks_by_day", picks)
    return gross


def test_compare_gap_is_per_lot_day_against_the_base_on_the_shared_days(monkeypatch):
    days = _days(130)
    _three_books(monkeypatch, days, edge=40.0)
    out = beats.compare(None, days[-1])
    assert out["n_days"] == 130
    row = out["windows"]["sessions60"]
    assert row["days"] == 60 and row["books"]["t1"]["gap_mean"] == pytest.approx(40.0)
    assert row["books"]["t1"]["better_days_pct"] == 100.0
    assert row["books"]["base"].get("gap_mean") is None  # the base is the yardstick
    assert out["alarm"]["books"]["t1"]["state"] == "quiet"


def test_the_drift_alarm_needs_two_sessions_below_the_line(monkeypatch):
    days = _days(130)
    _three_books(monkeypatch, days, edge=-900.0)  # far below -500 a lot-day, every day
    alarm = beats.compare(None, days[-1])["alarm"]["books"]["t1"]
    assert alarm["state"] == "review" and alarm["gap"] == pytest.approx(-900.0)
    assert alarm["last_review_day"] == days[-1].isoformat()
