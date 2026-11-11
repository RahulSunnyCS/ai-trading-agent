"""Nightly MCX collection from /data/history (BL-148 Phase 4): the session close by season, which
contracts, where a request starts, replace-own-rows writes, idempotence, the backfill's rows
untouched, a night with no session, and the failure classes. Fake client and master, no network."""

from datetime import date, datetime, timedelta, timezone

import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.fyers import mcx_daily
from option_backtesting.fyers.auth import FyersCredentialsError
from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.mcx_lake import register_contracts
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
SESSION = date(2026, 11, 11)
E1, E2, E3 = date(2026, 11, 17), date(2026, 12, 16), date(2027, 1, 15)


def _epoch(day: date, hour: int, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST).timestamp())


def _master_row(symbol: str, root: str, expiry: date, strike: float | None, kind: str) -> list:
    stamp = int(datetime(expiry.year, expiry.month, expiry.day, 12, tzinfo=IST).timestamp())
    row = [""] * 20
    row[3], row[8], row[9], row[13] = "1", str(stamp), symbol, root
    row[15], row[16] = ("" if strike is None else str(strike)), kind
    return row


def _master(rows: list[list]) -> str:
    return "\n".join(",".join(r) for r in rows)


def _contract(root: str, expiry: date, strike: float, kind: str) -> Contract:
    tag = {E1: "26NOV", E2: "26DEC", E3: "27JAN"}[expiry]
    return Contract(
        f"MCX:{root}{tag}{int(strike)}{kind}", root, expiry, strike, kind, 1
    )  # fmt: skip


MASTER_CONTRACTS = [
    _contract("CRUDEOIL", e, k, t) for e in (E1, E2, E3) for k in (8000, 8100) for t in ("CE", "PE")
] + [_contract("ZINC", E1, 410, "CE")]
FUTURE = ("MCX:CRUDEOIL26NOVFUT", "CRUDEOIL", E1, None, "FUT")
MASTER_TEXT = _master(
    [
        _master_row(c.symbol, c.underlying, c.expiry, c.strike, c.option_type)
        for c in MASTER_CONTRACTS
    ]
    + [_master_row(FUTURE[0], FUTURE[1], FUTURE[2], FUTURE[3], "XX")]
)


class FakeClient:
    """`minute_candles_range` answers one session bar (and one extra on earlier days) per
    contract, recording every request."""

    def __init__(self, bars=None, refuse=None, credentials=False):
        self.calls = 0
        self.requests: list[tuple[str, date, date]] = []
        self.on_response = None
        self.bars = bars
        self.refuse = refuse or set()
        self.credentials = credentials

    def minute_candles_range(self, symbol, start, end):
        self.calls += 1
        self.requests.append((symbol, start, end))
        if self.credentials:
            raise FyersCredentialsError("Fyers rejected the token: expired")
        if symbol in self.refuse:
            raise RuntimeError(f"{symbol}: Invalid symbol provided")
        if self.bars is not None:
            return self.bars(symbol, start, end)
        days = [start, end] if start != end else [end]
        return [
            Candle(_epoch(d, 9, 0), 10, 12, 9, 11, 5, 100) for d in days
        ]  # one bar a day asked about


@pytest.fixture
def root(tmp_path):
    with connect(tmp_path):
        pass
    return tmp_path


def _run(root, client, **kw):
    return mcx_daily.run(
        client,
        root,
        session=kw.pop("session", SESSION),
        roots=kw.pop("roots", ("CRUDEOIL",)),
        wait=kw.pop("wait", False),
        master_loader=lambda: MASTER_TEXT,
        log=lambda _m: None,
        **kw,
    )


def _rows(root, name, day):
    path = lake.bars_1m_path(root, "option", name, day)
    return pq.read_table(path).to_pylist() if path.exists() else []


# -- session and close -----------------------------------------------------------------------


def test_after_midnight_the_session_is_still_yesterdays():
    assert mcx_daily.default_session(datetime(2026, 11, 12, 0, 20, tzinfo=IST)) == SESSION
    assert mcx_daily.default_session(datetime(2026, 11, 11, 23, 40, tzinfo=IST)) == SESSION
    assert mcx_daily.default_session(datetime(2026, 11, 11, 9, 0, tzinfo=IST)) == SESSION


class _Clock:
    def __init__(self, hour, minute):
        self.t = datetime(2026, 11, 11, hour, minute, tzinfo=IST)
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.t += timedelta(seconds=seconds)


def _wait(clock, last_bar):
    return mcx_daily.wait_for_close(
        SESSION, now=clock.now, sleep=clock.sleep, last_bar=last_bar, log=lambda _m: None
    )


