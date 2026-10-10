"""Forward days against the research periods (`rotation/regime.py`, `api/rotation_regime_routes.py`).

A synthetic store is built through the real `pick.record`; index bars for the day ranges are tiny
parquet files written under the tmp root's lake. Nothing touches the real TRADING_DATA_ROOT, and
the module never writes: checked by hashing every file before and after.
"""

from __future__ import annotations

import hashlib
import shutil
from datetime import date
from pathlib import Path

import duckdb
import pytest
from fastapi.testclient import TestClient
from trading_data import lake

from option_backtesting.api import rotation_regime_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import regime

from . import rotation_synth as syn

ON_TIME = [
    date(2026, 10, 12),
    date(2026, 10, 13),
    date(2026, 10, 16),
    date(2026, 10, 19),
    date(2026, 10, 21),
    date(2026, 10, 22),
]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_regime")
    return root, syn.forward_scenario(root)


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    regime._range_cache.clear()
    rotation_regime_routes._cache.update(at=0.0, root=None, value=None)
    return root, sc


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


def _bars(root: Path, underlying: str, day: date, o: float, hi: float, lo: float) -> None:
    """One index 1-minute bar file for a day (the real files have ~375 rows; open / high / low
    are all the range needs)."""
    path = lake.bars_1m_path(root, "index", underlying, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(
        f"COPY (SELECT TIMESTAMPTZ '{day} 09:15:00+05:30' AS ts, {o} AS open, {hi} AS high, "
        f"{lo} AS low, {o} AS close UNION ALL SELECT TIMESTAMPTZ '{day} 15:29:00+05:30', "
        f"{o}, {o}, {o}, {o}) TO '{path}' (FORMAT PARQUET)"
    )
    con.close()


def _period(d: dict, pid: str) -> dict:
    return next(p for p in d["periods"] if p["id"] == pid)


def _mix(p: dict, row: str) -> dict[str, int]:
    m = p["mix"][row]
    return dict(zip(m["categories"], m["counts"], strict=True))


# --- distances --------------------------------------------------------------------------------


def test_total_variation_is_zero_for_the_same_mix_and_one_for_nothing_shared():
    assert regime.tv_distance([5, 5], [10, 10]) == pytest.approx(0.0)
    assert regime.tv_distance([10, 0], [0, 10]) == pytest.approx(1.0)
    assert regime.tv_distance([3, 1], [1, 3]) == pytest.approx(0.5)
    assert regime.tv_distance([0, 0], [1, 1]) is None


def test_two_distances_inside_the_tie_band_are_not_called_different():
    assert regime._closer({"P1": 0.20, "P2": 0.22}) == "neither"
    assert regime._closer({"P1": 0.44, "P2": 0.20}) == "P2"
    assert regime._closer({"P1": None, "P2": 0.3}) == "P2"
    assert regime._closer({"P1": None, "P2": None}) is None


# --- the periods ------------------------------------------------------------------------------


def test_forward_is_the_on_time_entries_and_uses_their_recorded_attributes(world):
    root, sc = world
    d = regime.build(root)
    fwd = _period(d, "forward")
    assert fwd["status"] == "ok" and fwd["n"] == len(ON_TIME) == d["forward_days"]
    assert fwd["from"] == "2026-10-12" and fwd["to"] == "2026-10-22"
    # the late entry (Wed 14 Oct) and the day with no entry (Thu 15 Oct) are not forward
    wk = _mix(fwd, "weekday")
    assert sum(wk.values()) == len(ON_TIME)
    assert wk["Wed"] == 1 and wk["Thu"] == 1  # 21 and 22 Oct only
    by_band: dict[str, int] = {}
    for day in ON_TIME:
        band = sc["entries"][day]["vix_band"]
        by_band[band] = by_band.get(band, 0) + 1
    got = _mix(fwd, "vix_band")
    assert {k: v for k, v in got.items() if v} == by_band
    assert d["thin"] is True and d["thin_days"] == regime.THIN_DAYS


def test_p1_is_the_history_days_in_its_window_and_p2_is_empty_here(world):
    root, sc = world
    d = regime.build(root)
    p1 = _period(d, "P1")
    in_window = [x for x in sc["history"] if date(2025, 12, 3) <= x <= date(2026, 10, 8)]
    assert p1["n"] == len(in_window) and p1["status"] == "ok"
    p2 = _period(d, "P2")
    assert p2["status"] == "empty" and p2["n"] == 0 and "no sessions" in p2["reason"]
    assert sum(_mix(p1, "weekday").values()) == p1["n"]


def test_p3_is_unavailable_with_the_reason_never_filled_in(world):
    root, _ = world
    p3 = _period(regime.build(root), "P3")
    assert p3["status"] == "unavailable" and p3["mix"] is None and p3["n"] == 0
    assert "not in the rotation store" in p3["reason"]


def test_the_vix_open_quantiles_come_from_the_period_days(world):
    root, _ = world
    p1 = _period(regime.build(root), "P1")
    q = p1["vix_open"]
    assert q["n"] == p1["n"] and q["p10"] <= q["p50"] <= q["p90"]


# --- the day range, from the lake ------------------------------------------------------------


def test_the_day_range_is_high_minus_low_over_open_in_percent(world):
    root, _ = world
    _bars(root, "NIFTY", date(2026, 10, 12), 100.0, 101.0, 99.5)  # 1.5 %
    _bars(root, "NIFTY", date(2026, 10, 13), 200.0, 202.0, 199.0)  # 1.5 %
    _bars(root, "NIFTY", date(2026, 10, 16), 100.0, 100.4, 99.8)  # 0.6 %
    d = regime.build(root)
    r = _period(d, "forward")["range"]["NIFTY"]
    assert r["n"] == 3
    assert r["p50"] == pytest.approx(1.5, abs=0.01)
    assert r["p10"] < r["p50"]
    # SENSEX has none for these days: counted as absent, not as zero
    assert _period(d, "forward")["range"]["SENSEX"]["n"] == 0


def test_an_unreadable_bar_file_costs_that_day_only(world):
    root, _ = world
    _bars(root, "NIFTY", date(2026, 10, 12), 100.0, 101.0, 99.5)
    bad = lake.bars_1m_path(root, "index", "NIFTY", date(2026, 10, 13))
    bad.write_bytes(b"not parquet")
    d = regime.build(root)
    assert _period(d, "forward")["range"]["NIFTY"]["n"] == 1


# --- the distances over the periods ----------------------------------------------------------


def test_distances_compare_forward_with_each_research_period(world):
    root, _ = world
    d = regime.build(root)
    dist = d["distances"]
    assert dist is not None
    assert [r["key"] for r in dist["rows"]] == ["vix_band", "dte_n", "dte_s", "weekday"]
    # P2 is empty here, so only P1 is a research period with sessions
    assert set(dist["overall"]) == {"P1"}
    for r in dist["rows"]:
        assert r["to"]["P1"] is None or 0.0 <= r["to"]["P1"] <= 1.0


def test_before_any_entry_the_forward_column_is_empty_with_the_reason(tmp_path):
    days = syn.weekdays(date(2026, 7, 1), 70)
    syn.build_store(tmp_path, days)
    regime._range_cache.clear()
    d = regime.build(tmp_path)
    fwd = _period(d, "forward")
    assert fwd["status"] == "empty" and "first is Mon 12 Oct" in fwd["reason"]
    assert d["distances"] is None and d["forward_days"] == 0


# --- reads only, and the route ---------------------------------------------------------------


def test_the_route_answers_and_nothing_is_written(world):
    root, _ = world
    before = _fingerprint(root)
    r = TestClient(create_app()).get("/legwise/rotation/regime")
    assert r.status_code == 200
    body = r.json()
    assert [p["id"] for p in body["periods"]] == ["P1", "P2", "P3", "forward"]
    assert body["basis"] == "sessions" and "open" in body["range_definition"]
    assert _fingerprint(root) == before
