"""The expired-option repair against a fake Fyers client: planning only the missing days,
resumable raw cache, clean stop at a request budget or a rate limit, a day merged only with
all its expiries, refused contracts skipped, merge that never overwrites, the by-name candle
parser, and the client's per-minute throttle and 429 stop. No network."""

import gzip
import io
import json
import urllib.error
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers import client as client_module
from option_backtesting.fyers import expired
from option_backtesting.fyers.auth import Credentials, FyersCredentialsError
from option_backtesting.fyers.client import FyersClient, RateLimitedError, response_state
from option_backtesting.fyers.daily import options_table
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
HEALTHY = date(2026, 9, 15)
GAP = [date(2026, 9, 16), date(2026, 9, 17), date(2026, 9, 18)]
WEEKLY = date(2026, 9, 22)
MONTHLY = date(2026, 9, 29)
LATER = date(2026, 10, 6)
LATE_DAY = date(2026, 9, 23)  # needs MONTHLY and LATER; the GAP days need WEEKLY and MONTHLY
SYMBOLS = {
    WEEKLY: [f"NSE:NIFTY2692222{k}{t}" for k in ("000", "050") for t in ("CE", "PE")],
    MONTHLY: [f"NSE:NIFTY26SEP22{k}{t}" for k in ("000", "050") for t in ("CE", "PE")],
    LATER: [f"NSE:NIFTY26O0622{k}{t}" for k in ("000", "050") for t in ("CE", "PE")],
}


def _epoch(day: date, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, 9, 15 + minute, tzinfo=IST).timestamp())


class FakeClient:
    """`answers` maps a symbol to what its next requests give before the normal answer: an
    exception to raise, an error body to return, or None for the normal answer, one per
    request. `extra` adds symbols to an expiry's listing."""

    columns = ["timestamp", "open", "high", "low", "close", "volume", "open_interest"]

    def __init__(self, expiries=(WEEKLY, MONTHLY), answers=None, extra=None):
        self.calls = 0
        self.history_calls = 0
        self.expiries = list(expiries)
        self.answers = {k: list(v) for k, v in (answers or {}).items()}
        self.asked: list[str] = []
        self.extra = extra or {}

    def expired_expiries(self, symbol, start, end):
        self.calls += 1
        return [e for e in self.expiries if start <= e <= end]

    def expired_contracts(self, symbol, expiry):
        self.calls += 1
        return list(SYMBOLS[expiry]) + list(self.extra.get(expiry, []))

    def expired_history_response(self, symbol, start, end):
        self.calls += 1
        self.history_calls += 1
        self.asked.append(symbol)
        params = {"symbol": symbol, "range_from": start.isoformat(), "range_to": end.isoformat()}
        answer = self.answers[symbol].pop(0) if self.answers.get(symbol) else None
        if isinstance(answer, BaseException):
            raise answer
        if answer is not None:
            return answer, params
        rows, d = [], start
        while d <= end:
            if d.weekday() < 5:
                rows += [[_epoch(d, m), 10, 12, 9, 11, 5, 100] for m in range(3)]
            d += timedelta(days=1)
        return {"s": "ok", "columns": self.columns, "candles": rows}, params

    candles_from_response = staticmethod(FyersClient.candles_from_response)


def _index_partition(root, day):
    t = pa.table(
        {
            "instrument_id": [1],
            "ts": pa.array([_epoch(day, 0)], pa.int64()).cast(pa.timestamp("s")),
            "open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0],
            "volume": [0.0], "oi": [0.0], "vendor_symbol": ["NSE:NIFTY50-INDEX"],
        }
    )  # fmt: skip
    t = t.set_column(1, "ts", t["ts"].cast(lake.TS_TYPE))
    lake.write_parquet(t.cast(lake.BAR_SCHEMA), lake.bars_1m_path(root, "index", "NIFTY", day))


def _contract(symbol="NSE:NIFTY2692222000CE", expiry=WEEKLY):
    return Contract(symbol, "NIFTY", expiry, 22000.0, "CE", 65)


