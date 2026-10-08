"""BL-051 Phase 3: Friday live scores - a provisional row from Fyers prices, in memory only."""

from datetime import datetime

import pandas as pd
import pytest
from fastapi import HTTPException

from momentum_backtesting import api, fyers
from momentum_backtesting.categories import broad
from momentum_backtesting.notify import IST

WEEKS = pd.to_datetime(["2026-09-18", "2026-09-25", "2026-10-02"])


def _universe() -> broad.StockUniverseFrame:
    columns = ["AAA", "BBB#2", "CCC", "DDD"]
    frame = pd.DataFrame(
        {
            "AAA": [100.0, 101, 102],
            "BBB#2": [50.0, 51, 52],
            "CCC": [10.0, 10, 10],
            "DDD": [80.0, 81, 82],
        },
        index=WEEKS,
    )
    membership = pd.DataFrame(True, index=WEEKS, columns=columns)
    membership.loc[WEEKS[-1], "DDD"] = False
    return broad.StockUniverseFrame(
        frame=frame,
        weeks=list(WEEKS),
        column_to_base_symbol={"AAA": "AAA", "BBB#2": "BBB", "CCC": "CCC", "DDD": "DDD"},
        stock_membership=membership,
        events=pd.DataFrame(),
        stale_columns={"CCC": WEEKS[0]},
        missing_symbols=[],
        raw_frame=frame.copy(),
    )


def test_the_live_row_uses_live_prices_and_keeps_the_last_membership():
    universe = _universe()
    friday = pd.Timestamp("2026-10-09")
    live, info = api.live_scores_universe(universe, {"AAA": 110.0, "BBB": 200.0}, friday)
    assert list(live.frame.index) == [*WEEKS, friday] and live.weeks[-1] == friday
    assert live.frame.at[friday, "AAA"] == 110.0  # live
    assert live.frame.at[friday, "BBB#2"] == 52.0  # +285%: kept at the last close and reported
    assert live.frame.at[friday, "DDD"] == 82.0  # no quote: last close
    assert info == {"used": 1, "missing": ["DDD"], "suspect": ["BBB"]}
    assert not live.stock_membership.at[friday, "DDD"]  # membership carried, not recomputed
    assert universe.frame.index[-1] == WEEKS[-1]  # the stored frame is untouched


def _now(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=IST)


@pytest.mark.parametrize(
    "when", ["2026-10-08T11:00:00", "2026-10-09T09:00:00", "2026-10-09T15:45:00"]
)
def test_live_scores_are_only_for_friday_market_hours(when):
    with pytest.raises(HTTPException) as error:
        api._momentum_scores_live_payload(now=_now(when))
    assert error.value.status_code == 409 and "Fridays" in error.value.detail


def test_live_scores_quote_every_base_symbol_and_say_they_are_provisional(monkeypatch):
    monkeypatch.setattr(api.DATA, "get_momentum_universe", lambda: _universe())
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: object())
    asked = []

    def quotes(symbols, creds):
        asked.extend(symbols)
        return {"NSE:AAA-EQ": 111.0, "NSE:BBB-EQ": 53.0, "NSE:DDD-EQ": 83.0}

    monkeypatch.setattr(fyers, "quotes", quotes)
    seen = {}

    def stock_scores(universe, group_info):
        seen["frame"] = universe.frame
        return "stocks"

    monkeypatch.setattr(api.momentum_scores_mod, "load_stock_group_info", lambda d: {})
    monkeypatch.setattr(api.broad, "load_stock_groups", lambda d: {})
    monkeypatch.setattr(api.momentum_scores_mod, "compute_stock_momentum_scores", stock_scores)
    monkeypatch.setattr(
        api.momentum_scores_mod, "compute_sector_momentum_scores", lambda s, g: "sectors"
    )
    monkeypatch.setattr(api.momentum_scores_mod, "compute_rotation", lambda u, g: None)
    monkeypatch.setattr(api.momentum_scores_mod, "to_payload", lambda *a, **k: {"stocks": []})
    monkeypatch.setattr(api, "_membership_quality", lambda: None)
    api._LIVE_SCORES_CACHE.clear()
    payload = api._momentum_scores_live_payload(now=_now("2026-10-09T13:05:00"))
    assert sorted(asked) == ["NSE:AAA-EQ", "NSE:BBB-EQ", "NSE:CCC-EQ", "NSE:DDD-EQ"]
    assert payload["live"]["provisional"] is True and payload["live"]["week"] == "2026-10-09"
    assert payload["live"]["priced"] == 3
    assert seen["frame"].at[pd.Timestamp("2026-10-09"), "AAA"] == 111.0
    # Cached for the next few minutes: no second round of quotes.
    asked.clear()
    api._momentum_scores_live_payload(now=_now("2026-10-09T13:07:00"))
    assert asked == []


def test_once_fridays_closes_are_in_the_normal_scores_are_final(monkeypatch):
    universe = _universe()
    universe.frame.loc[pd.Timestamp("2026-10-09")] = universe.frame.iloc[-1]
    monkeypatch.setattr(api.DATA, "get_momentum_universe", lambda: universe)
    with pytest.raises(HTTPException) as error:
        api._momentum_scores_live_payload(now=_now("2026-10-09T15:00:00"))
    assert "already in" in error.value.detail
