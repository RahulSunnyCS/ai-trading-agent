"""Derived tables (BL-034 Phase 3) on a synthetic day whose option prices are Black-76 with a
known volatility, so the forward, the IV and the ATM strike have exact expected values."""

import math
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from trading_data import derived, lake
from trading_data.db import connect

IST = ZoneInfo("Asia/Kolkata")
DAY = date(2025, 3, 10)  # a Monday; NIFTY expiries on Thursdays then
EXPIRIES = (date(2025, 3, 13), date(2025, 3, 20))
SIGMA = 0.15
STRIKES = [21800.0 + 50 * i for i in range(29)]  # 21800 .. 23200
REF = derived.Reference.load()
RATE = REF.rate(DAY)
#: (strike, type) of the contract with missing minutes, and the windows it skips
GAPPY = (22500.0, "CE")
PART_WINDOW, EMPTY_WINDOW = 10, 11


def spot_close(minute: int) -> float:
    return 22500.0 + 40.0 * math.sin(minute / 37.0) + 0.3 * minute / 10


def minute_ts(minute: int, day: date = DAY) -> datetime:
    return datetime.combine(day, time(9, 15), IST) + timedelta(minutes=minute)


def option_close(minute: int, expiry: date, strike: float, kind: str) -> float:
    end = minute_ts(minute + 1).timestamp()
    t = (datetime.combine(expiry, time(15, 30), IST).timestamp() - end) / (365 * 86400)
    df = math.exp(-RATE * t)
    forward = spot_close(minute) / df
    price = derived.black76(
        np.array([forward]),
        np.array([strike]),
        np.array([t]),
        np.array([SIGMA]),
        np.array([df]),
        np.array([kind == "CE"]),
    )[0]
    return round(float(price), 6)


def write_day(root, last_minute: int = 374, day: date = DAY) -> None:
    idx_rows = {k: [] for k in lake.BAR_SCHEMA.names}
    for m in range(last_minute + 1):
        prev = spot_close(m - 1) if m else spot_close(0)
        c = spot_close(m)
        for k, v in (
            ("instrument_id", 1),
            ("ts", minute_ts(m, day)),
            ("open", prev),
            ("high", max(prev, c)),
            ("low", min(prev, c)),
            ("close", c),
            ("volume", 0.0),
            ("oi", None),
            ("vendor_symbol", "NSE:NIFTY50-INDEX"),
        ):
            idx_rows[k].append(v)
    lake.write_parquet(
        pa.table(idx_rows).cast(lake.BAR_SCHEMA), lake.bars_1m_path(root, "index", "NIFTY", day)
    )
    opt = {k: [] for k in lake.OPT_SCHEMA.names}
    iid = 100
    for expiry in EXPIRIES:
        for strike in STRIKES:
            for kind in ("CE", "PE"):
                iid += 1
                prev = None
                for m in range(last_minute + 1):
                    c = option_close(m, expiry, strike, kind)
                    skip = (expiry, strike, kind) == (EXPIRIES[0], *GAPPY) and (
                        m // 5 == EMPTY_WINDOW or (m // 5 == PART_WINDOW and m % 5 < 3)
                    )
                    if not skip:
                        o = prev if prev is not None else c
                        for k, v in (
                            ("instrument_id", iid),
                            ("ts", minute_ts(m, day)),
                            ("open", o),
                            ("high", max(o, c)),
                            ("low", min(o, c)),
                            ("close", c),
                            ("volume", 75.0),
                            ("oi", 1000.0 + m),
                            ("expiry", expiry),
                            ("strike", strike),
                            ("option_type", kind),
                            ("vendor_symbol", f"N{iid}"),
                        ):
                            opt[k].append(v)
                        prev = c
    lake.write_parquet(
        pa.table(opt).cast(lake.OPT_SCHEMA), lake.bars_1m_path(root, "option", "NIFTY", day)
    )


@pytest.fixture
def root(tmp_path):
    write_day(tmp_path)
    return tmp_path


@pytest.fixture
def build(root):
    return derived.build_day(root, "NIFTY", DAY)


def rows(table: pa.Table) -> list[dict]:
    return table.to_pylist()


def test_black76_iv_round_trip():
    f = np.array([22500.0] * 4)
    k = np.array([22000.0, 22500.0, 22500.0, 23000.0])
    t = np.array([3 / 365] * 4)
    df = np.exp(-0.06 * t)
    call = np.array([True, True, False, False])
    price = derived.black76(f, k, t, np.array([0.12, 0.15, 0.18, 0.2]), df, call)
    iv = derived.implied_vol(price, f, k, t, df, call)
    assert iv == pytest.approx([0.12, 0.15, 0.18, 0.2], abs=1e-6)
    below = derived.implied_vol(df[:1] * 400.0, f[:1], k[:1], t[:1], df[:1], call[:1])
    assert np.isnan(below[0])  # under the discounted intrinsic of 500


