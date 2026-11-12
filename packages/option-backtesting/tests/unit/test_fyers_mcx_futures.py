"""BL-218: the future each MCX option settles on, the request windows, and the lake write
(one row a minute, own rows replaced, other rows kept). No network."""

from datetime import date, datetime, timedelta, timezone

import pyarrow.parquet as pq
from trading_data import lake

from option_backtesting.fyers import mcx_futures as mf

IST = timezone(timedelta(hours=5, minutes=30))


def _manifest(root, expiries):
    return {"from": "2024-10-21", "roots": {root: {"expiries": expiries}}}


def test_the_settling_future_is_the_first_to_expire_on_or_after_the_option():
    futures = [date(2024, 10, 31), date(2024, 12, 5), date(2025, 1, 3)]
    # GOLDM's 26 Nov option is on the 5 Dec future, not a (non-existent) Nov one
    assert mf.settling_future(date(2024, 11, 26), futures) == date(2024, 12, 5)
    assert mf.settling_future(date(2024, 10, 22), futures) == date(2024, 10, 31)
    assert mf.settling_future(date(2025, 2, 1), futures) is None
    assert mf.future_symbol("GOLDM", date(2024, 12, 5)) == "MCX:GOLDM24DECFUT"


def test_plan_windows_end_at_the_future_or_ten_days_after_the_option():
    m = _manifest(
        "SILVERM",
        {"2025-07-28": ["MCX:SILVERM25JUL1C"], "2025-08-20": ["MCX:SILVERM25AUG1C"]},
    )
    plans = mf.plan(m, ("SILVERM",), {"SILVERM": [date(2025, 6, 30), date(2025, 8, 29)]})
    # both options settle on the two-monthly Aug future, each with its own window
    assert [p.symbol for p in plans] == ["MCX:SILVERM25AUGFUT"] * 2
    jul, aug = plans
    assert jul.end == date(2025, 8, 7) and (jul.end - jul.start).days == 99
    assert aug.end == date(2025, 8, 29)  # the future expires before option + 10 days
    assert mf.cache_path(lake_root := __import__("pathlib").Path("/r"), jul) != mf.cache_path(
        lake_root, aug
    )


def _record(root, plan, minutes):
    candles = [
        [int(datetime(2025, 8, 6, 9, m, tzinfo=IST).timestamp()), 10, 11, 9, 10 + m, 5, 100]
        for m in minutes
    ]
    body = {
        "s": "ok",
        "columns": ["timestamp", "open", "high", "low", "close", "volume", "open_interest"],
        "candles": candles,
    }
    path = mf.cache_path(root, plan)
    path.parent.mkdir(parents=True, exist_ok=True)
    import gzip
    import json

    with gzip.open(path, "wt") as fh:
        json.dump({"symbol": plan.symbol, "params": {}, "response": body}, fh)


def test_the_lake_gets_one_row_a_minute_and_keeps_other_futures(tmp_path):
    m = _manifest(
        "SILVERM",
        {"2025-07-28": ["MCX:SILVERM25JUL1C"], "2025-08-20": ["MCX:SILVERM25AUG1C"]},
    )
    jul, aug = mf.plan(m, ("SILVERM",), {"SILVERM": [date(2025, 8, 29)]})
    _record(tmp_path, jul, [0, 1, 2])
    _record(tmp_path, aug, [1, 2, 3])  # overlaps the other window's minutes 1-2
    path = lake.bars_1m_path(tmp_path, "future", "SILVERM", date(2025, 8, 6))
    out = mf.write_lake(tmp_path, [jul, aug], {jul.symbol: 7})
    assert out == {"rows": 4, "days_written": 1}
    t = pq.read_table(path)
    assert t.num_rows == 4 and set(t.column("vendor_symbol").to_pylist()) == {jul.symbol}
    # a rerun replaces its own rows and leaves another future's alone
    other = t.slice(0, 1).to_pylist()[0] | {"vendor_symbol": "MCX:SILVERM25NOVFUT"}
    import pyarrow as pa

    lake.write_parquet(
        pa.concat_tables(
            [t.cast(lake.BAR_SCHEMA), pa.Table.from_pylist([other], schema=lake.BAR_SCHEMA)]
        ),
        path,
    )
    mf.write_lake(tmp_path, [jul, aug], {jul.symbol: 7})
    syms = pq.read_table(path).column("vendor_symbol").to_pylist()
    assert syms.count(jul.symbol) == 4 and syms.count("MCX:SILVERM25NOVFUT") == 1


def test_a_future_not_expired_yet_is_read_from_history_once_its_window_has_ended(tmp_path):
    from option_backtesting.fyers.client import Candle

    class Fake:
        def __init__(self):
            self.live, self.expired = [], []

        def minute_candles_range(self, symbol, start, end):
            self.live.append(symbol)
            return [Candle(1_760_000_000, 1.0, 2.0, 0.5, 1.5, 3.0, 9.0)]

        def expired_history_response(self, symbol, start, end):
            self.expired.append(symbol)
            return {"s": "no_data"}, {}

    today = date(2026, 11, 11)
    done = mf.FuturePlan("SILVERM", date(2026, 10, 27), "MCX:SILVERM26NOVFUT",
                         date(2026, 7, 31), date(2026, 11, 6), date(2026, 11, 30))  # fmt: skip
    running = mf.FuturePlan("SILVERM", date(2026, 11, 23), "MCX:SILVERM26NOVFUT",
                            date(2026, 8, 26), date(2026, 11, 30), date(2026, 11, 30))  # fmt: skip
    old = mf.FuturePlan("SILVERM", date(2025, 8, 20), "MCX:SILVERM25AUGFUT",
                        date(2025, 5, 22), date(2025, 8, 29), date(2025, 8, 29))  # fmt: skip
    client = Fake()
    out = mf.pull(client, tmp_path, [done, running, old], log=lambda _m: None, today=today)
    assert client.live == ["MCX:SILVERM26NOVFUT"] and client.expired == ["MCX:SILVERM25AUGFUT"]
    assert out["asked"] == 2 and out["states"] == {"ok": 1, "no_data": 1}
    assert mf.cache_path(tmp_path, done).exists() and not mf.cache_path(tmp_path, running).exists()
