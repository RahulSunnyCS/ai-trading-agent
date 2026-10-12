"""BL-094: the straddle heatmap's grid pinned to the legwise engine, and its three views."""

import random
from datetime import date

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.heatmap import grid, store, view
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import N_MINUTES, DayData, Series, minute_index
from option_backtesting.legwise.schema import LegwiseStrategy

DAY = date(2026, 9, 28)
EXP = date(2026, 9, 29)
LOT = 65  # NIFTY today, reference/lot_sizes.csv


def walk(seed: int, start: float, vol: float) -> Series:
    """A reproducible 1-minute series with real highs and lows around each close."""
    rng = random.Random(seed)
    o, h, lo, c = [], [], [], []
    price = start
    for _ in range(N_MINUTES):
        op = price
        price = max(0.5, price + rng.gauss(0, vol))
        o.append(op)
        c.append(price)
        h.append(max(op, price) + abs(rng.gauss(0, vol / 2)))
        lo.append(max(0.05, min(op, price) - abs(rng.gauss(0, vol / 2))))
    return Series(o, h, lo, c)


def flat(value: float) -> Series:
    return Series(
        [value] * N_MINUTES, [value] * N_MINUTES, [value] * N_MINUTES, [value] * N_MINUTES
    )


def index_day(seed: int) -> DayData:
    chain = {
        (EXP, 22000.0, "CE"): walk(seed, 150.0, 1.4),
        (EXP, 22000.0, "PE"): walk(seed + 1, 90.0, 1.1),
    }
    # The engine's last allowed exit is 15:29 (the close of the 15:28 bar); the grid's 15:30 is the
    # close of the 15:29 bar. Making that final bar a repeat of the one before lets the two be
    # compared exactly, and its high can never reach a stop the earlier bar did not.
    for series in chain.values():
        last = N_MINUTES - 1
        series.open[last] = series.high[last] = series.low[last] = series.close[last - 1]
        series.close[last] = series.close[last - 1]
    return DayData(
        day=DAY,
        underlying="NIFTY",
        spot=flat(22010.0),
        chain=chain,
        listed_expiries=[EXP, date(2026, 10, 6)],
        master_lot_size=LOT,
    )


def engine_gross(data: DayData, entry: str, exit_time: str, sl: int) -> float:
    legs = [
        {
            "id": kind.lower(),
            "lots": 1,
            "position": "sell",
            "option_type": kind,
            "strike": {"strike_type": "ATM"},
            # grid.NO_SL: the legs carry no stop_loss at all
            **({} if sl == grid.NO_SL else {"stop_loss": {"percent": sl}}),
        }
        for kind in ("CE", "PE")
    ]
    spec = LegwiseStrategy.model_validate(
        {
            "id": "t",
            "underlying": "NIFTY",
            "entry_time": entry,
            "exit_time": "15:29" if exit_time == "15:30" else exit_time,
            "legs": legs,
        }
    )
    return simulate_day(spec, data, sizing_date=DAY).gross


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
def test_every_cell_equals_the_legwise_engine(seed):
    data = index_day(seed)
    cells, notes = grid.cells_from(
        "NIFTY", DAY, data.chain, data.spot, EXP, default_reference_data()
    )
    assert not notes
    assert len(cells) == len(grid.ENTRY_TIMES) * len(grid.EXIT_TIMES) * len(grid.SL_LEVELS)
    stopped = 0
    for c in cells:
        got = (c.ce_pts + c.pe_pts) * LOT
        want = engine_gross(data, c.time, c.exit, c.sl)
        assert got == pytest.approx(want, abs=1e-6), (c.time, c.exit, c.sl)
        stopped += c.ce_stopped + c.pe_stopped
    assert stopped > 0  # the series does hit stops, so the stop path is covered
    # the No SL level is in the grid, never stops a leg, and (pinned above) equals the engine run
    # with legs that have no stop_loss
    no_sl = [c for c in cells if c.sl == grid.NO_SL]
    assert len(no_sl) == len(grid.ENTRY_TIMES) * len(grid.EXIT_TIMES)
    assert not any(c.ce_stopped or c.pe_stopped for c in no_sl)