def _bar(hour, minute):
    return lambda: datetime(2026, 11, 11, hour, minute, tzinfo=IST)


def test_a_session_whose_future_stopped_at_23_29_has_closed_so_nothing_more_is_waited_for():
    clock = _Clock(23, 31)
    assert _wait(clock, _bar(23, 29)) == 0.0 and clock.slept == []  # the summer close


def test_a_future_still_trading_at_23_31_waits_on_to_23_56():
    clock = _Clock(23, 31)
    assert _wait(clock, _bar(23, 30)) == 25 * 60  # the winter close: 23:55 + a minute
    assert clock.t == datetime(2026, 11, 11, 23, 56, tzinfo=IST) and all(
        s <= 60 for s in clock.slept
    )


def test_before_23_31_it_first_waits_to_23_31_and_then_looks():
    clock = _Clock(21, 0)
    looked = []

    def last_bar():
        looked.append(clock.t)
        return datetime(2026, 11, 11, 23, 29, tzinfo=IST)

    _wait(clock, last_bar)
    assert looked == [datetime(2026, 11, 11, 23, 31, tzinfo=IST)]


def test_without_a_probe_the_angel_one_path_waits_to_the_latest_close():
    clock = _Clock(23, 31)
    assert _wait(clock, None) == 25 * 60


def test_a_session_already_past_waits_for_nothing_and_asks_nothing():
    clock = _Clock(23, 57)

    def boom():
        raise AssertionError("probed a finished session")

    assert _wait(clock, boom) == 0.0
    late = _Clock(0, 20)  # after midnight the evening's session (yesterday's) has long ended
    late.t += timedelta(days=1)
    assert mcx_daily.wait_for_close(SESSION, now=late.now, sleep=late.sleep, last_bar=boom) == 0.0


def test_the_future_probe_asks_the_nearest_future_and_reports_its_last_bar(root):
    client = FakeClient(
        bars=lambda symbol, *_a: [Candle(_epoch(SESSION, 23, 54), 1, 1, 1, 1, 0, 1)]
    )
    master = mcx_daily.parse_master(MASTER_TEXT, {"CRUDEOIL"})
    probe = mcx_daily.future_last_bar(client, master, ("CRUDEOIL",), SESSION)
    assert probe() == datetime(2026, 11, 11, 23, 54, tzinfo=IST)
    assert [r[0] for r in client.requests] == ["MCX:CRUDEOIL26NOVFUT"]


# -- which contracts and where a request starts -----------------------------------------------


def test_nearest_two_expiries_every_strike_and_the_expiring_first():
    contracts = mcx_daily.parse_master(MASTER_TEXT, {"CRUDEOIL", "ZINC"})
    chosen = mcx_daily.select_contracts(contracts, ("CRUDEOIL", "ZINC"), SESSION)
    crude = chosen["CRUDEOIL"]
    assert {c.expiry for c in crude} == {E1, E2} and len(crude) == 8  # no futures, no Jan
    assert crude[0].expiry == E1 and crude[-1].expiry == E2
    assert [c.expiry for c in chosen["ZINC"]] == [E1]


def test_a_contract_expiring_today_is_still_collected_and_one_expired_yesterday_is_not():
    contracts = mcx_daily.parse_master(MASTER_TEXT, {"CRUDEOIL"})
    on_expiry = mcx_daily.select_contracts(contracts, ("CRUDEOIL",), E1)["CRUDEOIL"]
    assert on_expiry[0].expiry == E1
    after = mcx_daily.select_contracts(contracts, ("CRUDEOIL",), E1 + timedelta(days=1))
    assert {c.expiry for c in after["CRUDEOIL"]} == {E2, E3}


def test_a_request_starts_at_the_last_stored_day_else_a_whole_window_back():
    assert mcx_daily.request_start(SESSION, date(2026, 11, 9)) == date(2026, 11, 9)
    assert mcx_daily.request_start(SESSION, None) == SESSION - timedelta(days=99)
    # never before the start of the history
    assert mcx_daily.request_start(date(2024, 11, 1), None) == date(2024, 10, 21)
    # a stored day older than one request reaches is not asked for past the window
    assert mcx_daily.request_start(SESSION, date(2026, 1, 1)) == SESSION - timedelta(days=99)


# -- the run ----------------------------------------------------------------------------------


