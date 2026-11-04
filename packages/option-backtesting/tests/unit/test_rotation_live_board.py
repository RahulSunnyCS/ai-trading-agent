"""The live board (BL-203, `rotation/live_board.py`): bars to the engine's day, a pick waiting /
open / closed, your lots from the automation settings, the second refresh reading only the held
contracts, a throttled read keeping the last snapshot, and the button's route. Angel One is always
faked: no test logs in or reads a candle."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_live_board_routes as routes
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


def test_the_button_makes_no_login_before_the_picks_are_recorded(tmp_path, monkeypatch):
    """2026-11-04: a Refresh at 08:18 logged in to Angel One for nothing and collided with the
    08:15 AlgoTest broker login. Picks are checked before the login guard, as the loop does."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(lb, "loop_status", lambda root=None: {"running": False})
    monkeypatch.setattr(lb, "todays_picks", lambda day, root=None: [])

    def no_login(*args, **kwargs):
        raise AssertionError("the login guard must not be taken without picks")

    monkeypatch.setattr(routes.check, "begin", no_login)
    r = TestClient(create_app()).post("/legwise/rotation/live-board/refresh")
    assert r.status_code == 202 and r.json()["status"] == "no_picks"
    state = lb.read_state(tmp_path)
    assert state["refreshing"] is False and state["last_error"] is None
    assert state["last_note"].startswith("no picks recorded for") and state["last_done_at"]


def test_the_board_reads_the_newest_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    folder = tmp_path / "rotation" / "live-board"
    folder.mkdir(parents=True)
    (folder / "2026-11-02.json").write_text(json.dumps({"day": "2026-11-02", "books": []}))
    got = TestClient(create_app()).get("/legwise/rotation/live-board").json()
    assert got["snapshot"]["day"] == "2026-11-02" and got["loop"]["running"] is False
    assert isinstance(Series.empty().close, list)


# --- review fixes ----------------------------------------------------------------------------


class RejectingClient(FakeClient):
    def bars(self, exchange, token, day):
        from option_backtesting.angelone.auth import AngelCredentialsError

        raise AngelCredentialsError("Angel One rejected the session: AG8001 Invalid Token")


def test_a_rejected_session_is_raised_not_read_as_a_failed_bar(monkeypatch):
    from option_backtesting.angelone.auth import AngelCredentialsError

    monkeypatch.setattr(lb.time, "sleep", lambda s: None)
    with pytest.raises(AngelCredentialsError, match="rejected the session"):
        lb.fetch_and_build(
            RejectingClient(40),
            DAY,
            books(),
            {"rows": {}},
            master=master_rows(),
            now=lambda: start(41) + 1,
            log=lambda m: None,
        )


def _clock(times: list[str]):
    it = iter(times)
    last = {"t": times[0]}

    def now():
        last["t"] = next(it, last["t"])
        h, m = map(int, last["t"].split(":"))
        return datetime(2026, 11, 3, h, m, tzinfo=lb.IST)

    return now


def test_a_network_blip_on_login_does_not_end_the_day(tmp_path, monkeypatch):
    from option_backtesting.angelone.auth import AngelNetworkError

    calls: list[str] = []

    def refresh(self, by="loop"):
        calls.append(by)
        if len(calls) == 1:
            raise AngelNetworkError("Angel One could not be reached")
        return None

    monkeypatch.setattr(lb.Board, "refresh", refresh)
    monkeypatch.setattr(lb, "now_ist", _clock(["09:20", "09:20", "09:21", "09:22", "15:32"]))
    code = lb.run_loop(every_s=0, root=tmp_path, log=lambda m: None, sleep=lambda s: None)
    assert code == 0 and len(calls) >= 2
    assert "refresh skipped" in lb.read_state(tmp_path)["last_error"]


def test_a_refused_login_stops_the_loop(tmp_path, monkeypatch):
    from option_backtesting.angelone.auth import AngelCredentialsError

    def refresh(self, by="loop"):
        raise AngelCredentialsError("Angel One login failed: AB1050 Invalid PIN")

    monkeypatch.setattr(lb.Board, "refresh", refresh)
    # the heartbeat reads the clock once on start
    monkeypatch.setattr(lb, "now_ist", _clock(["09:20", "09:20", "09:20", "15:32"]))
    assert lb.run_loop(root=tmp_path, log=lambda m: None, sleep=lambda s: None) == 3


def test_the_loop_reads_as_running_through_a_long_refresh(tmp_path):
    path = tmp_path / "rotation" / "live-board" / "loop.json"
    with lb._Heartbeat(path, 300, interval_s=0.01):
        assert lb.loop_status(tmp_path)["running"] is True
    assert not path.exists()


def test_nothing_trades_while_paused_or_with_uploads_off():
    picks = lb.BookPicks("t1", "Adaptive Tuned", ["N_wide_0947"], [], {"NIFTY": "0"}, False, None)
    row = {"list": "t1", "upload": True, "multiplier": 1}
    paused = {
        "masters": {"uploads": True},
        "pause": {"until": "2026-11-05"},
        "rows": {"algotest.finvasia": row},
    }
    assert lb.real_lots(picks, paused, DAY) == ({"N_wide_0947": 0}, [])
    off = {"masters": {"uploads": False}, "rows": {"algotest.finvasia": row}}
    assert lb.real_lots(picks, off, DAY) == ({"N_wide_0947": 0}, [])
    on = {
        "masters": {"uploads": True},
        "pause": {"until": "2026-11-02"},
        "rows": {"algotest.finvasia": row},
    }
    assert lb.real_lots(picks, on, DAY)[0] == {"N_wide_0947": 1}


def test_an_open_leg_in_the_slipped_copy_pays_its_exit_slippage():
    spec = load_legwise(strategy_path("N_wide_0947"))
    data = synthetic_day(40)
    result = lb.simulate_day(spec, data, lb.default_reference_data(), date(2026, 10, 12))
    plain, gross, _ = lb._trade_rows(result, data, 40)
    slipped, gross_slipped, _ = lb._trade_rows(result, data, 40, exit_slip_pct=0.5)
    assert [leg["price"] for leg in slipped] == [round(leg["price"] * 1.005, 2) for leg in plain]
    assert gross_slipped < gross


def test_every_finished_refresh_stamps_last_done_at(tmp_path):
    lb._update_state(tmp_path, refreshing=True)
    assert "last_done_at" not in lb.read_state(tmp_path)
    lb._update_state(tmp_path, refreshing=False, last_note="no picks recorded")
    assert lb.read_state(tmp_path)["last_done_at"]


def test_the_cached_master_keeps_only_the_rows_the_board_reads():
    lb._MASTER = None
    rows = [
        *master_rows(),
        {"instrumenttype": "OPTSTK", "name": "RELIANCE"},
        {"instrumenttype": "OPTIDX", "name": "BANKNIFTY"},
    ]
    kept = lb.scrip_master(DAY, loader=lambda: rows)
    assert len(kept) == len(master_rows())
    lb._MASTER = None
