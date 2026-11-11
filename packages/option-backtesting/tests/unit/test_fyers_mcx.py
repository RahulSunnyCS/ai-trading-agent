"""MCX expired-option discovery, frozen manifest, planning, resumable raw pull and size report
(BL-148 Phase 1) against a fake Fyers client. No network."""

from datetime import date, datetime, timedelta, timezone

import pytest

from option_backtesting.fyers import mcx
from option_backtesting.fyers.daily import data_dir  # noqa: F401  (import check)

IST = timezone(timedelta(hours=5, minutes=30))
START = date(2024, 10, 21)
END = date(2025, 3, 31)
E1 = date(2024, 11, 15)
E2 = date(2025, 1, 15)
E3 = date(2025, 3, 17)
SYMBOLS = {
    E1: ["MCX:CRUDEOIL24NOV6000CE", "MCX:CRUDEOIL24NOV6000PE", "MCX:CRUDEOILM24NOV6000CE"],
    E2: ["MCX:CRUDEOIL25JAN6500CE", "MCX:CRUDEOIL25JAN6500PE"],
    E3: ["MCX:CRUDEOIL25MAR6500CE", "MCX:CRUDEOIL25MAR6500PE"],
}
DECODABLE = [s for v in SYMBOLS.values() for s in v if not s.startswith("MCX:CRUDEOILM")]


def _epoch(day: date, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, 9, minute, tzinfo=IST).timestamp())


class FakeClient:
    def __init__(self):
        self.calls = 0
        self.history = []
        self.windows = []

    def expired_expiries(self, symbol, start, end):
        self.calls += 1
        assert (end - start).days <= 366, "Fyers refuses an expiry window over 366 days"
        return [e for e in SYMBOLS if start <= e <= end]

    def expired_contracts(self, symbol, expiry):
        self.calls += 1
        return list(SYMBOLS[expiry])

    def expired_history_response(self, symbol, start, end):
        self.calls += 1
        self.history.append(symbol)
        self.windows.append((symbol, start, end))
        params = {"symbol": symbol, "range_from": start.isoformat(), "range_to": end.isoformat()}
        rows = [[_epoch(start, m), 10, 12, 9, 11, 5, 100 + m] for m in range(4)]
        return (
            {
                "s": "ok",
                "columns": ["timestamp", "open", "high", "low", "close", "volume", "open_interest"],
                "candles": rows,
            },
            params,
        )


@pytest.fixture
def manifest(monkeypatch):
    monkeypatch.setattr(
        mcx, "reference_futures", lambda roots, today: {r: f"MCX:{r}26DECFUT" for r in roots}
    )
    return mcx.discover(FakeClient(), ("CRUDEOIL",), START, END)


def test_decode_reads_root_strike_and_side_and_never_guesses():
    c = mcx.decode("MCX:CRUDEOIL24NOV6000CE", "CRUDEOIL", E1)
    assert (c.underlying, c.strike, c.option_type, c.expiry) == ("CRUDEOIL", 6000.0, "CE", E1)
    assert mcx.decode("MCX:NATURALGAS24OCT115.5PE", "NATURALGAS", E1).strike == 115.5
    # the mini contract is another root: never collapsed into the standard one
    assert mcx.decode("MCX:CRUDEOILM24NOV6000CE", "CRUDEOIL", E1) is None
    assert mcx.decode("MCX:CRUDEOIL24NOV6000", "CRUDEOIL", E1) is None


def test_discover_windows_are_short_and_undecodable_symbols_are_listed(monkeypatch):
    monkeypatch.setattr(mcx, "reference_futures", lambda roots, today: {r: "MCX:X" for r in roots})
    m = mcx.discover(FakeClient(), ("CRUDEOIL",), START, END)
    body = m["roots"]["CRUDEOIL"]["expiries"]
    assert sorted(body) == [E1.isoformat(), E2.isoformat(), E3.isoformat()]
    # the mini symbol the fake lists under CRUDEOIL's first expiry is kept out and named
    assert body[E1.isoformat()] == ["MCX:CRUDEOIL24NOV6000CE", "MCX:CRUDEOIL24NOV6000PE"]
    assert m["undecodable"] == ["MCX:CRUDEOILM24NOV6000CE"]


def test_discover_ignores_an_expiry_before_the_start(monkeypatch):
    monkeypatch.setattr(mcx, "reference_futures", lambda roots, today: {r: "MCX:X" for r in roots})
    m = mcx.discover(FakeClient(), ("CRUDEOIL",), date(2024, 12, 1), END)
    assert list(m["roots"]["CRUDEOIL"]["expiries"]) == [E2.isoformat(), E3.isoformat()]


def test_manifest_is_frozen_by_window_and_symbol_hash(tmp_path, manifest):
    path = mcx.save_manifest(tmp_path, manifest)
    assert manifest["symbols_sha256"][:10] in path.name and "2024-10-21_2025-03-31" in path.name
    first = path.read_bytes()
    assert mcx.save_manifest(tmp_path, manifest) == path
    assert path.read_bytes() == first  # an identical rediscovery rewrites nothing
    assert mcx.load_manifest(tmp_path)["symbols_sha256"] == manifest["symbols_sha256"]


def test_load_manifest_says_what_to_run_first(tmp_path):
    with pytest.raises(RuntimeError, match="mcx-inventory"):
        mcx.load_manifest(tmp_path)