def test_first_run_fills_each_contract_back_one_window_and_stores_bars_with_oi(root):
    client = FakeClient()
    out = _run(root, client)
    assert out["status"] == "ok" and out["roots"]["CRUDEOIL"]["contracts"] == 8
    assert {r[1] for r in client.requests} == {SESSION - timedelta(days=99)}
    assert {r[2] for r in client.requests} == {SESSION}
    rows = _rows(root, "CRUDEOIL", SESSION)
    assert len(rows) == 8 and all(r["oi"] == 100.0 for r in rows)
    assert {r["vendor_symbol"] for r in rows} >= {"MCX:CRUDEOIL26NOV8000CE"}
    assert _rows(root, "CRUDEOIL", SESSION - timedelta(days=99))  # an older day was stored too
    assert lake.symbol_master_path(root, "fyers-mcx", SESSION).exists()


def test_a_rerun_changes_no_row_and_the_second_night_asks_from_the_last_stored_day(root):
    _run(root, FakeClient())
    before = _rows(root, "CRUDEOIL", SESSION)
    second = FakeClient()
    _run(root, second)
    assert _rows(root, "CRUDEOIL", SESSION) == before
    assert {r[1] for r in second.requests} == {SESSION}  # the last stored day, kept


def test_the_next_night_adds_only_its_own_day(root):
    _run(root, FakeClient())
    day2 = SESSION + timedelta(days=1)
    _run(root, FakeClient(), session=day2)
    assert len(_rows(root, "CRUDEOIL", day2)) == 8
    assert len(_rows(root, "CRUDEOIL", SESSION)) == 8  # yesterday untouched


def test_it_replaces_its_own_contracts_rows_and_keeps_every_other_instrument(root):
    contracts = mcx_daily.select_contracts(
        mcx_daily.parse_master(MASTER_TEXT, {"CRUDEOIL"}), ("CRUDEOIL",), SESSION
    )["CRUDEOIL"]
    expired = Contract("MCX:CRUDEOIL26OCT7000CE", "CRUDEOIL", date(2026, 10, 15), 7000.0, "CE", 1)
    ids = register_contracts(root, [expired, *contracts])
    # the backfill's row for an expired contract, on the same day file
    old = mcx_daily.options_table(
        [(expired, ids[expired.symbol], [Candle(_epoch(SESSION, 9, 0), 1, 1, 1, 1, 1, 7)])]
    )
    mcx_daily.merge_day(lake.bars_1m_path(root, "option", "CRUDEOIL", SESSION), old)
    # a partial earlier bar of a live contract, which the run must replace
    live = next(c for c in contracts if c.expiry == E1)
    part = mcx_daily.options_table(
        [(live, ids[live.symbol], [Candle(_epoch(SESSION, 9, 0), 99, 99, 99, 99, 1, 1)])]
    )
    mcx_daily.merge_day(lake.bars_1m_path(root, "option", "CRUDEOIL", SESSION), part)

    _run(root, FakeClient())
    rows = _rows(root, "CRUDEOIL", SESSION)
    by_symbol = {r["vendor_symbol"]: r for r in rows}
    assert by_symbol[expired.symbol]["oi"] == 7.0  # untouched
    assert by_symbol[live.symbol]["close"] == 11.0  # replaced
    keys = [(r["instrument_id"], r["ts"]) for r in rows]
    assert keys == sorted(keys) and len(keys) == len(set(keys))  # sorted, no repeated minute


def test_a_night_with_no_bars_and_no_errors_is_no_session(root):
    out = _run(root, FakeClient(bars=lambda *_a: []))
    assert out["status"] == "no_session" and out["rows_written"] == 0
    assert not _rows(root, "CRUDEOIL", SESSION)


def test_a_refused_symbol_alone_leaves_the_rest_stored_as_partial(root):
    victim = "MCX:CRUDEOIL26NOV8000CE"
    many = [
        Contract(f"MCX:CRUDEOIL26NOV{s}CE", "CRUDEOIL", E1, float(s), "CE", 1)
        for s in range(7000, 7040)
    ] + [
        Contract(f"MCX:CRUDEOIL26NOV{s}PE", "CRUDEOIL", E1, float(s), "PE", 1)
        for s in range(7000, 7040)
    ]
    text = _master(
        [_master_row(c.symbol, "CRUDEOIL", c.expiry, c.strike, c.option_type) for c in many]
    )
    client = FakeClient(refuse={many[3].symbol})
    out = mcx_daily.run(
        client, root, session=SESSION, roots=("CRUDEOIL",), wait=False,
        master_loader=lambda: text, log=lambda _m: None,
    )  # fmt: skip
    assert out["status"] == "partial" and out["roots"]["CRUDEOIL"]["errors"] == 1
    assert len(_rows(root, "CRUDEOIL", SESSION)) == 79 and victim not in {
        r["vendor_symbol"] for r in _rows(root, "CRUDEOIL", SESSION)
    }


