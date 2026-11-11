"""BL-218: the legwise engine on MCX commodity options — the 09:00..23:54 grid, the settling
future as spot, per-root ticks, and the per-underlying session check. NSE behaviour is held by
tests/golden/test_legwise_scenarios.py."""

import json
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import pytest
from pydantic import ValidationError
from trading_data import lake
from trading_data.lake import BAR_SCHEMA, OPT_SCHEMA

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.legwise import market
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day, minute_index, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy

IST = timezone(timedelta(hours=5, minutes=30))
DAY = date(2025, 10, 14)
EXPIRY = date(2025, 10, 16)
NEXT = date(2025, 11, 17)


def _ts(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return int(datetime(DAY.year, DAY.month, DAY.day, h, m, tzinfo=IST).timestamp())


def _bars(rows, schema, extra):
    cols = {k: [] for k in schema.names}
    for i, (hhmm, o, h, lo, c) in enumerate(rows):
        cols["instrument_id"].append(extra[i]["id"])
        cols["ts"].append(_ts(hhmm))
        for k, v in zip(("open", "high", "low", "close"), (o, h, lo, c), strict=True):
            cols[k].append(v)
        cols["volume"].append(1.0)
        cols["oi"].append(None)
        for k, v in extra[i].items():
            if k != "id":
                cols[k].append(v)
    cols["ts"] = pa.array(cols["ts"], pa.int64()).cast(lake.TS_TYPE)
    return pa.table(cols, schema=schema)


def _flat(start: str, end: str, price: float):
    """One bar a minute from start to end (inclusive) at a flat price."""
    h, m = map(int, start.split(":"))
    t = h * 60 + m
    h2, m2 = map(int, end.split(":"))
    out = []
    while t <= h2 * 60 + m2:
        out.append((f"{t // 60:02d}:{t % 60:02d}", price, price, price, price))
        t += 1
    return out


@pytest.fixture
def root(tmp_path):
    """One CRUDEOILM day: the expiring Oct chain (5100/5150/5200, CE+PE), one Nov contract, the
    Oct future at 5164 and the Nov future at 5200 (the wrong one to read)."""
    opt_rows, opt_extra = [], []
    prices = {
        (5100.0, "CE"): 100.0, (5150.0, "CE"): 70.0, (5200.0, "CE"): 45.0,
        (5100.0, "PE"): 40.0, (5150.0, "PE"): 60.0, (5200.0, "PE"): 90.0,
    }  # fmt: skip
    for i, ((strike, side), p) in enumerate(prices.items()):
        bars = _flat("17:00", "21:00", p)
        if (strike, side) == (5150.0, "CE"):
            bars[-1] = ("21:00", p, 200.0, p, p)  # a spike at 21:00: a sold leg's stop fires
            bars += _flat("21:01", "23:29", 30.0)  # then trades to the summer close
        sym = f"MCX:CRUDEOILM25OCT{int(strike)}{side}"
        opt_rows += bars
        opt_extra += [
            {"id": 100 + i, "expiry": EXPIRY, "strike": strike, "option_type": side,
             "vendor_symbol": sym}
        ] * len(bars)  # fmt: skip
    nov = _flat("17:00", "17:05", 150.0)
    opt_rows += nov
    opt_extra += [
        {"id": 200, "expiry": NEXT, "strike": 5200.0, "option_type": "CE",
         "vendor_symbol": "MCX:CRUDEOILM25NOV5200CE"}
    ] * len(nov)  # fmt: skip
    lake.write_parquet(
        _bars(opt_rows, OPT_SCHEMA, opt_extra),
        lake.bars_1m_path(tmp_path, "option", "CRUDEOILM", DAY),
    )
    fut_rows = _flat("09:00", "23:29", 5164.0) + _flat("09:00", "23:29", 5200.0)
    fut_extra = [{"id": 1, "vendor_symbol": "MCX:CRUDEOILM25OCTFUT"}] * (len(fut_rows) // 2) + [
        {"id": 2, "vendor_symbol": "MCX:CRUDEOILM25NOVFUT"}
    ] * (len(fut_rows) // 2)
    lake.write_parquet(
        _bars(fut_rows, BAR_SCHEMA, fut_extra),
        lake.bars_1m_path(tmp_path, "future", "CRUDEOILM", DAY),
    )
    # the contract calendar: the Oct options settle on the Oct future, Nov's on the Nov future
    path = market.mcx_calendar_path(tmp_path, "CRUDEOILM")
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "options": {
                    str(EXPIRY): "MCX:CRUDEOILM25OCTFUT",
                    str(NEXT): "MCX:CRUDEOILM25NOVFUT",
                },
                "futures": {
                    "MCX:CRUDEOILM25OCTFUT": "2025-10-20",
                    "MCX:CRUDEOILM25NOVFUT": "2025-11-19",
                },
            }
        )
    )
    yield tmp_path