def test_no_sl_is_the_last_level_and_a_100_percent_stop_is_not_it():
    assert grid.SL_LEVELS[-1] == grid.NO_SL == 0
    assert grid.NO_SL not in grid.STOP_LOSSES
    # a 100% stop on a series that doubles is stopped; the same series with No SL is not
    s = flat(100.0)
    entry = minute_index("09:45")
    s.high[entry + 5] = 250.0
    assert grid._sell_leg(s, entry, 100, minute_index("15:15"))[2] is True
    assert grid._sell_leg(s, entry, grid.NO_SL, minute_index("15:15")) == (100.0, 0.0, False)


def test_a_stock_straddle_is_struck_where_call_and_put_cost_the_same():
    # No spot: calls get dearer going down, puts the other way; parity at 1500 (100 vs 101).
    chain = {}
    for strike, ce, pe in [(1480, 120.0, 82.0), (1500, 100.0, 101.0), (1520, 82.0, 121.0)]:
        chain[(EXP, float(strike), "CE")] = flat(ce)
        chain[(EXP, float(strike), "PE")] = flat(pe)
    cells, _ = grid.cells_from("AXISBANK", DAY, chain, None, EXP, default_reference_data())
    assert {c.strike for c in cells} == {1500.0}
    assert grid.expiry_kind("AXISBANK") == "monthly"
    assert grid.expiry_kind("NIFTY") == "weekly"
    assert grid.expiry_kind("BANKNIFTY") == "monthly"


def test_a_gap_through_the_stop_fills_at_the_open_and_a_missing_leg_makes_no_cell():
    entry = minute_index("09:45")
    ce = flat(100.0)
    ce.open[entry + 3], ce.high[entry + 3], ce.low[entry + 3], ce.close[entry + 3] = (
        150.0, 152.0, 149.0, 151.0,
    )  # fmt: skip
    pe = flat(50.0)
    got = grid._sell_leg(ce, entry, 20, minute_index("15:15"))
    assert got == (100.0, -50.0, True)  # level 120 gapped; filled at the 150 open
    assert grid._sell_leg(pe, entry, 20, minute_index("15:15")) == (50.0, 0.0, False)
    none = Series.empty()
    assert grid._sell_leg(none, entry, 20, minute_index("15:15")) is None


def _write_rows(root, underlying, rows):
    schema = store.SCHEMA
    path = store.path_for(underlying, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.Table.from_pylist(rows, schema=schema), path)


def _row(day, time, sl, ce, pe, *, exit="15:30", dte=0, entry=(100.0, 50.0)):
    return {
        "day": day, "time": time, "exit": exit, "sl": sl, "strike": 22000.0,
        "expiry": day, "dte": dte, "ce_entry": entry[0], "pe_entry": entry[1],
        "ce_pts": ce, "pe_pts": pe, "ce_stopped": False, "pe_stopped": False,
    }  # fmt: skip


@pytest.fixture
def root(tmp_path):
    d1, d2 = date(2026, 9, 28), date(2026, 9, 29)
    rows = [
        _row(d1, "09:16", 10, 5.0, -2.0, dte=1),
        _row(d1, "09:16", 20, 6.0, -1.0, dte=1),
        _row(d1, "09:45", 10, 1.0, 1.0, dte=1),
        _row(d2, "09:16", 10, -3.0, 4.0, dte=8),
        _row(d2, "09:16", 20, 2.0, 2.0, dte=8),
        _row(d1, "09:16", 10, 99.0, 99.0, exit="15:15", dte=1),
    ]
    _write_rows(tmp_path, "NIFTY", rows)
    return tmp_path