@pytest.fixture
def root(tmp_path, monkeypatch):
    root = tmp_path / "data"
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    for day in [HEALTHY, *GAP]:
        _index_partition(root, day)
    # a healthy day: the repair must not request it
    lake.write_parquet(
        options_table([(_contract(), 7, [_candle(HEALTHY)])]),
        lake.bars_1m_path(root, "option", "NIFTY", HEALTHY),
    )
    return root


@pytest.fixture(autouse=True)
def judged(monkeypatch):
    """The verdict and derived rebuilds a run asked for: (what, name, days, force_days)."""
    calls = []
    monkeypatch.setattr(
        expired.quality,
        "rebuild",
        lambda root, **k: calls.append(("quality", k["name"], k["days"], None)),
    )
    monkeypatch.setattr(
        expired.derived,
        "rebuild",
        lambda root, names, **k: calls.append(
            ("derived", names[0], k["days"], set(k.get("force_days", ())))
        ),
    )
    return calls


def _candle(day, minute=0, close=11.0):
    from option_backtesting.fyers.client import Candle

    return Candle(_epoch(day, minute), 10, 12, 9, close, 5, 100)


def test_decodes_weekly_and_monthly_symbols_and_refuses_the_rest():
    ref = default_reference_data()
    w = expired._contract("NSE:NIFTY2692222050PE", "NIFTY", WEEKLY, ref)
    assert (w.strike, w.option_type, w.expiry) == (22050.0, "PE", WEEKLY)
    m = expired._contract("NSE:NIFTY26SEP22000CE", "NIFTY", MONTHLY, ref)
    assert (m.strike, m.option_type) == (22000.0, "CE")
    with pytest.raises(ValueError):
        expired._contract("NSE:NIFTY26SEPFUT", "NIFTY", MONTHLY, ref)
    with pytest.raises(ValueError):
        expired._contract("NSE:BANKNIFTY26SEP50000CE", "NIFTY", MONTHLY, ref)


def test_candles_are_read_by_column_name_and_extra_columns_are_ignored():
    body = {
        "columns": ["timestamp", "volume", "close", "open", "low", "high", "iv", "open_interest"],
        "candles": [
            [100, 7, 4.0, 1.0, 0.5, 5.0, 17.8, 90],
            [160, 8, 4.5, 4.0, 3.5, 5.0, None, None],
        ],
    }
    a, b = FyersClient.candles_from_response(body)
    assert (a.open, a.high, a.low, a.close, a.volume, a.oi) == (1.0, 5.0, 0.5, 4.0, 7.0, 90.0)
    assert b.oi is None
    with pytest.raises(RuntimeError):
        FyersClient.candles_from_response({"columns": ["timestamp", "open"], "candles": []})
    # the live History API names no columns: positional, oi optional
    [c] = FyersClient.candles_from_response({"candles": [[100, 1, 2, 0.5, 1.5, 9]]})
    assert (c.close, c.volume, c.oi) == (1.5, 9.0, None)


def test_plan_covers_only_days_without_an_option_file_and_downloads_nothing(root):
    client = FakeClient()
    out = expired.run_backfill(
        client, root, ["NIFTY"], HEALTHY, GAP[-1], plan_only=True, log=lambda _: None
    )
    assert out["underlyings"]["NIFTY"]["days"] == 3  # not the healthy 15 Sep
    assert out["history_requests"] == 8 and client.history_calls == 0
    every = expired.run_backfill(
        client, root, ["NIFTY"], HEALTHY, GAP[-1], plan_only=True, missing_only=False,
        log=lambda _: None,
    )  # fmt: skip
    assert every["underlyings"]["NIFTY"]["days"] == 4


