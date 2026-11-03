"""The live board (BL-203, `rotation/live_board.py`): bars to the engine's day, a pick waiting /
open / closed, your lots from the automation settings, the second refresh reading only the held
contracts, a throttled read keeping the last snapshot, and the button's route. Angel One is always
faked: no test logs in or reads a candle."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.legwise.market import DayData, Series
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import live_board as lb
from option_backtesting.rotation.variants import strategy_path

DAY = date(2026, 11, 3)
EXPIRY = date(2026, 11, 3)
STRIKES = [23400 + 50 * i for i in range(9)]  # 23400 .. 23800


def start(minute: int) -> int:
    """Epoch of the bar starting at session minute `minute` (0 = 09:15 IST)."""
    return int(
        (datetime(2026, 11, 3, 9, 15, tzinfo=lb.IST) + timedelta(minutes=minute)).timestamp()
    )


def flat(price: float, upto: int, moves: dict[int, float] | None = None) -> lb.Bars:
    out: lb.Bars = {}
    for m in range(upto + 1):
        p = (moves or {}).get(m, price)
        out[start(m)] = (p, p, p, p)
    return out


# --- pure pieces ----------------------------------------------------------------------------


def test_complete_drops_the_forming_bar():
    bars = flat(10.0, 5)
    assert sorted(lb.complete(bars, start(5) + 30)) == [start(m) for m in range(5)]
    assert sorted(lb.complete(bars, start(6))) == [start(m) for m in range(6)]


def test_bar_minute_and_series():
    assert lb.bar_minute(start(0)) == 0 and lb.bar_minute(start(32)) == 32
    s = lb.to_series({start(0): (1, 2, 0.5, 1.5), start(3): (2, 2, 2, 2)}, last=4)
    assert s.close[:5] == [1.5, 1.5, 1.5, 2, 2]  # forward-filled up to `last`


def test_band_takes_width_strikes_beyond_the_range():
    strikes = [100.0 * i for i in range(50)]
    got = lb.band(strikes, 2050, 2250, width=3)
    assert got[0] == 1800 and got[-1] == 2500


def test_real_lots_from_the_settings_rows():
    picks = lb.BookPicks(
        "core",
        "Adaptive Classic",
        ["N_dir_0917", "N_wide_0932"],
        ["N_buy_0917"],
        {"NIFTY": "2", "SENSEX": "3"},
        False,
        None,
    )
    settings = {
        "rows": {
            "quantiply.angelone": {
                "list": "core",
                "upload": True,
                "multiplier": 2,
                "dirBoost": True,
                "addon": True,
            },
            "algotest.finvasia": {"list": "t1", "upload": True, "multiplier": 1},
            "quantiply.finvasia": {"list": "core", "upload": False, "multiplier": 5},
        }
    }
    lots, accounts = lb.real_lots(picks, settings)
    assert lots == {"N_dir_0917": 4, "N_wide_0932": 2, "N_buy_0917": 2}
    assert accounts == ["quantiply · angelone ×2"]


def test_fixed_contracts_skip_an_unsure_or_partly_entered_pick():
    spec = load_legwise(strategy_path("N_wide_0947"))
    leg = {"expiry": "2026-11-03", "strike": 23650.0, "option_type": "CE"}
    prev = {
        "books": [
            {
                "picks": [
                    {
                        "variant": "A",
                        "state": "open",
                        "legs": [
                            {**leg, "leg": "ce"},
                            {**leg, "leg": "pe", "option_type": "PE", "strike": 23550.0},
                        ],
                    },
                    {
                        "variant": "B",
                        "state": "open",
                        "legs": [{**leg, "leg": "ce"}],
                    },  # one of two legs
                    {
                        "variant": "C",
                        "state": "open",
                        "strikes_sure": False,
                        "legs": [{**leg, "leg": "ce"}, {**leg, "leg": "pe"}],
                    },
                ]
            }
        ]
    }
    got = lb.fixed_contracts(prev, {"A": spec, "B": spec, "C": spec})
    assert got == {"A": {(EXPIRY, 23650.0, "CE"), (EXPIRY, 23550.0, "PE")}}


# --- a pick on a synthetic session ----------------------------------------------------------


def synthetic_day(last: int, ce_moves=None) -> DayData:
    chain = {}
    for k in STRIKES:
        for side in ("CE", "PE"):
            moves = ce_moves if (side == "CE" and k == 23650) else None
            chain[(EXPIRY, float(k), side)] = lb.to_series(flat(50.0, last, moves), last)
    return DayData(DAY, "NIFTY", lb.to_series(flat(23600.0, last), last), chain, [EXPIRY], 65)


def test_a_pick_before_its_entry_is_waiting():
    spec = load_legwise(strategy_path("N_wide_0947"))  # enters 09:47 = minute 32
    row = lb.run_pick("N_wide_0947", spec, synthetic_day(20), 20)
    assert row["state"] == "waiting" and row["legs"] == [] and row["net"] == 0


def test_an_entered_pick_is_open_and_marked_at_the_last_bar():
    spec = load_legwise(strategy_path("N_wide_0947"))
    data = synthetic_day(40, ce_moves={38: 40.0, 39: 40.0, 40: 40.0})
    row = lb.run_pick("N_wide_0947", spec, data, 40)
    assert row["state"] == "open"
    ce = next(leg for leg in row["legs"] if leg["option_type"] == "CE")
    assert ce["strike"] == 23650 and ce["reason"] == "open" and ce["exit"] is None
    assert ce["price"] == 40.0 and ce["pnl"] == pytest.approx(10.0 * ce["qty"])
    assert row["net"] == pytest.approx(sum(leg["pnl"] for leg in row["legs"]))
    assert row["net_slipped"] < row["net"]  # slippage on the entries costs something
    assert row["curve"][-1][0] == 40


def test_a_stopped_leg_is_closed_at_its_stop():
    spec = load_legwise(strategy_path("N_wide_0947"))  # SL 115%: 50 -> 107.5
    data = synthetic_day(45, ce_moves={m: 120.0 for m in range(40, 46)})
    row = lb.run_pick("N_wide_0947", spec, data, 45)
    ce = next(leg for leg in row["legs"] if leg["option_type"] == "CE")
    assert ce["reason"] != "open" and ce["exit"] is not None


# --- fetching: a fake Angel One ------------------------------------------------------------


def master_rows() -> list[dict]:
    rows = [
        {"instrumenttype": "AMXIDX", "exch_seg": "NSE", "symbol": "Nifty 50", "token": "IDX"},
        {"instrumenttype": "AMXIDX", "exch_seg": "NSE", "symbol": "India VIX", "token": "VIX"},
    ]
    for k in STRIKES:
        for side in ("CE", "PE"):
            rows.append(
                {
                    "instrumenttype": "OPTIDX",
                    "exch_seg": "NFO",
                    "name": "NIFTY",
                    "symbol": f"NIFTY03NOV26{k}{side}",
                    "expiry": "03NOV2026",
                    "strike": f"{k * 100}.000000",
                    "lotsize": "65",
                    "token": f"{k}{side}",
                }
            )
    return rows


class FakeClient:
    def __init__(self, last: int, fail: set[str] | None = None) -> None:
        self.last, self.fail = last, fail or set()
        self.calls = 0
        self.tokens: list[str] = []

    def bars(self, exchange: str, token: str, day: date) -> lb.Bars:
        self.calls += 1
        self.tokens.append(token)
        if token in self.fail:
            raise RuntimeError("HTTP 403, not JSON: Access denied because of exceeding access rate")
        price = {"IDX": 23600.0, "VIX": 15.0}.get(token, 50.0)
        return flat(price, self.last)


def books() -> list[lb.BookPicks]:
    return [
        lb.BookPicks("t1", "Adaptive Tuned", ["N_wide_0947"], [], {"NIFTY": "0"}, False, "NIFTY")
    ]


def test_the_second_refresh_reads_only_the_held_contracts(monkeypatch):
    monkeypatch.setattr(lb.time, "sleep", lambda s: None)
    now = start(41) + 1
    first = FakeClient(40)
    snap = lb.fetch_and_build(
        first, DAY, books(), {"rows": {}}, master=master_rows(), now=lambda: now, log=lambda m: None
    )
    assert first.calls == 2 + 2 * len(STRIKES)  # VIX, index, the whole band
    pick = snap["books"][0]["picks"][0]
    assert pick["state"] == "open" and pick["strikes_sure"]
    second = FakeClient(40)
    again = lb.fetch_and_build(
        second,
        DAY,
        books(),
        {"rows": {}},
        master=master_rows(),
        previous=snap,
        now=lambda: now,
        log=lambda m: None,
    )
    assert second.calls == 4 and set(second.tokens[2:]) == {"23650CE", "23550PE"}
    assert again["books"][0]["picks"][0]["net"] == pick["net"]


def test_a_waiting_pick_reads_no_options(monkeypatch):
    client = FakeClient(20)
    snap = lb.fetch_and_build(
        client,
        DAY,
        books(),
        {"rows": {}},
        master=master_rows(),
        now=lambda: start(21) + 1,
        log=lambda m: None,
    )
    assert client.calls == 2 and snap["books"][0]["picks"][0]["state"] == "waiting"
    assert snap["as_of"] == "09:36"


def test_an_index_that_cannot_be_read_keeps_the_last_snapshot(monkeypatch):
    monkeypatch.setattr(lb.time, "sleep", lambda s: None)
    with pytest.raises(lb.NotRead):
        lb.fetch_and_build(
            FakeClient(40, fail={"IDX"}),
            DAY,
            books(),
            {"rows": {}},
            master=master_rows(),
            now=lambda: start(41) + 1,
            log=lambda m: None,
        )


def test_a_band_strike_that_fails_leaves_the_pick_unsure(monkeypatch):
    monkeypatch.setattr(lb.time, "sleep", lambda s: None)
    snap = lb.fetch_and_build(
        FakeClient(40, fail={"23800CE"}),
        DAY,
        books(),
        {"rows": {}},
        master=master_rows(),
        now=lambda: start(41) + 1,
        log=lambda m: None,
    )
    assert snap["books"][0]["picks"][0]["strikes_sure"] is False
    assert any("could not be read" in n for n in snap["notes"])


# --- the routes ------------------------------------------------------------------------------


def test_the_button_asks_a_running_loop(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(lb, "loop_status", lambda root=None: {"running": True})
    r = TestClient(create_app()).post("/legwise/rotation/live-board/refresh")
    assert r.status_code == 202 and r.json() == {"status": "requested"}
    assert (tmp_path / "rotation" / "live-board" / "request.json").exists()


def test_the_board_reads_the_newest_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    folder = tmp_path / "rotation" / "live-board"
    folder.mkdir(parents=True)
    (folder / "2026-11-02.json").write_text(json.dumps({"day": "2026-11-02", "books": []}))
    got = TestClient(create_app()).get("/legwise/rotation/live-board").json()
    assert got["snapshot"]["day"] == "2026-11-02" and got["loop"]["running"] is False
    assert isinstance(Series.empty().close, list)
