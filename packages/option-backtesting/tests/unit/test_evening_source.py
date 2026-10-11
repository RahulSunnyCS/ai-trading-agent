"""BL-079: Fyers when it works, Angel One when it does not, and the repair back from Fyers."""

from datetime import date

import pyarrow.parquet as pq
import pytest
from trading_data import lake

from option_backtesting.angelone.auth import AngelCredentialsError
from option_backtesting.fyers import daily
from option_backtesting.fyers.auth import FyersCredentialsError
from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.symbols import Contract
from option_backtesting.legwise import evening
from option_backtesting.legwise import source as day_source

DAY = date(2026, 10, 9)
EXP = date(2026, 10, 13)


def _stub_collect(monkeypatch, behaviour):
    calls = []

    def fake(day, underlyings, **kwargs):
        calls.append(
            {
                "day": day,
                "source": kwargs.get("source"),
                "force": kwargs.get("force"),
                "merge": kwargs.get("merge_existing", False),
            }
        )
        return behaviour(day, kwargs)

    monkeypatch.setattr(evening, "collect_detailed", fake)
    return calls


def test_a_missing_fyers_token_falls_back_to_angel_one_and_says_what_is_missing(monkeypatch):
    flags = {
        "NIFTY": {"index_missing_minutes": 14, "thin_contracts": 3, "minutes_filled": 90},
        "SENSEX": {"oi_unavailable": True},
    }

    def behaviour(day, kwargs):
        if kwargs["source"] == "fyers":
            raise FyersCredentialsError("no Fyers token stored")
        return 0, {"source": "angelone", "flags": flags}

    calls = _stub_collect(monkeypatch, behaviour)
    monkeypatch.setattr(evening.day_source, "recent_angel_days", lambda *_a, **_k: [])
    out = evening.collect_with_fallback(DAY, ["NIFTY"], log=lambda _: None)

    assert [c["source"] for c in calls] == ["fyers", "angelone"]
    assert out.source == "angelone" and out.repaired == []
    text = "\n".join(out.notes)
    assert "no Fyers token stored" in text
    assert "index minutes 15:15-15:28 missing (14)" in text and "SENSEX: no open interest" in text
    assert "Log in to Fyers" in text


def test_fyers_working_repairs_recent_angel_days(monkeypatch):
    calls = _stub_collect(monkeypatch, lambda day, kwargs: (0, {"source": kwargs["source"]}))
    monkeypatch.setattr(evening, "data_dir", lambda: "root")
    monkeypatch.setattr(
        evening.day_source,
        "recent_angel_days",
        lambda root, until, window_days=7: [date(2026, 10, 7), DAY],
    )
    out = evening.collect_with_fallback(DAY, ["NIFTY"], log=lambda _: None)

    assert out.source == "fyers" and out.repaired == [date(2026, 10, 7), DAY]
    repairs = [c for c in calls if c["force"]]
    assert [c["day"] for c in repairs] == [date(2026, 10, 7), DAY]
    assert all(c["merge"] and c["source"] == "fyers" for c in repairs)
    assert "Repaired from Fyers" in out.notes[0]


def test_a_repair_that_hits_a_rejected_token_stops_quietly(monkeypatch):
    def behaviour(day, kwargs):
        if kwargs.get("force"):
            raise FyersCredentialsError("Fyers rejected the token")
        return 0, {}

    _stub_collect(monkeypatch, behaviour)
    monkeypatch.setattr(evening, "data_dir", lambda: "root")
    monkeypatch.setattr(evening.day_source, "recent_angel_days", lambda *_a, **_k: [DAY])
    out = evening.collect_with_fallback(DAY, ["NIFTY"], log=lambda _: None)
    assert out.source == "fyers" and out.repaired == []


def test_angel_one_login_failure_is_not_swallowed(monkeypatch):
    def behaviour(day, kwargs):
        raise (
            FyersCredentialsError("no token")
            if kwargs["source"] == "fyers"
            else AngelCredentialsError("Angel One login failed: AB1050 Invalid totp")
        )

    _stub_collect(monkeypatch, behaviour)
    with pytest.raises(AngelCredentialsError):
        evening.collect_with_fallback(DAY, ["NIFTY"], log=lambda _: None)


# -- merge_existing + day_sources, through the real collector --------------------------------


def _contracts(strikes):
    return [Contract(f"NSE:NIFTY26O13{k}CE", "NIFTY", EXP, float(k), "CE", 65) for k in strikes]


class Bars:
    """Index at 22000, every option at a flat price chosen per source."""

    def __init__(self, price):
        self.price, self.calls, self.on_response = price, 0, None
        self.flags = {"NIFTY": {"index_missing_minutes": 14}}

    def minute_candles(self, symbol, day):
        self.calls += 1
        px = 22000.0 if symbol.endswith("-INDEX") else (15.0 if "VIX" in symbol else self.price)
        return [Candle(1790653500 + 60 * i, px, px, px, px, 1.0, 5.0) for i in range(3)]


def test_repair_keeps_contracts_the_master_no_longer_lists(tmp_path, monkeypatch):
    root = tmp_path / "data"
    listed = {"now": _contracts([22000, 22050, 22100])}
    monkeypatch.setattr(daily, "download_master", lambda segment: "")
    monkeypatch.setattr(daily, "parse_master", lambda text, names: listed["now"])

    daily.collect_day(
        Bars(50.0),
        DAY,
        ["NIFTY"],
        root,
        premium_floor=0,
        max_extra=5,
        log=lambda _: None,
        source="angelone",
    )
    first = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", DAY))
    assert set(first.column("close").to_pylist()) == {50.0}
    assert day_source.day_sources(root, DAY, DAY)[DAY].source == "angelone"
    assert day_source.recent_angel_days(root, DAY) == [DAY]

    # a collected day re-run finds everything present: that run wrote nothing and must not
    # become the day's source
    daily.collect_day(Bars(60.0), DAY, ["NIFTY"], root, log=lambda _: None, source="fyers")
    assert day_source.day_sources(root, DAY, DAY)[DAY].source == "angelone"

    # the repair: Fyers lists only two of the three contracts now
    listed["now"] = _contracts([22000, 22050])
    details = daily.collect_day(
        Bars(70.0),
        DAY,
        ["NIFTY"],
        root,
        premium_floor=0,
        max_extra=5,
        force=True,
        merge_existing=True,
        log=lambda _: None,
        source="fyers",
    )
    merged = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", DAY))
    prices = {}
    for sym, close in zip(
        merged.column("vendor_symbol").to_pylist(), merged.column("close").to_pylist(), strict=True
    ):
        prices.setdefault(sym, set()).add(close)
    assert prices["NSE:NIFTY26O1322000CE"] == {70.0} and prices["NSE:NIFTY26O1322050CE"] == {70.0}
    assert prices["NSE:NIFTY26O1322100CE"] == {50.0}  # kept from the Angel One run
    assert details["repair"]["kept_existing_contracts"] == 1
    after = day_source.day_sources(root, DAY, DAY)[DAY]
    assert after.source == "fyers" and after.kept_existing == 1
    assert day_source.recent_angel_days(root, DAY) == []