def test_time_sl_one_day_and_a_range(root):
    one = view.build_view("NIFTY", "time_sl", root=root, day=date(2026, 9, 28))
    assert one["unit"] == "inr_per_lot" and one["lot"] == LOT
    cell = one["cells"][0][0]  # 09:16, SL 10
    assert cell["net"] == pytest.approx((5.0 - 2.0) * LOT)
    assert cell["ce"] == pytest.approx(5.0 * LOT)
    assert one["cells"][0][2] is None  # SL 30 has no straddle
    assert one["total"]["net"] == pytest.approx((3.0 + 5.0 + 2.0) * LOT)
    both = view.build_view(
        "NIFTY", "time_sl", root=root, start=date(2026, 9, 28), end=date(2026, 9, 29)
    )
    assert both["cells"][0][0]["net"] == pytest.approx((3.0 + 1.0) * LOT)
    assert both["cells"][0][0]["n"] == 2
    assert both["total"]["net"] == pytest.approx(
        sum(c["net"] for line in both["cells"] for c in line if c)
    )


def test_totals_are_the_sums_of_the_cells_in_every_view(root):
    for name, kw in (
        ("date_time", {"sl": 10}),
        ("date_sl", {"time": "09:16"}),
    ):
        v = view.build_view(
            "NIFTY", name, root=root, start=date(2026, 9, 1), end=date(2026, 9, 30), **kw
        )
        flat_cells = [c["net"] for line in v["cells"] for c in line if c]
        assert v["total"]["net"] == pytest.approx(sum(flat_cells))
        rows = [t["net"] for t in v["row_totals"] if t]
        assert sum(rows) == pytest.approx(v["total"]["net"])
        assert v["rows"] == ["2026-09-28", "2026-09-29"]


def test_weeks_to_expiry_filter_and_exit_choice(root):
    v = view.build_view(
        "NIFTY", "date_sl", root=root, start=date(2026, 9, 1), end=date(2026, 9, 30),
        time="09:16", weeks={1},
    )  # fmt: skip
    assert v["rows"] == ["2026-09-29"]  # dte 8 -> one week out
    early = view.build_view("NIFTY", "time_sl", root=root, day=date(2026, 9, 28), exit_time="15:15")
    assert early["cells"][0][0]["net"] == pytest.approx(198 * LOT)


def test_no_sl_column_in_every_view_and_empty_before_it_is_built(root, tmp_path):
    d1 = date(2026, 9, 28)
    # `root` has no sl = 0 rows (a store from before the level existed): the column is there, empty
    old = view.build_view("NIFTY", "time_sl", root=root, day=d1)
    assert old["columns"][-1] == grid.NO_SL and old["cells"][0][-1] is None
    assert old["column_totals"][-1] is None
    assert (
        view.build_view("NIFTY", "date_time", root=root, start=d1, end=d1, sl=grid.NO_SL)["total"]
        is None
    )
    _write_rows(
        tmp_path,
        "NIFTY",
        [
            _row(d1, "09:16", 10, 5.0, -2.0, dte=1),
            _row(d1, "09:16", grid.NO_SL, 7.0, -4.0, dte=1),
            _row(d1, "09:45", grid.NO_SL, -1.0, -1.0, dte=1),
        ],
    )
    t = view.build_view("NIFTY", "time_sl", root=tmp_path, day=d1)
    assert t["columns"] == [*range(10, 101, 10), 0]
    assert t["cells"][0][-1]["net"] == pytest.approx(3.0 * LOT)
    assert t["column_totals"][-1]["net"] == pytest.approx(1.0 * LOT)
    p = view.build_view("NIFTY", "time_sl", root=tmp_path, day=d1, metric="pct")
    assert p["cells"][0][-1]["net"] == pytest.approx(3.0 / 150.0 * 100, abs=0.01)
    ds = view.build_view("NIFTY", "date_sl", root=tmp_path, start=d1, end=d1, time="09:16")
    assert ds["columns"][-1] == 0 and ds["cells"][0][-1]["net"] == pytest.approx(3.0 * LOT)
    dt = view.build_view("NIFTY", "date_time", root=tmp_path, start=d1, end=d1, sl=grid.NO_SL)
    assert dt["cells"][0][0]["net"] == pytest.approx(3.0 * LOT)
    assert dt["cells"][0][1]["net"] == pytest.approx(-2.0 * LOT)
    assert dt["filters"]["sl"] == 0
    # weeks-to-expiry applies to it like any other level
    w = view.build_view("NIFTY", "time_sl", root=tmp_path, day=d1, weeks={3})
    assert w["cells"][0][-1] is None


