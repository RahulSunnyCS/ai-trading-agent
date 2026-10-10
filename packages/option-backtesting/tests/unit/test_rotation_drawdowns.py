"""Drawdown episodes (`rotation/drawdowns.py`, `api/rotation_drawdowns_routes.py`).

The episode finder is pure and is tested on hand-made series. The rest runs on a synthetic store
built through the real `pick.record` (140 days of results so the history can be re-scored, then
forward days: two on time, one late, one with no entry, more on time, the last not yet scored).
Nothing touches the real TRADING_DATA_ROOT and nothing is written: every file is hashed before and
after.
"""

from __future__ import annotations

import csv
import hashlib
import shutil
from datetime import date
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_drawdowns_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import base as base_mod
from option_backtesting.rotation import daylog, drawdowns, readout, store

from . import rotation_synth as syn

# --- the episode finder -----------------------------------------------------------------------


def _eps(values, min_depth=0.0):
    return drawdowns.episodes_of(np.array(values, dtype=float), min_depth)


def test_one_fall_and_recovery():
    # +10, then -4 -4 -4 (underwater -12 at the trough), then +30 (back above the peak)
    (e,) = _eps([10, -4, -4, -4, 30])
    assert e["peak"] == 0 and e["trough"] == 3 and e["end"] == 4
    assert e["depth"] == -12 and e["sessions_down"] == 3 and e["sessions_back"] == 1


def test_an_episode_that_never_recovers_is_open():
    (e,) = _eps([5, -3, -3, 1])
    assert e["end"] is None and e["sessions_back"] is None
    # cumulative 5, 2, -1, 0 against a peak of 5: underwater 0, -3, -6, -5
    assert e["depth"] == -6 and e["trough"] == 2


def test_a_series_that_starts_falling_has_its_peak_at_the_start():
    (e,) = _eps([-2, -3, 6])
    assert e["peak"] == -1 and e["sessions_down"] == 2 and e["end"] == 2


def test_the_peak_starts_at_zero_not_at_the_first_day():
    # first day is a loss: underwater from day 0 against a zero peak
    (e,) = _eps([-4, 1, 1, 1, 1, 1])
    # cumulative -4, -3, -2, -1, 0, 1: back at the zero peak on the fifth day (index 4)
    assert e["peak"] == -1 and e["depth"] == -4 and e["end"] == 4


def test_min_depth_filters_the_small_ones_and_keeps_the_rest_in_order():
    eps = _eps([10, -1, 2, -6, 3, 20, -8, 8], min_depth=5)
    assert [round(e["depth"]) for e in eps] == [-6, -8]
    assert [e["trough"] for e in eps] == [3, 6]


def test_a_flat_or_rising_series_has_no_episodes():
    assert _eps([0, 0, 0]) == []
    assert _eps([1, 2, 3]) == []
    assert drawdowns.episodes_of(np.array([]), 0) == []


def test_max_drawdown_is_the_read_outs():
    for values in ([10, -4, -4, -4, 30], [-2, -3, 6], [3, -9, 4, 2, -1]):
        arr = np.array(values, dtype=float)
        assert drawdowns.max_drawdown(arr) == readout.max_drawdown(arr)
        eps = drawdowns.episodes_of(arr, 0.0)
        assert min(e["depth"] for e in eps) == drawdowns.max_drawdown(arr)