def test_forward_iv_and_atm_are_recovered(build):
    chain = rows(build.chain)
    assert {r["expiry"] for r in chain} == set(EXPIRIES)
    assert len({r["bucket"] for r in chain}) == derived.N_BUCKETS
    for r in chain:
        w = (r["bucket"] - minute_ts(0)).seconds // 300
        t = r["t_years"]
        assert r["spot_close"] == pytest.approx(spot_close(5 * w + 4))
        assert r["forward"] == pytest.approx(r["spot_close"] * math.exp(RATE * t), abs=1e-3)
        atm = math.floor(r["spot_open"] / 50 + 0.5) * 50
        assert r["offset"] == round((r["strike"] - atm) / 50)
        if r["close"] >= derived.LOW_PREMIUM and r["traded"]:
            assert r["iv"] == pytest.approx(SIGMA, abs=2e-5), r
    straddle = rows(build.straddle)
    assert len(straddle) == derived.N_BUCKETS * len(EXPIRIES)
    for s in straddle:
        assert s["atm"] == math.floor(s["spot_close"] / 50 + 0.5) * 50
        assert s["straddle"] == pytest.approx(s["ce_close"] + s["pe_close"])
        assert s["atm_iv"] == pytest.approx(SIGMA, abs=2e-5)
        assert s["skew"] == pytest.approx(0.0, abs=5e-5)  # flat smile


def test_window_open_is_the_price_at_its_start(build):
    """The 1-minute engine's price at minute T is that minute's open, or the last close
    before it when nothing traded at T. A window's open must be the same number."""
    gappy = {
        (r["bucket"] - minute_ts(0)).seconds // 300: r
        for r in rows(build.chain)
        if (r["expiry"], r["strike"], r["option_type"]) == (EXPIRIES[0], *GAPPY)
    }
    exp = EXPIRIES[0]
    part = gappy[PART_WINDOW]
    assert part["open"] == pytest.approx(option_close(5 * PART_WINDOW - 1, exp, *GAPPY))
    assert part["traded"]
    empty = gappy[EMPTY_WINDOW]
    carried = option_close(5 * PART_WINDOW + 4, exp, *GAPPY)
    assert not empty["traded"]
    assert (empty["open"], empty["high"], empty["low"], empty["close"]) == pytest.approx(
        (carried,) * 4
    )
    assert empty["volume"] == 0
    assert "stale" in empty["iv_quality"]


def test_no_window_uses_later_bars(tmp_path, build):
    """Lookahead check: cut the day after minute X; every window that ends by X is unchanged."""
    cut = 5 * 30 + 4  # the last minute of window 30
    write_day(tmp_path, last_minute=cut)
    early = derived.build_day(tmp_path, "NIFTY", DAY)
    limit = minute_ts(cut + 1)
    for full_table, early_table in ((build.chain, early.chain), (build.straddle, early.straddle)):
        keep = [r for r in rows(full_table) if r["bucket"] + timedelta(minutes=5) <= limit]
        assert rows(early_table) == keep


def test_contracts_daily(build):
    daily = {(r["expiry"], r["strike"], r["option_type"]): r for r in rows(build.contracts)}
    assert len(daily) == len(EXPIRIES) * len(STRIKES) * 2
    r = daily[(EXPIRIES[0], *GAPPY)]
    assert r["bars"] == 375 - 5 - 3
    assert r["close"] == pytest.approx(option_close(374, EXPIRIES[0], *GAPPY))
    assert r["dte"] == 3


def test_rebuild_writes_versioned_files_once_and_views_read_them(root):
    report = derived.rebuild(root, ("NIFTY",), log=lambda _: None)["NIFTY"]
    assert (report.built, report.skipped_current) == (1, 0)
    for ds in derived.DATASETS:
        path = derived.derived_path(root, ds, "NIFTY", DAY)
        assert derived.file_version(path) == derived.DERIVED_VERSION
    again = derived.rebuild(root, ("NIFTY",), log=lambda _: None)["NIFTY"]
    assert (again.built, again.skipped_current) == (0, 1)
    assert derived.check_day(root, "NIFTY", DAY) == []
    with connect(root) as con:
        assert con.execute("SELECT count(*) FROM chain_snapshots_5m").fetchone()[0] > 0
        assert con.execute("SELECT count(DISTINCT expiry) FROM iv_daily").fetchone()[0] == 2


