"""BL-226 Phase 1: the F&O list, spells and lot sizes from stored daily files (synthetic days)."""

from datetime import date

import pyarrow as pa
import pyarrow.parquet as pq

from option_backtesting.nse import fno_universe as fu
from option_backtesting.nse import fo_bhavcopy as fb


def _row(day, inst, sym, expiry, oi, chg, contracts=0, value=None, close=None, lot=None, fmt="old"):
    return {
        "date": day, "instrument": inst, "symbol": sym, "expiry": expiry,
        "strike": None if inst.startswith("FUT") else 100.0,
        "option_type": None if inst.startswith("FUT") else "CE",
        "open": close, "high": close, "low": close, "close": close, "settle": close,
        "contracts": contracts, "value_rs": value, "oi": oi, "chg_oi": chg,
        "underlying_price": None, "lot_size": lot, "source_format": fmt,
    }  # fmt: skip


def _write(root, day, rows, ban=""):
    fb.write_day(root, day, pa.Table.from_pylist(rows, schema=fb.FO_SCHEMA))
    p = fb.ban_path(root, day)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"Securities in Ban For Trade Date X:\n{ban}")


def test_members_spells_lots_and_bans(tmp_path):
    e = date(2020, 1, 30)
    d1, d2, d3 = date(2020, 1, 1), date(2020, 1, 2), date(2020, 1, 3)
    # AAA: lot 500 (OI 1500, 4000, change 500); futures value says 100 x 500 x 2 contracts / 2 / 100
    aaa = [
        _row(d, "FUTSTK", "AAA", e, 1500, 500, contracts=2, value=100_000.0, close=100.0)
        for d in (d1, d2, d3)
    ] + [_row(d, "OPTSTK", "AAA", e, 4000, -1000) for d in (d1, d2, d3)]
    bbb = [_row(d1, "FUTSTK", "BBB", e, 600, 0), _row(d3, "FUTSTK", "BBB", e, 900, 300)]
    _write(tmp_path, d1, aaa[0:1] + aaa[3:4] + bbb[:1])
    _write(tmp_path, d2, aaa[1:2] + aaa[4:5], ban="1,AAA\n")
    _write(tmp_path, d3, aaa[2:3] + aaa[5:6] + bbb[1:])
    counts = fu.build(tmp_path)
    assert counts["members"] == 5 and counts["bans"] == 1
    assert fu.members_on(tmp_path, d2) == {"AAA"}
    sp = pq.read_table(fu.universe_dir(tmp_path) / "spells.parquet").to_pylist()
    assert [(s["symbol"], s["first_day"], s["last_day"]) for s in sp] == [
        ("AAA", d1, d3), ("BBB", d1, d1), ("BBB", d3, d3),
    ]  # fmt: skip
    lots = pq.read_table(fu.universe_dir(tmp_path) / "lots.parquet").to_pylist()
    aaa_lots = {r["date"]: (r["lot_size"], r["lot_check"]) for r in lots if r["symbol"] == "AAA"}
    assert aaa_lots[d1] == (500, "agree")
    bbb_lot = [r["lot_size"] for r in lots if r["symbol"] == "BBB"]
    # day 1 alone gives 600 (one position of two lots); the contract's life resolves it to 300
    assert bbb_lot == [300, 300]
    r = fu.report(tmp_path)
    assert r["entries"] == [("BBB", "2020-01-03")] and r["exits"] == [("BBB", "2020-01-01")]
    assert r["ban_days"] == 1


def test_a_stated_lot_wins_and_is_compared_with_the_derived_one(tmp_path):
    d, e = date(2024, 7, 8), date(2024, 7, 25)
    rows = [
        _row(d, "FUTSTK", "AAA", e, 2500, 250, lot=250, fmt="udiff"),
        _row(d, "OPTSTK", "AAA", e, 750, -500, lot=250, fmt="udiff"),
    ]
    _write(tmp_path, d, rows)
    fu.build(tmp_path)
    (lot,) = pq.read_table(fu.universe_dir(tmp_path) / "lots.parquet").to_pylist()
    assert lot["lot_size"] == 250 and lot["derived"] == 250
    assert fu.compare_derived_lots(tmp_path)["equal"] == 1