def test_many_failed_requests_fail_the_run(root):
    refuse = {c.symbol for c in MASTER_CONTRACTS if c.expiry in (E1, E2)}
    out = _run(root, FakeClient(refuse=refuse))
    assert out["status"] == "failed"


def test_a_rejected_token_stops_the_run_for_the_collector_to_report(root):
    with pytest.raises(FyersCredentialsError):
        _run(root, FakeClient(credentials=True))
    # the run is recorded as failed, and nothing reached the lake
    assert not _rows(root, "CRUDEOIL", SESSION)
    with connect(root, read_only=True, views=()) as con:
        status = con.execute(
            "SELECT status FROM ingest_runs WHERE dataset = 'mcx_options_daily'"
        ).fetchall()
    assert status == [("failed",)]


def test_dry_run_asks_nothing_and_reports_the_plan(root):
    client = FakeClient()
    out = _run(root, client, dry_run=True)
    assert out["status"] == "dry_run" and client.requests == []
    assert out["roots"]["CRUDEOIL"] == {
        "contracts": 8,
        "expiries": [E1.isoformat(), E2.isoformat()],
    }


def test_the_run_records_one_ingest_row_and_judges_the_day(root):
    _run(root, FakeClient())
    with connect(root, read_only=True, views=()) as con:
        runs = con.execute(
            "SELECT source, status, requests, rows_written FROM ingest_runs "
            "WHERE dataset = 'mcx_options_daily'"
        ).fetchall()
        judged = con.execute(
            "SELECT count(*) FROM data_quality WHERE asset = 'option' AND name = 'CRUDEOIL'"
        ).fetchone()[0]
    assert runs == [("fyers", "ok", 8, 16)] and judged >= 1


# -- what each outcome is called (review findings on PR 446) ------------------------------------


def test_an_expiring_contract_that_is_refused_fails_the_run_because_tomorrow_is_too_late(root):
    contracts = mcx_daily.select_contracts(
        mcx_daily.parse_master(MASTER_TEXT, {"CRUDEOIL"}), ("CRUDEOIL",), E1
    )["CRUDEOIL"]
    expiring = next(c for c in contracts if c.expiry == E1)
    out = _run(root, FakeClient(refuse={expiring.symbol}), session=E1)  # E1 expires that day
    assert out["status"] == "failed" and "expiring" in out["reason"]
    assert out["roots"]["CRUDEOIL"]["errors_on_expiring"] == 1


def test_a_refusal_of_a_contract_expiring_later_stays_partial_within_the_share(root):
    n = 41
    contracts = [
        Contract(f"MCX:CRUDEOIL26DEC{s}CE", "CRUDEOIL", E2, float(s), "CE", 1)
        for s in range(7000, 7000 + n)
    ]
    text = _master(
        [_master_row(c.symbol, "CRUDEOIL", c.expiry, c.strike, c.option_type) for c in contracts]
    )
    out = mcx_daily.run(
        FakeClient(refuse={contracts[0].symbol}), root, session=SESSION, roots=("CRUDEOIL",),
        wait=False, master_loader=lambda: text, log=lambda _m: None,
    )  # fmt: skip
    assert out["status"] == "partial" and out["roots"]["CRUDEOIL"]["errors_on_expiring"] == 0


def test_options_that_answer_nothing_on_a_day_the_futures_traded_is_a_failure_not_no_session(root):
    def bars(symbol, start, end):
        if symbol.endswith("FUT"):
            return [Candle(_epoch(SESSION, 23, 54), 1, 1, 1, 1, 0, 1)]
        return []

    out = _run(root, FakeClient(bars=bars))
    assert out["status"] == "failed" and "futures traded" in out["reason"]


def test_a_day_the_exchange_was_shut_is_no_session_when_the_futures_have_no_bars_either(root):
    assert _run(root, FakeClient(bars=lambda *_a: []))["status"] == "no_session"


def test_the_raw_responses_of_an_aborted_run_are_still_archived(root):
    class Dies(FakeClient):
        def minute_candles_range(self, symbol, start, end):
            candles = super().minute_candles_range(symbol, start, end)
            self.on_response(symbol, {"symbol": symbol}, {"s": "ok", "candles": []})
            if symbol.endswith("8000PE"):
                raise FyersCredentialsError("Fyers rejected the token: expired")
            return candles

    with pytest.raises(FyersCredentialsError):
        _run(root, Dies())
    archived = list((root / "raw" / "fyers" / f"date={SESSION}").glob("mcx-CRUDEOIL-*.jsonl.gz"))
    assert archived  # the buffered responses were written before the run stopped