def test_iv_daily_trailing_values_ignore_later_days(tmp_path):
    days = [DAY + timedelta(days=i) for i in range(4)]  # Mon .. Thu
    for d in days:
        write_day(tmp_path, day=d)
    derived.rebuild(tmp_path, ("NIFTY",), log=lambda _: None)
    full = pq.read_table(derived.derived_path(tmp_path, "iv_daily", "NIFTY")).to_pylist()
    later = derived.derived_path(tmp_path, "straddle_series_5m", "NIFTY", days[-1])
    later.unlink()
    early = derived.build_iv_daily(tmp_path, "NIFTY").to_pylist()
    assert early == [r for r in full if r["trading_day"] < days[-1]]
    first = [r for r in full if r["trading_day"] == days[0]]
    assert [r["expiry_rank"] for r in first] == [0, 1]
    assert first[0]["atm_iv_1500"] == pytest.approx(SIGMA, abs=2e-5)
    assert first[0]["front_expiry"] == EXPIRIES[0]  # 3 days away
    assert first[0]["vix_pct_1y"] is None  # no VIX file, and too little history anyway


def test_check_flags_a_changed_file(root):
    derived.rebuild(root, ("NIFTY",), log=lambda _: None)
    path = derived.derived_path(root, "straddle_series_5m", "NIFTY", DAY)
    table = pq.read_table(path)
    pq.write_table(table.slice(1), path)
    assert derived.check_day(root, "NIFTY", DAY) == [
        "straddle_series_5m: differs from a fresh rebuild"
    ]


def test_a_contract_near_the_money_once_stays_all_day(build):
    """Kept from its first window within 10 steps of ATM to the end of the day — never dropped
    when the index moves away (a position in it must keep a price)."""
    windows: dict[tuple, list[int]] = {}
    for r in rows(build.chain):
        w = (r["bucket"] - minute_ts(0)).seconds // 300
        windows.setdefault((r["expiry"], r["strike"], r["option_type"]), []).append(w)
    for key, ws in windows.items():
        assert ws == list(range(ws[0], derived.N_BUCKETS)), key
    first = rows(build.chain)[0]
    assert first["bucket"] == minute_ts(0)
    near = {
        (r["strike"], r["option_type"]) for r in rows(build.chain)
        if r["bucket"] == minute_ts(0) and r["expiry"] == EXPIRIES[0]
    }  # fmt: skip
    assert len(near) == (2 * derived.STRIKES_EACH_SIDE + 1) * 2



def test_empty_view_placeholders_match_the_derived_schemas(tmp_path):
    """db.LAKE_VIEWS holds static placeholder columns for the derived views (so importing the
    catalog does not import numpy); they must name and type every column of the real files."""
    from trading_data.db import LAKE_VIEWS

    with connect(tmp_path / "empty") as con:
        for view, schema, parts in (
            ("chain_snapshots_5m", derived.CHAIN_SCHEMA, ["underlying", "date"]),
            ("straddle_series_5m", derived.STRADDLE_SCHEMA, ["underlying", "date"]),
            ("contracts_daily", derived.CONTRACTS_SCHEMA, ["underlying", "date"]),
            ("iv_daily", derived.IV_DAILY_SCHEMA, ["underlying"]),
        ):
            assert view in LAKE_VIEWS
            names = [r[0] for r in con.execute(f"DESCRIBE {view}").fetchall()]
            assert names == schema.names + parts, view


def test_constant_maturity_iv_interpolates_total_variance():
    half_hour = 1800 / (365 * 86400)
    t1, t2, target = 3 / 365 + half_hour, 10 / 365 + half_hour, 7 / 365
    w = 0.12**2 * t1 + (0.15**2 * t2 - 0.12**2 * t1) * (target - t1) / (t2 - t1)
    got = derived.constant_maturity_iv([(0, 0.40), (3, 0.12), (10, 0.15)])  # expiry day ignored
    assert got == pytest.approx(math.sqrt(w / target))
    assert derived.constant_maturity_iv([(7, 0.13)]) == 0.13  # one side, close enough
    assert derived.constant_maturity_iv([(20, 0.13)]) is None  # one side, too far
    assert derived.constant_maturity_iv([(0, 0.40)]) is None


def test_a_window_without_a_start_price_gets_no_strikes(root):
    """If the index's first minute is missing and nothing came before, window 0 has no price
    at its start: no ATM, so no chain rows — never the window's own later close."""
    path = lake.bars_1m_path(root, "index", "NIFTY", DAY)
    table = pq.read_table(path)
    lake.write_parquet(table.slice(1).cast(lake.BAR_SCHEMA), path)
    build = derived.build_day(root, "NIFTY", DAY)
    buckets = {r["bucket"] for r in rows(build.chain)}
    assert minute_ts(0) not in buckets
    assert minute_ts(5) in buckets