# --- a synthetic store ------------------------------------------------------------------------


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_dd")
    return root, syn.forward_scenario(root, history=140)


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(daylog, "now_ist", lambda: syn.NOW)  # "now" is the last forward day
    daylog._recon_cache.clear()
    rotation_drawdowns_routes._cache.clear()
    drawdowns._log_cache.clear()
    return root, sc


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((root / "rotation").rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


def _write_base(root: Path, days: list[date]) -> dict[date, float]:
    """The fixed base's Dir ATM 09:24 leg for each day (its Widesl leg is the variant
    `N_wide_0917`, already in the store); returns {day: the base per lot}."""
    rng = np.random.default_rng(5)
    dirn = {d: float(rng.normal(100, 2000)) for d in days}
    path = base_mod.base_dir(root) / f"{base_mod.DIR_NAME}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(store.RESULT_COLUMNS)
        for d, v in dirn.items():
            w.writerow([d.isoformat(), v, v, 0.0, min(v, 0.0), "", 3])
    wide = base_mod.read_column(base_mod.WIDE_NAME, "gross", root)
    return {d: (2 * wide[d] + dirn[d]) / 3 for d in days if d in wide}


def test_research_window_is_the_reconstructed_days_and_says_so(world):
    root, _ = world
    out = drawdowns.build("A", "P1", 0.0, root)
    assert out["recorded_days"] == 0 and out["reconstructed_days"] == out["n_days"] > 0
    assert out["window"]["id"] == "P1" and out["window"]["from"] <= out["window"]["to"]
    assert out["basis"] == "gross" and out["unit"] == "per_lot" and out["in_sample"] is True
    cum = np.cumsum([s["per_lot"] for s in out["series"]])
    assert out["max_dd"] == pytest.approx(drawdowns.max_drawdown(np.diff(cum, prepend=0)), abs=0.01)


def test_the_deepest_episode_is_the_max_drawdown(world):
    root, _ = world
    out = drawdowns.build("B", "P1", 0.0, root)
    assert out["episodes"], "the synthetic series should fall at least once"
    assert min(e["depth"] for e in out["episodes"]) == pytest.approx(out["max_dd"], abs=0.01)
    assert out["all_episodes"] == len(out["episodes"])


def test_min_depth_hides_shallow_episodes_but_counts_them(world):
    root, _ = world
    every = drawdowns.build("A", "P1", 0.0, root)
    deep = drawdowns.build("A", "P1", 1000.0, root)
    assert all(-e["depth"] >= 1000 for e in deep["episodes"])
    assert len(deep["episodes"]) <= len(every["episodes"])
    assert deep["all_episodes"] == len(every["episodes"])


def test_drivers_add_up_to_the_episode_depth(world):
    root, _ = world
    out = drawdowns.build("A", "P1", 0.0, root)
    for e in out["episodes"]:
        assert sum(d["total"] for d in e["drivers"]) == pytest.approx(e["depth"], abs=0.05)
        assert all(d["pick_days"] > 0 for d in e["drivers"])
        assert e["drivers"] == sorted(e["drivers"], key=lambda d: (d["total"], d["label"]))


def test_the_base_over_the_same_days_is_its_own_sum_and_missing_days_are_counted(world):
    root, _ = world
    out = drawdowns.build("A", "P1", 0.0, root)
    assert out["base_max_dd"] is None and out["base_days"] == 0
    assert all(e["base_change"] is None for e in out["episodes"])

    days = [date.fromisoformat(s["day"]) for s in out["series"]]
    per_lot = _write_base(root, days[:-5])  # the last five days have no base result
    rotation_drawdowns_routes._cache.clear()
    out = drawdowns.build("A", "P1", 0.0, root)
    by_day = {s["day"]: s for s in out["series"]}
    assert out["base_days"] == len(days) - 5
    for e in out["episodes"]:
        lo = [s["day"] for s in out["series"]]
        i0 = 0 if e["peak_day"] is None else lo.index(e["peak_day"]) + 1
        i1 = lo.index(e["trough_day"])
        window = [date.fromisoformat(d) for d in lo[i0 : i1 + 1]]
        want = [per_lot[d] for d in window if d in per_lot]
        if want:
            assert e["base_change"] == pytest.approx(sum(want), abs=0.05)
        assert e["base_missing"] == sum(1 for d in window if d not in per_lot)
    assert by_day[days[-1].isoformat()]["base_per_lot"] is None  # missing, never zero


def test_forward_is_the_on_time_scored_days_and_names_what_was_left_out(world):
    root, sc = world
    out = drawdowns.build("A", "forward", 0.0, root)
    on_time_scored = [
        d
        for d, e in sc["entries"].items()
        if e["before_first_entry"] and d != date(2026, 10, 22)  # recorded, not yet scored
    ]
    assert out["n_days"] == len(on_time_scored) and out["recorded_days"] == out["n_days"]
    assert out["left_out"]["late"] == 1 and out["left_out"]["waiting"] == 1
    assert out["left_out"]["no_entry"] == 1
    assert out["in_sample"] is False


def test_last63_takes_the_latest_scored_sessions(world):
    root, _ = world
    out = drawdowns.build("C", "last63", 0.0, root)
    assert out["n_days"] == 63
    days = [s["day"] for s in out["series"]]
    assert days == sorted(days)


def test_the_current_fall_is_reported_while_underwater(world):
    root, _ = world
    out = drawdowns.build("A", "P1", 0.0, root)
    last = out["series"][-1]
    if last["underwater"] < 0:
        assert out["current"]["underwater"] == last["underwater"]
        assert out["current"]["sessions"] >= 1
    else:
        assert out["current"] is None


def test_bad_arguments_are_refused(world):
    root, _ = world
    for args in (("Z", "P1", 500.0), ("A", "fortnight", 500.0), ("A", "P1", -1.0)):
        with pytest.raises(drawdowns.DrawdownError) as e:
            drawdowns.build(*args, root=root)
        assert e.value.status == 422


def test_an_empty_store_gives_empty_series_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    daylog._recon_cache.clear()
    drawdowns._log_cache.clear()
    out = drawdowns.build("A", "P1", 500.0, tmp_path)
    assert out["n_days"] == 0 and out["series"] == [] and out["episodes"] == []
    assert out["max_dd"] == 0.0 and out["current"] is None


def test_the_route_answers_validates_and_writes_nothing(world):
    root, _ = world
    before = _fingerprint(root)
    c = TestClient(create_app())
    ok = c.get("/legwise/rotation/drawdowns?list=A&window=P1&min_depth=250")
    assert ok.status_code == 200 and ok.json()["list"] == "A" and ok.json()["min_depth"] == 250
    for url in (
        "/legwise/rotation/drawdowns?list=Z",
        "/legwise/rotation/drawdowns?window=nope",
        "/legwise/rotation/drawdowns?min_depth=-5",
        "/legwise/rotation/drawdowns?min_depth=1e9",
    ):
        r = c.get(url)
        assert r.status_code == 422 and "error" in r.json(), url
    assert _fingerprint(root) == before


# --- review fixes: crafted log rows -----------------------------------------------------------


def _row(day: str, per_lot: float, lots: int, source: str = "reconstructed", **extra) -> dict:
    n = lots // 2
    return {
        "day": day,
        "source": source,
        "status": "scored",
        "lists": {
            "A": {
                "scored": True,
                "per_lot_day": per_lot,
                "gross": per_lot * lots,
                "lots": lots,
                "stops": 0,
                "picks": [
                    {
                        "name": f"N_wide_09{i}7",
                        "kind": "wide",
                        "band": "A",
                        "result": {"gross": per_lot * 2},
                    }
                    for i in range(n)
                ],
            }
        },
        **extra,
    }


@pytest.fixture
def crafted(monkeypatch, tmp_path):
    drawdowns._log_cache.clear()
    rows = [
        _row("2025-11-20", 50, 6, source="recorded", status="late"),  # before P1: not counted
        _row("2026-03-02", 100, 6),
        _row("2026-03-03", -300, 6),
        _row("2026-03-04", -500, 8),  # a Buy day: 8 lots
        _row("2026-03-05", -400, 6),
        _row("2026-03-06", 2000, 6),
        {"day": "2026-03-09", "source": "recorded", "status": "late", "lists": {}},
        {"day": "2026-03-10", "source": "missing", "status": "not_recorded", "lists": {}},
    ]
    monkeypatch.setattr(drawdowns.daylog, "build_log", lambda *a, **k: {"rows": rows})
    return tmp_path


def test_the_basket_depth_is_what_the_lots_lost_over_the_same_days(crafted):
    out = drawdowns.build("A", "P1", 0.0, crafted)
    (e,) = out["episodes"]
    # cumulative 100, -200, -700, -1100, 900 against a peak of 100: trough on the 5th of March
    assert e["depth"] == -1200 and e["peak_day"] == "2026-03-02" and e["trough_day"] == "2026-03-05"
    # 6 + 8 + 6 lots over the three days: -1800 - 4000 - 2400, not -1200 x 8
    assert e["depth_basket"] == -8200


def test_left_out_counts_only_what_falls_inside_the_window(crafted):
    out = drawdowns.build("A", "P1", 0.0, crafted)
    # the late entry before P1 is not P1's; the late and missing rows in March are
    assert out["left_out"] == {"late": 1, "waiting": 0, "no_entry": 1}
    p2 = drawdowns.build("A", "P2", 0.0, crafted)
    assert p2["left_out"] == {"late": 0, "waiting": 0, "no_entry": 0}


def test_changing_the_depth_does_not_rebuild_the_daily_log(crafted, monkeypatch):
    calls = []
    inner = drawdowns.daylog.build_log
    monkeypatch.setattr(
        drawdowns.daylog, "build_log", lambda *a, **k: calls.append(1) or inner(*a, **k)
    )
    drawdowns._log_cache.clear()
    drawdowns.build("A", "P1", 0.0, crafted)
    drawdowns.build("A", "P1", 1000.0, crafted)
    drawdowns.build("A", "P1", 500.0, crafted)
    assert len(calls) == 1


def test_max_drawdown_is_the_read_outs_own_function():
    assert drawdowns.max_drawdown is readout.max_drawdown