def test_backfill_fills_gap_days_and_a_rerun_costs_nothing(root):
    client = FakeClient()
    out = expired.run_backfill(client, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out["fetched"] == 8 and out["stopped"] is None
    for day in GAP:
        table = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", day))
        assert table.num_rows > 0 and set(table["oi"].to_pylist()) == {100.0}
        assert len(set(table["instrument_id"].to_pylist())) == 8  # 4 weekly + 4 monthly
    # day with data now exists, so nothing is planned: zero requests, zero rows
    again = FakeClient()
    out2 = expired.run_backfill(again, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out2["fetched"] == 0 and out2["rows_added"] == 0 and again.history_calls == 0


def test_request_budget_stops_cleanly_and_the_next_run_resumes_from_the_cache(root):
    first = FakeClient()
    out = expired.run_backfill(
        first, root, ["NIFTY"], GAP[0], GAP[-1], max_requests=3, log=lambda _: None
    )
    assert out["stopped"] == "max_requests" and out["fetched"] == 3
    for day in GAP:  # an unfinished expiry is never half-merged
        assert not lake.bars_1m_path(root, "option", "NIFTY", day).exists()
    second = FakeClient()
    out2 = expired.run_backfill(second, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out2["cached"] == 3 and out2["fetched"] == 5  # 8 contracts in all, 3 not repeated
    assert lake.bars_1m_path(root, "option", "NIFTY", GAP[0]).exists()


def test_a_cached_response_for_a_narrower_window_is_not_reused(root, tmp_path):
    path = expired._cache_path(root, "NIFTY", WEEKLY, "NSE:NIFTY2692222000CE")
    expired._write_cache(
        path, "x", {"range_from": "2026-09-17", "range_to": "2026-09-18"}, {"s": "no_data"}
    )
    assert expired._read_cache(path, date(2026, 9, 17), date(2026, 9, 18)) == {"s": "no_data"}
    assert expired._read_cache(path, date(2026, 9, 16), date(2026, 9, 18)) is None
    with gzip.open(path, "wt") as fh:  # a record from before params were stored
        json.dump({"response": {"s": "ok"}}, fh)
    assert expired._read_cache(path, date(2026, 9, 17), date(2026, 9, 18)) is None


def test_merge_keeps_existing_rows_and_adds_only_missing_minutes(root):
    path = lake.bars_1m_path(root, "option", "NIFTY", GAP[0])
    old = options_table([(_contract(), 7, [_candle(GAP[0], 0, close=11.0)])])
    lake.write_parquet(old, path)
    fresh = options_table(
        [(_contract(), 7, [_candle(GAP[0], 0, close=99.0), _candle(GAP[0], 1, close=12.0)])]
    )
    added, preserved = expired.merge_option_partition(path, fresh)
    assert (added, preserved) == (1, 1)
    merged = pq.read_table(path).sort_by("ts")
    assert merged["close"].to_pylist() == [11.0, 12.0]  # the existing price won
    again, _ = expired.merge_option_partition(path, fresh)
    assert again == 0


def _run(client, root, end=GAP[-1], **kw):
    return expired.run_backfill(client, root, ["NIFTY"], GAP[0], end, log=lambda _: None, **kw)


def _instruments(root, day):
    path = lake.bars_1m_path(root, "option", "NIFTY", day)
    return len(set(pq.read_table(path)["instrument_id"].to_pylist())) if path.exists() else 0


def _runs(root):
    with connect(root, read_only=True, views=()) as con:
        return con.execute(
            "SELECT source, status, errors FROM ingest_runs ORDER BY started_at"
        ).fetchall()


def test_a_stop_after_the_first_expiry_merges_no_day_and_the_rerun_completes_it(root):
    # each gap day needs the weekly AND the monthly: the budget runs out after the weekly
    first = FakeClient()
    out = _run(first, root, max_requests=4)
    assert out["stopped"] == "max_requests" and out["fetched"] == 4
    assert out["pending_days"] == {"NIFTY": [d.isoformat() for d in GAP]}
    for day in GAP:  # no day got a file with the weekly alone, so none is skipped next time
        assert not lake.bars_1m_path(root, "option", "NIFTY", day).exists()
    second = FakeClient()
    out2 = _run(second, root)
    assert (out2["cached"], out2["fetched"], out2["stopped"]) == (4, 4, None)
    assert all(_instruments(root, day) == 8 for day in GAP)  # 4 weekly + 4 monthly


def test_only_expiry_merges_a_day_once_its_other_expiries_are_in_the_cache(root):
    out = _run(FakeClient(), root, only_expiry=WEEKLY)
    assert out["fetched"] == 4 and out["touched_days"] == {}
    assert out["pending_days"] == {"NIFTY": [d.isoformat() for d in GAP]}
    again = FakeClient()
    out2 = _run(again, root, only_expiry=MONTHLY)
    assert out2["fetched"] == 4 and again.asked == SYMBOLS[MONTHLY]
    assert all(_instruments(root, day) == 8 for day in GAP)


def test_a_rate_limit_stops_cleanly_judges_the_merged_days_and_a_rerun_resumes(root, judged):
    _index_partition(root, LATE_DAY)
    limited = FakeClient(
        expiries=(WEEKLY, MONTHLY, LATER),
        answers={SYMBOLS[LATER][1]: [RateLimitedError("Fyers rate-limited 2 times")]},
    )
    out = _run(limited, root, end=LATE_DAY)
    assert out["stopped"] == "rate_limited" and out["fetched"] == 9  # 4 + 4 + the first LATER
    assert all(_instruments(root, day) == 8 for day in GAP)  # complete before the stop
    assert _instruments(root, LATE_DAY) == 0 and out["pending_days"] == {"NIFTY": ["2026-09-23"]}
    assert ("quality", "NIFTY", (GAP[0], GAP[-1]), None) in judged
    assert ("derived", "NIFTY", (GAP[0], GAP[-1]), set(GAP)) in judged
    assert _runs(root)[-1] == ("fyers-expired", "partial", 1)

    resumed = FakeClient(expiries=(WEEKLY, MONTHLY, LATER))
    out2 = _run(resumed, root, end=LATE_DAY)  # plans 23 Sep only
    assert (out2["fetched"], out2["cached"]) == (3, 5)  # the monthly and 1 LATER were cached
    assert _instruments(root, LATE_DAY) == 8 and out2["stopped"] is None


@pytest.mark.parametrize(
    ("body", "stopped"),
    [
        ({"s": "error", "message": "Request limit reached", "_http_status": 429}, "rate_limited"),
        ({"s": "error", "message": "Invalid access token"}, "credentials"),
        ({"s": "error", "message": "You are not subscribed to this API"}, "blocked"),
        ({"s": "error", "message": "HTTP 403", "_http_status": 403}, "blocked"),
    ],
)
def test_a_rate_limit_rejected_token_or_no_access_stops_without_caching_it(root, body, stopped):
    symbol = SYMBOLS[MONTHLY][0]
    out = _run(FakeClient(answers={symbol: [body]}), root)
    assert out["stopped"] == stopped
    assert not expired._cache_path(root, "NIFTY", MONTHLY, symbol).exists()
    assert out["touched_days"] == {}


def test_an_unexpected_error_still_judges_the_days_merged_before_it(root, judged):
    _index_partition(root, LATE_DAY)
    broken = FakeClient(
        expiries=(WEEKLY, MONTHLY, LATER), answers={SYMBOLS[LATER][0]: [OSError("disk gone")]}
    )
    with pytest.raises(OSError):
        _run(broken, root, end=LATE_DAY)
    assert ("quality", "NIFTY", (GAP[0], GAP[-1]), None) in judged
    assert _runs(root)[-1][:2] == ("fyers-expired", "failed")


def test_a_refused_contract_is_recorded_and_skipped_and_never_asked_again(root):
    refused = SYMBOLS[WEEKLY][2]
    body = {"s": "error", "code": -300, "message": "Invalid symbol provided"}
    out = _run(FakeClient(answers={refused: [body]}), root)
    assert out["stopped"] is None and out["fetched"] == 8
    assert [f["symbol"] for f in out["failed_contracts"]] == [refused]
    assert all(_instruments(root, day) == 7 for day in GAP)  # merged without it
    # the refusal is cached: a top-up run re-reads it and asks Fyers nothing
    again = FakeClient()
    out2 = _run(again, root, missing_only=False)
    assert again.history_calls == 0 and out2["failed_contracts"][0]["cached"] is True
    assert _runs(root)[-1] == ("fyers-expired", "ok", 0)


def test_a_retryable_failure_is_not_cached_and_its_days_wait_for_the_rerun(root):
    flaky = SYMBOLS[MONTHLY][3]
    out = _run(FakeClient(answers={flaky: [{"s": "error", "message": "network: timed out"}]}), root)
    assert out["stopped"] is None and [f["symbol"] for f in out["retryable_failures"]] == [flaky]
    assert out["touched_days"] == {} and len(out["pending_days"]["NIFTY"]) == 3
    again = FakeClient()
    out2 = _run(again, root)
    assert again.asked == [flaky] and all(_instruments(root, day) == 8 for day in GAP)
    assert out2["retryable_failures"] == []


def test_repeated_retryable_failures_stop_the_run(root):
    down = {"s": "error", "message": "HTTP 503", "_http_status": 503}
    symbols = SYMBOLS[WEEKLY]
    out = _run(FakeClient(answers={s: [down] for s in symbols}), root)
    assert out["stopped"] == "retryable" and out["fetched"] == expired.RETRYABLE_STREAK


def test_a_top_up_forces_the_derived_rebuild_of_the_days_it_changed(root, judged):
    _run(FakeClient(), root)
    judged.clear()
    # a thin day: drop one contract's rows, then top it up
    path = lake.bars_1m_path(root, "option", "NIFTY", GAP[1])
    table = pq.read_table(path).cast(lake.OPT_SCHEMA)
    first = table["instrument_id"][0].as_py()
    lake.write_parquet(table.filter(pa.compute.not_equal(table["instrument_id"], first)), path)
    out = _run(FakeClient(), root, missing_only=False)
    assert out["fetched"] == 0 and out["rows_added"] == 3  # its 3 minutes, from the cache
    assert out["touched_days"] == {"NIFTY": 1}
    assert ("derived", "NIFTY", (GAP[1], GAP[1]), {GAP[1]}) in judged


def test_days_that_may_need_an_unexpired_expiry_are_reported():
    # weekly cadence: two later weeklies and the month's monthly must be provably listed
    sep, oct_ = [date(2026, 9, d) for d in (22, 29)], [date(2026, 10, d) for d in (6, 13)]
    assert not expired._may_be_short(sep + oct_, date(2026, 9, 16), "weekly", date(2026, 10, 21))
    # the listing ends 30 Sep: September's monthly is known, but only one weekly is left
    assert expired._may_be_short(sep, date(2026, 9, 23), "weekly", date(2026, 9, 30))
    # two weeklies, but nothing past September yet: is 29 Sep the monthly? unknown
    assert expired._may_be_short(sep, date(2026, 9, 16), "weekly", date(2026, 9, 29))
    # on the monthly expiry day the next month's monthly is wanted too
    assert expired._may_be_short(sep + oct_, date(2026, 9, 29), "weekly", date(2026, 10, 21))
    assert expired._may_be_short([date(2026, 9, 29)], date(2026, 9, 29), "monthly", date.max)
    assert not expired._may_be_short(sep, date(2026, 9, 23), "monthly", date(2026, 9, 30))


def test_the_plan_lists_days_short_of_an_unexpired_expiry(root):
    # run on 23 Sep: the listing ends 22 Sep, so 29 Sep (still trading) is not in it
    plan = expired.build_plan(
        FakeClient(expiries=(WEEKLY, MONTHLY)), root, "NIFTY", GAP[0], GAP[-1],
        today=date(2026, 9, 23),
    )  # fmt: skip
    assert plan.short_days == tuple(GAP)
    assert [e.expiry for e in plan.expiries] == [WEEKLY]  # what can be repaired still is


REFUSED = {"s": "error", "code": -300, "message": "Invalid symbol provided"}


NO_DATA = {"s": "error", "message": "No data found", "_http_status": 400}


def test_a_run_of_refusals_stops_when_a_good_contract_is_refused_too(root, monkeypatch):
    monkeypatch.setattr(expired, "REFUSAL_STREAK", 3)
    good, refused = SYMBOLS[WEEKLY][-1], SYMBOLS[MONTHLY][:3]
    answers = {s: [REFUSED] for s in refused} | {good: [None, REFUSED]}
    out = _run(FakeClient(answers=answers), root)
    assert out["stopped"] == "refused_streak" and out["failed_contracts"] == []
    assert [f["symbol"] for f in out["retryable_failures"]] == refused
    assert not any(expired._cache_path(root, "NIFTY", MONTHLY, s).exists() for s in refused)
    assert out["touched_days"] == {}


def test_a_run_of_refusals_is_kept_when_a_good_contract_still_answers(root, monkeypatch):
    monkeypatch.setattr(expired, "REFUSAL_STREAK", 3)
    refused = SYMBOLS[MONTHLY][:3]
    client = FakeClient(answers={s: [NO_DATA] for s in refused})
    out = _run(client, root)
    assert out["stopped"] is None and client.asked[7] == SYMBOLS[WEEKLY][-1]  # asked again
    assert [f["symbol"] for f in out["failed_contracts"]] == refused
    assert all(_instruments(root, day) == 5 for day in GAP)


def test_neighbouring_no_data_refusals_before_any_answer_do_not_stall_reruns(root, monkeypatch):
    # the first contracts of a first run: nothing has answered yet to ask again
    monkeypatch.setattr(expired, "REFUSAL_STREAK", 3)
    refused = SYMBOLS[WEEKLY][:3]
    out = _run(FakeClient(answers={s: [NO_DATA] for s in refused}), root)
    assert out["stopped"] is None and len(out["failed_contracts"]) == 3  # kept at the answer
    assert all(_instruments(root, day) == 5 for day in GAP)
    again = FakeClient()  # a rerun has nothing left to ask
    assert _run(again, root, missing_only=False)["stopped"] is None
    assert again.history_calls == 0


def test_refusals_with_no_answer_at_all_stop_at_the_limit(root, monkeypatch):
    monkeypatch.setattr(expired, "REFUSAL_STREAK", 2)
    monkeypatch.setattr(expired, "UNCONFIRMED_LIMIT", 3)
    refused = SYMBOLS[WEEKLY][:3]
    out = _run(FakeClient(answers={s: [REFUSED] for s in refused}), root)
    assert out["stopped"] == "refused_streak" and out["failed_contracts"] == []
    assert not any(expired._cache_path(root, "NIFTY", WEEKLY, s).exists() for s in refused)


def test_retry_refused_with_refusals_still_refused_finishes(root, monkeypatch):
    monkeypatch.setattr(expired, "REFUSAL_STREAK", 2)
    a, b = SYMBOLS[WEEKLY][0], SYMBOLS[WEEKLY][2]  # not neighbours: an answer between
    _run(FakeClient(answers={a: [REFUSED], b: [REFUSED]}), root)
    again = FakeClient(answers={a: [REFUSED], b: [REFUSED]})
    out = _run(again, root, missing_only=False, retry_refused=True)
    # cached answers are skipped, so the two refusals are in a row: a cached good contract
    # is asked again, answers, and the run carries on
    assert out["stopped"] is None and again.asked == [a, b, SYMBOLS[WEEKLY][1]]
    assert sorted(f["symbol"] for f in out["failed_contracts"]) == sorted([a, b])
    again2 = FakeClient(answers={a: [REFUSED], b: [REFUSED]})
    assert _run(again2, root, missing_only=False, retry_refused=True)["stopped"] is None


def test_an_expiry_refused_before_any_answer_waits_for_one_later_in_the_run(root):
    # every weekly refused and nothing answered yet: held, then kept once the monthly answers
    out = _run(FakeClient(answers={s: [REFUSED] for s in SYMBOLS[WEEKLY]}), root)
    assert out["stopped"] is None and len(out["failed_contracts"]) == 4
    assert out["pending_days"] == {"NIFTY": [d.isoformat() for d in GAP]}  # this run
    again = FakeClient()
    out2 = _run(again, root)  # the refusals are cached now: nothing asked, days merged
    assert again.history_calls == 0 and all(_instruments(root, day) == 4 for day in GAP)
    assert out2["pending_days"] == {}


def test_refusals_with_no_answer_in_the_whole_run_are_reported(root):
    every = [*SYMBOLS[WEEKLY], *SYMBOLS[MONTHLY]]
    out = _run(FakeClient(answers={s: [REFUSED] for s in every}), root)
    assert out["stopped"] == "refused_unconfirmed" and out["failed_contracts"] == []
    assert len(out["retryable_failures"]) == 8


def test_a_transient_error_on_the_confirming_request_does_not_stop_the_run(root):
    good, last = SYMBOLS[WEEKLY][2], SYMBOLS[WEEKLY][-1]
    flaky = {"s": "error", "message": "network: reset"}
    out = _run(FakeClient(answers={good: [None, flaky], last: [REFUSED]}), root)
    assert out["stopped"] is None and out["fetched"] == 9  # 8 + the confirm; the monthly too
    assert [f["symbol"] for f in out["retryable_failures"]] == [last]
    assert not expired._cache_path(root, "NIFTY", WEEKLY, last).exists()


def test_a_refusal_at_the_end_of_an_expiry_is_kept_once_a_good_contract_still_answers(root):
    last = SYMBOLS[WEEKLY][-1]
    client = FakeClient(answers={last: [REFUSED]})
    out = _run(client, root)
    assert out["stopped"] is None and out["fetched"] == 9  # 8 + one confirming request
    assert client.asked[4] == SYMBOLS[WEEKLY][2]  # the last contract that answered
    assert [f["symbol"] for f in out["failed_contracts"]] == [last]
    assert all(_instruments(root, day) == 7 for day in GAP)


def test_a_refusal_at_the_end_is_not_kept_when_a_good_contract_is_refused_too(root):
    good, last = SYMBOLS[WEEKLY][2], SYMBOLS[WEEKLY][-1]
    out = _run(FakeClient(answers={good: [None, REFUSED], last: [REFUSED]}), root)
    assert out["stopped"] == "refused_streak" and out["failed_contracts"] == []
    assert not expired._cache_path(root, "NIFTY", WEEKLY, last).exists()
    assert out["touched_days"] == {}


def test_retry_refused_asks_a_cached_refusal_again(root):
    refused = SYMBOLS[WEEKLY][1]
    _run(FakeClient(answers={refused: [REFUSED]}), root)
    assert all(_instruments(root, day) == 7 for day in GAP)
    again = FakeClient()
    out = _run(again, root, missing_only=False, retry_refused=True)
    assert again.asked == [refused] and out["failed_contracts"] == []
    assert all(_instruments(root, day) == 8 for day in GAP)


def test_a_refusal_cached_under_looser_rules_is_asked_again(root):
    symbol = SYMBOLS[MONTHLY][0]
    path = expired._cache_path(root, "NIFTY", MONTHLY, symbol)
    window = {"range_from": GAP[0].isoformat(), "range_to": GAP[-1].isoformat()}
    expired._write_cache(path, symbol, window, {"s": "error", "_http_status": 403})
    client = FakeClient()
    out = _run(client, root)
    assert symbol in client.asked and out["cached"] == 0
    assert all(_instruments(root, day) == 8 for day in GAP)


def test_a_short_day_writes_nothing_by_default_and_allow_short_merges_it(root):
    # run on 23 Sep: 29 Sep has not expired, so the gap days lack their monthly
    out = _run(FakeClient(), root, today=LATE_DAY)
    assert out["fetched"] == 4 and out["touched_days"] == {}
    assert out["pending_days"] == {"NIFTY": [d.isoformat() for d in GAP]}
    assert not any(lake.bars_1m_path(root, "option", "NIFTY", d).exists() for d in GAP)
    forced = _run(FakeClient(), root, today=LATE_DAY, allow_short=True)
    assert forced["cached"] == 4 and all(_instruments(root, day) == 4 for day in GAP)


def test_an_undecodable_symbol_is_skipped_and_listed(root):
    odd = "NSE:NIFTY26SEPFUT"
    client = FakeClient(extra={MONTHLY: [odd]})
    out = _run(client, root)
    assert out["underlyings"]["NIFTY"]["undecodable_symbols"] == [odd]
    assert odd not in client.asked and all(_instruments(root, day) == 8 for day in GAP)
    assert "obt legwise rerun" in out["next"]


def test_ready_days_are_merged_a_few_at_a_time(root, monkeypatch):
    monkeypatch.setattr(expired, "MERGE_CHUNK_DAYS", 2)
    chunks = []
    real = expired._merge_days
    monkeypatch.setattr(expired, "_merge_days", lambda *a: chunks.append(list(a[3])) or real(*a))
    _run(FakeClient(), root)
    assert chunks == [GAP[:2], GAP[2:]]
    assert all(_instruments(root, day) == 8 for day in GAP)


def test_a_new_partition_keeps_one_row_per_instrument_minute(root):
    path = lake.bars_1m_path(root, "option", "NIFTY", GAP[0])
    candle = _candle(GAP[0])
    fresh = options_table([(_contract(), 7, [candle]), (_contract("NSE:ALIAS"), 7, [candle])])
    assert expired.merge_option_partition(path, fresh) == (1, 0)
    assert pq.read_table(path).num_rows == 1


# --- the client: response classes, the per-minute throttle and the 429 stop -------------


def test_response_states():
    assert response_state({"s": "ok"}) == "ok" and response_state({"s": "no_data"}) == "no_data"
    assert response_state({"s": "error", "message": "Invalid symbol provided"}) == "permanent"
    assert response_state({"s": "error", "message": "x", "_http_status": 502}) == "retryable"
    assert response_state({"s": "error", "message": "network: reset"}) == "retryable"
    assert response_state({"s": "error", "message": "rate limited"}) == "rate_limited"
    # only a refusal about the request itself, on HTTP 200 / 400, is final
    assert response_state({"s": "error", "message": "No data", "_http_status": 400}) == "permanent"
    for unknown in (
        {"s": "error", "message": "Something went wrong. Please try after some time"},
        {"s": "error", "message": "HTTP 404", "_http_status": 404},
        {"s": "error", "message": "Invalid symbol", "_http_status": 404},
    ):
        assert response_state(unknown) == "retryable"
    for no_access in (
        {"s": "error", "message": "You are not subscribed to this API"},
        {"s": "error", "message": "HTTP 403", "_http_status": 403},
    ):
        assert response_state(no_access) == "blocked"
    with pytest.raises(FyersCredentialsError):
        response_state({"s": "error", "message": "Token expired"})


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.slept: list[float] = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


def _client(monkeypatch, **kw):
    clock = FakeClock()
    monkeypatch.setattr(client_module.time, "monotonic", clock.monotonic)
    monkeypatch.setattr(client_module.time, "sleep", clock.sleep)
    return FyersClient(Credentials("APP-100", "token"), **kw), clock


def test_the_per_minute_cap_waits_for_the_oldest_request_to_leave_the_window(monkeypatch):
    client, clock = _client(monkeypatch, min_interval_s=0.0, per_minute=3)
    for _ in range(3):
        client._throttle()
        clock.now += 1  # three requests in three seconds
    assert clock.slept == []
    client._throttle()  # the fourth waits until the first is 60 s old
    assert clock.slept == [pytest.approx(57.0)]
    client._throttle()  # the window holds requests 2, 3 and 4: wait for the second's 60 s
    assert clock.slept[-1] == pytest.approx(1.0)


def test_the_second_429_raises_rate_limited_instead_of_retrying(monkeypatch):
    client, clock = _client(monkeypatch, min_interval_s=0.0, max_rate_limit_hits=2)

    def too_many(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, "Too Many", {}, io.BytesIO(b""))

    monkeypatch.setattr(client_module.urllib.request, "urlopen", too_many)
    with pytest.raises(RateLimitedError):
        client.expired_history_response("NSE:NIFTY2692222000CE", WEEKLY, WEEKLY)
    assert client.calls == 2 and client.rate_limit_hits == 2
    assert 65 in clock.slept  # the first 429 waited out the minute, once


def test_a_5xx_body_carries_its_status_so_it_is_retryable(monkeypatch):
    client, _ = _client(monkeypatch, min_interval_s=0.0)

    def server_error(request, timeout):
        body = io.BytesIO(b'{"s": "error", "message": "oops"}')
        raise urllib.error.HTTPError(request.full_url, 502, "Bad Gateway", {}, body)

    monkeypatch.setattr(client_module.urllib.request, "urlopen", server_error)
    body, _ = client.expired_history_response("NSE:NIFTY2692222000CE", WEEKLY, WEEKLY)
    assert body["_http_status"] == 502 and response_state(body) == "retryable"
