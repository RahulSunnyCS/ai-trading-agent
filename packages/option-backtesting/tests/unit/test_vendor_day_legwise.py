"""BL-034's exit check, in miniature: a day imported from the vendor's staged Parquet + spot
CSV is backtested by legwise exactly like a day the Fyers collector wrote — same prices in,
same trades and P&L out, with no change to the engine."""

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data import lake, vendor

from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.daily import bars_table, options_table
from option_backtesting.fyers.symbols import Contract
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import available_days, load_day
from option_backtesting.legwise.schema import LegwiseStrategy

IST = timezone(timedelta(hours=5, minutes=30))
DAY = date(2026, 9, 28)
EXPIRY = date(2026, 9, 29)
STRIKES = (21950.0, 22000.0, 22050.0, 22100.0, 22150.0, 22200.0)
SPEC = {
    "id": "t1",
    "underlying": "NIFTY",
    "entry_time": "09:20",
    "exit_time": "15:00",
    "legs": [
        {
            "id": "ce",
            "lots": 1,
            "position": "sell",
            "option_type": "CE",
            "strike": {"strike_type": "ATM"},
            "stop_loss": {"percent": 30},
        }
    ],
}


def index_price(i: int) -> float:
    return 22000.0 + i


def option_price(i: int) -> float:
    return 100.0 - i * 10 / 375


def _candles(price_at) -> list[Candle]:
    t0 = datetime(DAY.year, DAY.month, DAY.day, 9, 15, tzinfo=IST)
    return [
        Candle(int((t0 + timedelta(minutes=i)).timestamp()), p, p, p, p, 0, None)
        for i in range(375)
        for p in [price_at(i)]
    ]


def write_fyers_day(root: Path) -> None:
    """What `obt fyers fetch` leaves in the lake for the day."""
    lake.write_parquet(
        bars_table(1, "NSE:NIFTY50-INDEX", _candles(index_price)),
        lake.bars_1m_path(root, "index", "NIFTY", DAY),
    )
    rows = [
        (Contract(f"NSE:NIFTY{int(k)}CE", "NIFTY", EXPIRY, k, "CE", 65), 7, _candles(option_price))
        for k in STRIKES
    ]
    lake.write_parquet(options_table(rows), lake.bars_1m_path(root, "option", "NIFTY", DAY))


def write_vendor_inputs(staging: Path, csv: Path) -> None:
    """What the vendor ships: a per-expiry Parquet of contracts and a spot CSV."""
    t0 = datetime(DAY.year, DAY.month, DAY.day, 9, 15, tzinfo=IST)
    rows = []
    for k in STRIKES:
        for i in range(375):
            p = option_price(i)
            rows.append(("NIFTY", f"NIFTY_{k:g}_CE_29_SEP_26", k, "CE", EXPIRY,
                         t0 + timedelta(minutes=i), p, p, p, p, 0, 0.0))  # fmt: skip
    names = ["underlying", "contract", "strike", "option_type", "expiry", "ts"]
    names += ["open", "high", "low", "close", "volume", "oi"]
    types = [pa.string(), pa.string(), pa.float64(), pa.string(), pa.date32()]
    types += [pa.timestamp("us", tz="Asia/Kolkata")] + [pa.float64()] * 4 + [pa.int64()]
    types += [pa.float64()]
    table = pa.table(
        {n: pa.array(c, t) for n, t, c in zip(names, types, zip(*rows, strict=True), strict=True)}
    )
    path = staging / "index" / "nifty" / "2026-09-29.parquet"
    path.parent.mkdir(parents=True)
    pq.write_table(table, path)
    lines = ["Date,Open,High,Low,Close,Volume"]
    for i in range(375):
        t = t0 + timedelta(minutes=i)
        p = index_price(i)
        lines.append(f"{t:%Y-%m-%dT%H:%M:%S}+0530,{p},{p},{p},{p},0")
    csv.write_text("\n".join(lines) + "\n")


@pytest.fixture
def roots(tmp_path):
    fyers, vendored = tmp_path / "fyers", tmp_path / "vendored"
    write_fyers_day(fyers)
    staging, csv = tmp_path / "staging", tmp_path / "nifty_spot.csv"
    write_vendor_inputs(staging, csv)
    (unit,) = vendor.list_units(staging)
    vendor.import_unit(vendored, unit, log=lambda _: None)
    vendor.import_index_csv(vendored, csv, "NIFTY", log=lambda _: None)
    return fyers, vendored


def test_legwise_enumerates_and_loads_a_vendor_day(roots):
    _, vendored = roots
    assert available_days(vendored, "NIFTY") == [DAY]
    data = load_day(vendored, "NIFTY", DAY)
    assert data.spot.price_at(5) == pytest.approx(22004.0)  # 09:20 = the 09:19 bar's close
    assert sorted({k[0] for k in data.chain}) == [EXPIRY]  # expiries come from the day's own file


def test_a_vendor_day_and_a_fyers_day_backtest_identically(roots):
    fyers, vendored = roots
    strategy = LegwiseStrategy.model_validate(SPEC)
    a = simulate_day(strategy, load_day(fyers, "NIFTY", DAY))
    b = simulate_day(strategy, load_day(vendored, "NIFTY", DAY))
    assert a.net == pytest.approx(b.net) and a.gross == pytest.approx(b.gross)
    assert a.mtm == b.mtm

    def rows(result):
        return [
            (t.leg_id, t.contract, t.entry_min, t.entry_price, t.exit_min, t.exit_price,
             t.exit_reason, t.pnl)
            for t in result.trades
        ]  # fmt: skip

    assert rows(a) == rows(b)  # same strike, same minutes, same fills
    assert a.trades, "the strategy must actually have traded for this to prove anything"
