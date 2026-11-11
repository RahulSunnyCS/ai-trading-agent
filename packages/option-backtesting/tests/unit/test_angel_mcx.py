"""Angel One as the MCX fallback source (BL-148 Phase 4): contract matching, request chunking, OI
units, auth errors, and the collector's fallback rules. Fake SmartAPI, no network."""

from datetime import date, datetime, timedelta, timezone

import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.angelone.auth import AngelCredentialsError, Session
from option_backtesting.angelone.client import CANDLE_PATH, OI_PATH
from option_backtesting.angelone.mcx import CHUNK_DAYS, AngelMcxClient
from option_backtesting.fyers import mcx_daily
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
E1 = date(2026, 11, 17)
SESSION = date(2026, 11, 10)
CE = Contract("MCX:CRUDEOIL26NOV8100CE", "CRUDEOIL", E1, 8100.0, "CE", 1)
PE = Contract("MCX:CRUDEOIL26NOV8100PE", "CRUDEOIL", E1, 8100.0, "PE", 1)
GAP = Contract("MCX:CRUDEOIL26NOV9999CE", "CRUDEOIL", E1, 9999.0, "CE", 1)  # not in the master

MASTER = [
    {  # SmartAPI scales strikes by 100 and quotes the lot in units (barrels)
        "token": "582912", "symbol": "CRUDEOIL17NOV268100CE", "name": "CRUDEOIL",
        "expiry": "17NOV2026", "strike": "810000.000000", "lotsize": "100",
        "instrumenttype": "OPTFUT", "exch_seg": "MCX",
    },
    {
        "token": "583062", "symbol": "CRUDEOIL17NOV268100PE", "name": "CRUDEOIL",
        "expiry": "17NOV2026", "strike": "810000.000000", "lotsize": "100",
        "instrumenttype": "OPTFUT", "exch_seg": "MCX",
    },
    {  # another exchange's row of the same name must never match
        "token": "1", "symbol": "CRUDEOIL17NOV268100CE", "name": "CRUDEOIL",
        "expiry": "17NOV2026", "strike": "810000.000000", "lotsize": "100",
        "instrumenttype": "OPTFUT", "exch_seg": "NFO",
    },
]  # fmt: skip


def _iso(day: date, hour: int, minute: int) -> str:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST).isoformat()


class FakeApi:
    def __init__(self, *, candle_error=None, oi_ok=True):
        self.requests: list[tuple[str, dict]] = []
        self.candle_error = candle_error
        self.oi_ok = oi_ok

    def __call__(self, path, body, headers):
        self.requests.append((path, body))
        if path == CANDLE_PATH:
            if self.candle_error:
                return 200, self.candle_error
            day = date.fromisoformat(body["fromdate"][:10])
            return 200, {
                "status": True,
                "data": [
                    [_iso(day, 17, 0), 10, 12, 9, 11, 5],
                    [_iso(day, 17, 1), 11, 13, 10, 12, 6],
                ],
            }
        if path == OI_PATH:
            if not self.oi_ok:
                return 200, {"status": False, "errorcode": "AB1012", "message": "not allowed"}
            day = date.fromisoformat(body["fromdate"][:10])
            return 200, {
                "status": True,
                "data": [{"time": _iso(day, 17, 0), "oi": 349200.0}],
            }
        raise AssertionError(path)


def _client(api):
    client = AngelMcxClient(
        Session("jwt", "key"), min_interval_s=0.0, post=api, master_loader=lambda: MASTER
    )
    client.bind_mcx([CE, PE, GAP])
    return client


def test_contracts_match_on_root_expiry_strike_and_side_and_only_on_mcx():
    client = _client(FakeApi())
    assert client.mcx == {CE.symbol: ("582912", 100), PE.symbol: ("583062", 100)}
    assert client.flags["CRUDEOIL"]["unmapped"] == 1  # the strike Angel One does not list