def _strategy(**over):
    spec = {
        "id": "t",
        "underlying": "CRUDEOILM",
        "entry_time": "18:00",
        "exit_time": "23:15",
        "legs": [
            {
                "id": side.lower(),
                "lots": 1,
                "position": "sell",
                "option_type": side,
                "expiry": "weekly",
                "strike": {"strike_type": "ATM"},
                "stop_loss": {"percent": 100},
            }
            for side in ("CE", "PE")
        ],  # fmt: skip
    }
    spec.update(over)
    return LegwiseStrategy.model_validate(spec)


def test_an_mcx_day_runs_on_the_09_00_grid_with_its_settling_future(root):
    d = load_day(root, "CRUDEOILM", DAY)
    assert (d.session_start, d.n_minutes) == (9 * 60, 895)
    assert d.vix is None and d.listed_expiries == [EXPIRY, NEXT]
    # the Oct option settles on the Oct future, not the Nov one at 5200
    assert d.spot.price_at(minute_index("18:00", 9 * 60)) == 5164.0
    assert minute_label(minute_index("23:54", 9 * 60), 9 * 60) == "23:54"


def test_strikes_come_from_the_future_and_a_stop_fires_in_the_evening(root):
    r = simulate_day(_strategy(), load_day(root, "CRUDEOILM", DAY), default_reference_data())
    ce, pe = sorted(r.trades, key=lambda t: t.contract[2])
    assert ce.contract == (EXPIRY, 5150.0, "CE") and pe.contract == (EXPIRY, 5150.0, "PE")
    assert ce.qty == 10  # CRUDEOILM: ₹10 a point a lot
    assert minute_label(ce.entry_min, 540) == "18:00" and ce.entry_price == 70.0
    assert ce.exit_reason == "SL" and minute_label(ce.exit_min, 540) == "21:00"
    assert ce.exit_price == 140.0  # 100% stop, filled at its level
    assert pe.exit_reason == "EXIT_TIME" and minute_label(pe.exit_min, 540) == "23:15"


def test_an_exit_after_a_summer_close_fills_at_the_last_bar(root):
    s = _strategy(
        exit_time="23:54",
        legs=[
            {
                "id": "ce",
                "lots": 1,
                "position": "buy",
                "option_type": "CE",
                "expiry": "weekly",
                "strike": {"strike_type": "ATM"},
            }
        ],  # fmt: skip
    )
    (t,) = simulate_day(s, load_day(root, "CRUDEOILM", DAY), default_reference_data()).trades
    assert t.exit_price == 30.0  # the 23:29 close, carried to the end of the grid


def test_gold_and_silver_stops_round_to_their_half_rupee_tick():
    from option_backtesting.legwise.engine import TICK, TICKS, to_tick

    assert TICKS["GOLDM"] == TICKS["SILVERM"] == 0.5 and TICK == 0.05
    assert to_tick(1234.37, 0.5) == 1234.5 and to_tick(1234.37) == 1234.35


def test_each_underlying_is_held_to_its_own_session():
    _strategy(entry_time="09:05", exit_time="23:54")  # MCX: fine
    with pytest.raises(ValidationError, match="outside the 09:00-23:54 session"):
        _strategy(entry_time="08:59")
    nifty = {
        "id": "n", "underlying": "NIFTY", "entry_time": "09:17", "exit_time": "16:00",
        "legs": [{"id": "ce", "lots": 1, "position": "sell", "option_type": "CE",
                  "expiry": "weekly", "strike": {"strike_type": "ATM"}}],
    }  # fmt: skip
    with pytest.raises(ValidationError, match="outside the 09:15-15:29 session"):
        LegwiseStrategy.model_validate(nifty)
    nifty["exit_time"] = "15:28"
    nifty["legs"][0]["range_breakout"] = {"until": "17:00", "side": "high"}
    with pytest.raises(ValidationError, match="outside the 09:15-15:29 session"):
        LegwiseStrategy.model_validate(nifty)


def test_a_day_without_its_settling_future_is_refused_by_name(root):
    lake.bars_1m_path(root, "future", "CRUDEOILM", DAY).unlink()
    with pytest.raises(FileNotFoundError, match="mcx-futures"):
        load_day(root, "CRUDEOILM", DAY)


def test_the_nearest_expiry_comes_from_the_calendar_not_the_days_bars(root):
    """An expiring contract with no bar that day is still the nearest expiry: its legs simply
    do not trade, and the next month is never traded in its place."""
    path = lake.bars_1m_path(root, "option", "CRUDEOILM", DAY)
    t = pq.read_table(path)
    lake.write_parquet(t.filter(pc.equal(t.column("expiry"), NEXT)).cast(OPT_SCHEMA), path)
    d = load_day(root, "CRUDEOILM", DAY)
    assert d.listed_expiries[0] == EXPIRY and d.spot.price_at(minute_index("18:00", 540)) == 5164.0
    assert simulate_day(_strategy(), d, default_reference_data()).trades == []