def test_plan_windows_stop_at_100_days_and_at_the_history_start(manifest):
    plans = {item.expiry: item for _n, item in mcx.plan_expiries(manifest, ("CRUDEOIL",))}
    assert mcx._window(plans[E1]) == (START, E1)  # only 25 days of history exist
    assert mcx._window(plans[E2]) == (START, E2)  # 99 days back would pass the history start
    lo, hi = mcx._window(plans[E3])
    assert hi == E3 and (hi - lo).days == 99  # the longest a request may span, inclusive


def test_plan_filters_by_expiry_and_count(manifest):
    assert [i.expiry for _n, i in mcx.plan_expiries(manifest, ("CRUDEOIL",), first_n=1)] == [E1]
    only = mcx.plan_expiries(manifest, ("CRUDEOIL",), only_expiry=E2)
    assert [i.expiry for _n, i in only] == [E2]


def test_pull_caches_and_a_rerun_asks_for_nothing(tmp_path, manifest):
    client = FakeClient()
    first = mcx.pull_raw(client, tmp_path, manifest, ("CRUDEOIL",), log=lambda _m: None)
    assert first["requests"] == 6 and first["stopped"] is None and first["expiries_complete"] == 3
    again = FakeClient()
    second = mcx.pull_raw(again, tmp_path, manifest, ("CRUDEOIL",), log=lambda _m: None)
    assert again.history == [] and second["requests"] == 0 and second["from_cache"] == 6


def test_pull_stops_cleanly_at_the_request_budget_and_resumes(tmp_path, manifest):
    client = FakeClient()
    cut = mcx.pull_raw(
        client, tmp_path, manifest, ("CRUDEOIL",), max_requests=3, log=lambda _m: None
    )
    assert cut["stopped"] == "max_requests" and cut["requests"] == 3
    rest = FakeClient()
    done = mcx.pull_raw(rest, tmp_path, manifest, ("CRUDEOIL",), log=lambda _m: None)
    assert len(rest.history) == 3 and done["stopped"] is None
    # each contract asked once in total, with its own window
    assert sorted(client.history + rest.history) == sorted(DECODABLE)


def test_report_counts_rows_and_projects_the_whole_manifest(tmp_path, manifest):
    mcx.pull_raw(FakeClient(), tmp_path, manifest, ("CRUDEOIL",), first_n=1, log=lambda _m: None)
    r = mcx.report(tmp_path, manifest, ("CRUDEOIL",), estimate_parquet=True)
    expiry = r["roots"]["CRUDEOIL"]["expiries"][E1.isoformat()]
    assert (expiry["listed"], expiry["cached"], expiry["ok"], expiry["rows"]) == (2, 2, 2, 8)
    assert r["cached"]["contracts"] == 2
    assert r["projection"]["listed_contracts"] == 6
    assert r["projection"]["mean_rows_per_contract"] == 4 and r["projection"]["parquet_gib"] >= 0


def test_report_flags_a_contract_that_may_have_traded_before_its_window(tmp_path, manifest):
    mcx.pull_raw(
        FakeClient(), tmp_path, manifest, ("CRUDEOIL",), only_expiry=E3, log=lambda _m: None
    )
    r = mcx.report(tmp_path, manifest, ("CRUDEOIL",), estimate_parquet=False)
    # the fake's rows start on the window's first day, and that day is not the history start
    assert r["roots"]["CRUDEOIL"]["expiries"][E3.isoformat()]["may_be_cut_at_window_start"] == 2


def test_inventory_counts_requests_and_free_space(tmp_path, manifest):
    inv = mcx.inventory(manifest, tmp_path)
    assert inv["option_symbols"] == 6 and inv["candle_requests"] == 6
    assert inv["roots"]["CRUDEOIL"]["strike_min"] == 6000.0 and inv["undecodable_symbols"] == 1
    assert inv["free_gib"] > 0


def test_parallel_workers_ask_each_contract_once(tmp_path, manifest):
    client = FakeClient()
    result = mcx.pull_raw(client, tmp_path, manifest, ("CRUDEOIL",), workers=4, log=lambda _m: None)
    assert sorted(client.history) == sorted(DECODABLE) and result["requests"] == 6
    assert result["stopped"] is None


def test_parallel_pull_honours_the_request_budget(tmp_path, manifest):
    result = mcx.pull_raw(
        FakeClient(), tmp_path, manifest, ("CRUDEOIL",), workers=4, max_requests=2, log=print
    )
    assert result["stopped"] == "max_requests" and result["requests"] == 2


def test_a_rate_limit_stops_the_parallel_pull_without_caching_it(tmp_path, manifest):
    class Limited(FakeClient):
        def expired_history_response(self, symbol, start, end):
            return {"s": "error", "message": "Rate limit exceeded", "_http_status": 429}, {}

    result = mcx.pull_raw(Limited(), tmp_path, manifest, ("CRUDEOIL",), log=lambda _m: None)
    assert result["stopped"] == "rate_limited"
    assert not list((tmp_path / "raw").rglob("*.json.gz"))


def test_a_refused_contract_is_settled_by_the_serial_pass(tmp_path, manifest):
    class Refuses(FakeClient):
        def expired_history_response(self, symbol, start, end):
            if symbol.endswith("6000PE"):
                return {"s": "error", "message": "Invalid symbol provided"}, {
                    "symbol": symbol,
                    "range_from": start.isoformat(),
                    "range_to": end.isoformat(),
                }
            return super().expired_history_response(symbol, start, end)

    result = mcx.pull_raw(Refuses(), tmp_path, manifest, ("CRUDEOIL",), log=lambda _m: None)
    assert [r["symbol"] for r in result["refused"] + result["retryable"]] == [
        "MCX:CRUDEOIL24NOV6000PE"
    ]