def test_oi_is_in_lots_to_match_fyers_and_the_candle_shape_is_kept():
    api = FakeApi()
    candles = _client(api).minute_candles_range(CE.symbol, SESSION, SESSION)
    assert [(c.open, c.volume, c.oi) for c in candles] == [(10, 5, 3492.0), (11, 6, None)]
    assert candles[0].epoch == int(datetime(2026, 11, 10, 17, 0, tzinfo=IST).timestamp())
    assert {p for p, _b in api.requests} == {CANDLE_PATH, OI_PATH}


def test_a_long_range_is_split_to_stay_under_the_row_cap():
    api = FakeApi()
    _client(api).minute_candles_range(CE.symbol, date(2026, 11, 1), date(2026, 11, 10))
    spans = [(b["fromdate"][:10], b["todate"][:10]) for p, b in api.requests if p == CANDLE_PATH]
    assert spans == [("2026-11-01", "2026-11-07"), ("2026-11-08", "2026-11-10")]
    assert CHUNK_DAYS == 7


def test_an_unmatched_contract_costs_no_request_and_gives_no_bars():
    api = FakeApi()
    assert _client(api).minute_candles_range(GAP.symbol, SESSION, SESSION) == []
    assert api.requests == []


def test_a_failed_oi_call_keeps_the_bars_and_counts_it():
    client = _client(FakeApi(oi_ok=False))
    candles = client.minute_candles_range(CE.symbol, SESSION, SESSION)
    assert len(candles) == 2 and all(c.oi is None for c in candles)
    assert client.flags["CRUDEOIL"]["oi_failed"] == 1


def test_a_rejected_session_stops_the_run_as_a_credentials_error():
    bad = {"status": False, "errorcode": "AG8002", "message": "Invalid Token"}
    with pytest.raises(AngelCredentialsError):
        _client(FakeApi(candle_error=bad)).minute_candles_range(CE.symbol, SESSION, SESSION)


def test_another_error_is_a_refused_contract_not_a_stop():
    other = {"status": False, "errorcode": "AB1004", "message": "Something went wrong"}
    with pytest.raises(RuntimeError):
        _client(FakeApi(candle_error=other)).minute_candles_range(CE.symbol, SESSION, SESSION)


# -- the collector's fallback rules -----------------------------------------------------------


def test_the_fallback_starts_after_the_last_stored_day_and_never_looks_back_past_the_cap():
    stored = date(2026, 11, 8)
    assert mcx_daily.request_start(SESSION, stored, inclusive=False, lookback=3) == date(
        2026, 11, 9
    )
    assert mcx_daily.request_start(SESSION, None, inclusive=False, lookback=3) == date(2026, 11, 8)
    assert (
        mcx_daily.request_start(SESSION, date(2026, 11, 10), inclusive=False, lookback=3) > SESSION
    )
    # Fyers' own rule keeps the last stored day, to complete a day stored part-way
    assert mcx_daily.request_start(SESSION, stored) == stored


def _master_text(contracts):
    def row(c):
        r = [""] * 20
        stamp = datetime(c.expiry.year, c.expiry.month, c.expiry.day, 12, tzinfo=IST)
        r[3], r[8], r[9], r[13] = "1", str(int(stamp.timestamp())), c.symbol, c.underlying
        r[15], r[16] = str(c.strike), c.option_type
        return ",".join(r)

    return "\n".join(row(c) for c in contracts)


@pytest.fixture
def root(tmp_path):
    with connect(tmp_path):
        pass
    return tmp_path


def _run(root, client, **kw):
    return mcx_daily.run(
        client,
        root,
        session=SESSION,
        roots=("CRUDEOIL",),
        wait=False,
        master_loader=lambda: _master_text([CE, PE]),
        log=lambda _m: None,
        **kw,
    )