def test_a_plain_build_fills_no_sl_for_days_stored_without_it(tmp_path, monkeypatch):
    d1 = date(2026, 9, 28)
    _write_rows(tmp_path, "NIFTY", [_row(d1, "09:16", 10, 5.0, -2.0, dte=1)])
    monkeypatch.setattr(store, "backtest_days", lambda *a, **k: ([d1], {}))
    calls = []

    def fake(root, underlying, day, reference):
        calls.append(day)
        return [
            grid.Cell(day, "09:16", "15:30", sl, 22000.0, EXP, 100.0, 50.0, 2.0, 2.0, False, False)
            for sl in (10, grid.NO_SL)
        ], []

    monkeypatch.setattr(grid, "day_cells", fake)
    store.build("NIFTY", tmp_path)
    assert calls == [d1]
    v = view.build_view("NIFTY", "time_sl", root=tmp_path, day=d1)
    assert v["cells"][0][-1]["net"] == pytest.approx(4.0 * LOT)
    store.build("NIFTY", tmp_path)  # now complete: nothing is rebuilt
    assert calls == [d1]


def test_pct_of_premium_and_stock_units(root, tmp_path):
    v = view.build_view("NIFTY", "time_sl", root=root, day=date(2026, 9, 28), metric="pct")
    assert v["unit"] == "pct_of_premium"
    assert v["cells"][0][0]["net"] == pytest.approx(3.0 / 150.0 * 100, abs=0.01)
    _write_rows(tmp_path, "AXISBANK", [_row(date(2026, 9, 28), "09:16", 10, 4.0, -1.0)])
    s = view.build_view("AXISBANK", "time_sl", root=tmp_path, day=date(2026, 9, 28))
    assert s["unit"] == "points_per_share" and s["lot"] is None
    assert s["cells"][0][0]["net"] == 3.0


def test_bad_requests_are_refused(root):
    with pytest.raises(view.HeatmapError):
        view.build_view("NIFTY", "nope", root=root)
    with pytest.raises(view.HeatmapError):
        view.build_view("NIFTY", "date_time", root=root, start=date(2026, 9, 1), sl=15)
    with pytest.raises(view.HeatmapError):
        view.build_view("NIFTY", "date_sl", root=root, start=date(2026, 9, 1), time="09:17")
    with pytest.raises(view.HeatmapError):
        view.build_view("NIFTY", "date_time", root=root, sl=10)
    with pytest.raises(view.HeatmapError):
        view.build_view("NOPE", "time_sl", root=root, day=DAY)


def test_an_old_layout_file_is_rebuilt_not_half_read(tmp_path):
    path = store.path_for("NIFTY", tmp_path)
    path.parent.mkdir(parents=True)
    pq.write_table(pa.table({"day": [DAY], "time": ["09:16"]}), path)
    assert store.read("NIFTY", tmp_path) is None


