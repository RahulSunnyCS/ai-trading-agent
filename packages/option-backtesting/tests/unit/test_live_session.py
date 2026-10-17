"""The Live page's data (`live/session.py`, `api/live_routes.py`, BL-117 Phase 3).

A synthetic day is built in memory (no lake file, nothing under the real TRADING_DATA_ROOT). The
tests pin the two straddle definitions, the gaps (a missing leg is a gap, never a carried or made-up
value), the trim to the last real minute, and the route's errors.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.legwise.market import N_MINUTES, DayData, Series
from option_backtesting.live import session

DAY = date(2026, 10, 16)  # a Friday
EXPIRY = date(2026, 10, 19)  # the Monday after: one weekday away
IST = timezone(timedelta(hours=5, minutes=30))


def _series(values: list[float | None]) -> Series:
    full = list(values) + [values[-1]] * (N_MINUTES - len(values))
    return Series(
        open=list(full),
        high=[v if v is None else v + 1 for v in full],
        low=[v if v is None else v - 1 for v in full],
        close=list(full),
    )


def _leg(price: float | None, n: int = 4) -> Series:
    return _series([price] * n)


class Ref:
    def strike_step(self, underlying: str, as_of: date) -> float:
        return 50.0


def _day(spot: list[float], chain: dict) -> DayData:
    return DayData(
        day=DAY,
        underlying="NIFTY",
        spot=_series(spot),
        chain=chain,
        listed_expiries=[EXPIRY, date(2026, 10, 27)],
        master_lot_size=65,
        vix=_series([14.0, 14.1, 14.2, 14.3]),
    )


@pytest.fixture
def patched(monkeypatch):
    """session.build_session over an in-memory day, last real minute 3 (four bars)."""
    data = _day(
        spot=[22000.0, 22020.0, 22060.0, 22080.0],
        chain={
            (EXPIRY, 22000.0, "CE"): _leg(100.0),
            (EXPIRY, 22000.0, "PE"): _leg(90.0),
            (EXPIRY, 22050.0, "CE"): _leg(70.0),
            (EXPIRY, 22050.0, "PE"): _leg(120.0),
            # 22100 is not collected: the minute the index reaches it has no rolling straddle
            (EXPIRY, 22100.0, "CE"): _leg(40.0),
        },
    )
    monkeypatch.setattr(session.market, "available_days", lambda root, u: [DAY])
    monkeypatch.setattr(session, "_load", lambda root, u, d: data)
    monkeypatch.setattr(session, "_last_minute", lambda root, u, d: 3)
    return data


def test_the_day_is_trimmed_to_the_last_real_minute(patched, tmp_path):
    s = session.build_session(tmp_path, "NIFTY", DAY, Ref())
    assert s["last_minute"] == 3
    assert len(s["minutes"]) == 4
    assert len(s["spot"]["close"]) == len(s["vix"]) == len(s["atm"]) == 4
    # 09:15 IST on the day, then one minute apart
    assert s["minutes"][0] == int(datetime(2026, 10, 16, 9, 15, tzinfo=IST).timestamp())
    assert s["minutes"][3] - s["minutes"][0] == 180


def test_rolling_straddle_restrikes_with_the_index(patched, tmp_path):
    s = session.build_session(tmp_path, "NIFTY", DAY, Ref())
    assert s["atm"] == [22000.0, 22000.0, 22050.0, 22100.0]
    rolling = s["rolling"]["straddle"]
    assert rolling[0] == rolling[1] == 190.0  # 22000: 100 + 90
    assert rolling[2] == 190.0  # 22050: 70 + 120
    # the last minute's strike (22100) has no collected put: a gap, not a carried value
    assert rolling[3] is None
    assert s["rolling"]["pe"][3] is None and s["rolling"]["ce"][3] == 40.0


def test_fixed_straddle_holds_the_opening_strike(patched, tmp_path):
    s = session.build_session(tmp_path, "NIFTY", DAY, Ref())
    fixed = s["fixed"]
    assert fixed["strike"] == 22000.0  # ATM at the 09:15 open, 22000 -> 22000
    assert fixed["straddle"] == [190.0] * 4  # never moves to 22050
    assert fixed["open_value"] == 190.0


def test_expiry_and_weekday_days_to_expiry(patched, tmp_path):
    s = session.build_session(tmp_path, "NIFTY", DAY, Ref())
    assert s["expiry"] == "2026-10-19"
    assert s["dte_weekdays"] == 1  # Friday -> Monday counts one weekday, not three days
    assert s["live"]["available"] is False
    assert s["source"]["kind"] == "replay"


def test_range_context_without_history_has_no_median(patched, tmp_path):
    s = session.build_session(tmp_path, "NIFTY", DAY, Ref())
    assert s["range"]["median_full_session"] is None
    assert s["range"]["median_sessions"] == 0
    assert s["range"]["full_session"] is not None


def test_a_day_without_data_and_a_bad_underlying_are_refused(patched, tmp_path):
    with pytest.raises(session.LiveSessionError, match="no NIFTY data for 2026-10-15"):
        session.build_session(tmp_path, "NIFTY", date(2026, 10, 15), Ref())
    with pytest.raises(session.LiveSessionError, match="underlying must be"):
        session.build_session(tmp_path, "BANKNIFTY", DAY, Ref())


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(session.market, "available_days", lambda root, u: [])
    return TestClient(create_app())


def test_routes_answer_with_the_documented_errors(client):
    assert client.get("/legwise/live/days?underlying=NIFTY").json() == {
        "underlying": "NIFTY",
        "days": [],
    }
    assert client.get("/legwise/live/days?underlying=BANKNIFTY").status_code == 422
    assert client.get("/legwise/live/session?underlying=NIFTY&day=16-10-2026").status_code == 422
    missing = client.get("/legwise/live/session?underlying=NIFTY")
    assert missing.status_code == 404
    assert "no collected NIFTY days" in missing.json()["error"]