def test_an_angel_pass_after_fyers_stored_the_session_asks_for_nothing_and_changes_nothing(root):
    from option_backtesting.fyers.client import Candle

    class FyersLike:
        calls = 0
        on_response = None

        def minute_candles_range(self, symbol, start, end):
            self.calls += 1
            return [
                Candle(int(datetime(2026, 11, 10, 17, 0, tzinfo=IST).timestamp()), 1, 2, 0, 1, 3, 4)
            ]

    _run(root, FyersLike())
    path = lake.bars_1m_path(root, "option", "CRUDEOIL", SESSION)
    before = path.read_bytes()
    api = FakeApi()
    out = _run(root, _client(api), source="angelone", inclusive=False, lookback=3)
    assert (
        api.requests == [] and out["status"] == "ok"
    )  # not "no_session": it skipped, not found shut
    assert out["roots"]["CRUDEOIL"]["skipped_already_stored"] == 2
    assert path.read_bytes() == before


def test_the_angel_run_is_recorded_under_its_own_source(root):
    api = FakeApi()
    _run(root, _client(api), source="angelone", inclusive=False, lookback=3)
    with connect(root, read_only=True, views=()) as con:
        rows = con.execute(
            "SELECT source, status FROM ingest_runs WHERE dataset = 'mcx_options_daily'"
        ).fetchall()
    assert rows == [("angelone", "ok")]
    # contracts the master lacked are counted, not failed: only CE and PE were asked for
    assert {b["symboltoken"] for p, b in api.requests if p == CANDLE_PATH} == {"582912", "583062"}


# -- regressions found while building the fallback ----------------------------------------------


def test_the_batch_is_written_even_when_the_last_contract_of_an_expiry_is_refused(root):
    from option_backtesting.fyers.client import Candle

    class LastRefused:
        calls = 0
        on_response = None

        def minute_candles_range(self, symbol, start, end):
            self.calls += 1
            if symbol == PE.symbol:
                raise RuntimeError(f"{symbol}: Invalid symbol provided")
            return [
                Candle(int(datetime(2026, 11, 10, 17, 0, tzinfo=IST).timestamp()), 1, 2, 0, 1, 3, 4)
            ]

    out = _run(root, LastRefused())
    assert out["roots"]["CRUDEOIL"]["errors"] == 1
    assert out["rows_written"] == 1  # the call-side bar was kept, not lost with the last refusal


def test_a_token_that_dies_mid_expiry_keeps_what_was_already_fetched(root):
    from option_backtesting.fyers.auth import FyersCredentialsError
    from option_backtesting.fyers.client import Candle

    class Dies:
        calls = 0
        on_response = None

        def minute_candles_range(self, symbol, start, end):
            self.calls += 1
            if symbol == PE.symbol:
                raise FyersCredentialsError("Fyers rejected the token: expired")
            return [
                Candle(int(datetime(2026, 11, 10, 17, 0, tzinfo=IST).timestamp()), 1, 2, 0, 1, 3, 4)
            ]

    with pytest.raises(FyersCredentialsError):
        _run(root, Dies())
    rows = lake.bars_1m_path(root, "option", "CRUDEOIL", SESSION)
    assert rows.exists()  # the first contract's bar reached the lake before the stop


def test_dry_run_never_logs_in_to_either_source(monkeypatch, tmp_path):
    """--dry-run with --source angelone once ran a real collection: no flag may reach a login."""
    from typer.testing import CliRunner

    from option_backtesting.angelone import check
    from option_backtesting.cli import app

    with connect(tmp_path):
        pass
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(mcx_daily, "download_master", lambda _segment: _master_text([CE, PE]))

    def no_login(*_a, **_k):
        raise AssertionError("a dry run logged in")

    monkeypatch.setattr(check, "session", no_login)
    for source in ("angelone", "fyers"):
        result = CliRunner().invoke(
            app,
            ["fyers", "mcx-daily", "--source", source, "--roots", "CRUDEOIL",
             "--session", "2026-11-10", "--no-wait", "--dry-run"],
        )  # fmt: skip
        assert result.exit_code == 0, result.output
        assert '"dry_run": true' in result.output and f'"source": "{source}"' in result.output