def test_api_routes(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    client = TestClient(create_app())
    avail = client.get("/legwise/heatmap/available").json()
    assert [u["underlying"] for u in avail["underlyings"]] == ["NIFTY"]
    assert avail["times"][0] == "09:16" and avail["stop_losses"] == list(range(10, 101, 10))
    assert avail["no_sl"] == 0 and avail["sl_levels"][-1] == 0
    ok = client.get(
        "/legwise/heatmap",
        params={"underlying": "NIFTY", "view": "time_sl", "date": "2026-09-28", "weeks": "1,0"},
    )
    assert ok.status_code == 200 and ok.json()["total"]["n"] == 3
    for bad in (
        {"underlying": "nifty;drop", "view": "time_sl"},
        {"underlying": "NIFTY", "view": "date_time", "from": "2026-09-01"},
        {"underlying": "NIFTY", "view": "time_sl", "date": "28-09-2026"},
        {"underlying": "NIFTY", "view": "time_sl", "date": "2026-09-28", "weeks": "a"},
    ):
        r = client.get("/legwise/heatmap", params=bad)
        assert r.status_code == 422 and "error" in r.json()


def test_a_mid_month_weekly_is_not_taken_for_a_monthly_expiry(tmp_path, monkeypatch):
    """Vendor days carry only the contracts collected: for a monthly underlying the nearest
    expiry can be a mid-month weekly, which must not be graded as a monthly straddle."""
    from option_backtesting.heatmap import grid as g

    mid = date(2026, 9, 17)  # a Thursday with another Thursday later in September
    day = DayData(
        day=date(2026, 9, 14),
        underlying="BANKNIFTY",
        spot=flat(50000.0),
        chain={(mid, 50000.0, "CE"): flat(300.0), (mid, 50000.0, "PE"): flat(280.0)},
        listed_expiries=[mid],
        master_lot_size=None,
    )
    monkeypatch.setattr(g, "load_day", lambda *_: day)
    cells, notes = g.day_cells(tmp_path, "BANKNIFTY", day.day)
    assert cells == [] and "month-end" in notes[0]


def test_a_forced_rebuild_drops_days_it_can_no_longer_build(tmp_path, monkeypatch):
    d1, d2 = date(2026, 9, 28), date(2026, 9, 29)
    _write_rows(
        tmp_path, "NIFTY", [_row(d1, "09:16", 10, 5.0, -2.0), _row(d2, "09:16", 10, 1.0, 1.0)]
    )
    # d1 is now excluded by data_quality; d2 still builds
    monkeypatch.setattr(
        store, "backtest_days", lambda *a, **k: ([d2], {d1: "excluded: thin_chain"})
    )

    def fake(root, underlying, day, reference):
        return [
            grid.Cell(day, "09:16", "15:30", 10, 22000.0, EXP, 100.0, 50.0, 2.0, 2.0, False, False)
        ], []

    monkeypatch.setattr(grid, "day_cells", fake)
    store.build("NIFTY", tmp_path)  # not forced: d1's old rows stay
    assert store.stored_days("NIFTY", tmp_path) == {d1, d2}
    store.build("NIFTY", tmp_path, force=True)
    assert store.stored_days("NIFTY", tmp_path) == {d2}


def test_all_stocks_pools_every_stock_as_pct_of_premium(tmp_path):
    day = date(2026, 9, 28)
    _write_rows(tmp_path, "AXISBANK", [_row(day, "09:16", 10, 5.0, -2.0, entry=(100.0, 50.0))])
    _write_rows(tmp_path, "BEL", [_row(day, "09:16", 10, 1.0, 1.0, entry=(30.0, 20.0))])
    _write_rows(tmp_path, "NIFTY", [_row(day, "09:16", 10, 99.0, 99.0)])
    names = [u["underlying"] for u in store.available(tmp_path)]
    assert store.ALL_STOCKS in names
    v = view.build_view(store.ALL_STOCKS, "time_sl", root=tmp_path, day=day, metric="value")
    assert v["unit"] == "pct_of_premium" and v["pooled"] is True
    cell = v["cells"][0][0]
    assert cell["n"] == 2  # NIFTY is not in the pool
    assert cell["net"] == pytest.approx((3.0 + 2.0) / (150.0 + 50.0) * 100, abs=0.01)
