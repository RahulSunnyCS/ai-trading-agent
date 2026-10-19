"""The Rotation page at 1 lot a strategy and the T1 Adaptive card (owner, 2026-10-19).

`lots_per` is a display override: rupee totals scale, every per-lot figure, the random-basket
percentile and the pass rule do not, and no journal entry is rewritten. `track="t1"` reads the T1
journal (list C only) and finds the track's variants in their own results folder. tmp_path only.
"""

from __future__ import annotations

import hashlib
import shutil
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.rotation import base, daylog, history, journal, readout, store
from option_backtesting.rotation import portfolio as pf
from option_backtesting.rotation.variants import track_names

from . import rotation_synth as syn
from .test_rotation_portfolio_routes import crafted_path
from .test_rotation_readout import _entry, _forward, _write

T1_NAME = "N_wide-t1s4_0917"
T1_DAYS = (date(2026, 10, 16), date(2026, 10, 21))  # on-time forward days of the scenario


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_one_lot")
    return root, syn.forward_scenario(root)


def _t1_journal(root: Path, sc: dict) -> None:
    """T1 entries on two forward days: the live entry's fields, list C only, its first core pick
    swapped for a T1 variant whose results sit in the track's own folder."""
    for i, d in enumerate(T1_DAYS):
        store.append_result(
            T1_NAME,
            {"day": d.isoformat(), "net": 500.0 + i, "gross": 500.0 + i, "costs": 0.0},
            root,
        )
        live = sc["entries"][d]
        c = live["lists"]["C"]
        fields = {k: v for k, v in live.items() if k not in ("prev", "hash", "lists")}
        fields["track"] = "t1"
        fields["lists"] = {"C": {**c, "core": [T1_NAME, *c["core"][1:]], "composite": {}}}
        journal.append(store.journal_path(root, "t1"), fields)


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    _t1_journal(root, sc)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(daylog, "now_ist", lambda: syn.NOW)
    daylog._recon_cache.clear()
    history.clear()
    pf.clear_cache()
    return root, sc


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- daylog -------------------------------------------------------------------------------------


def test_one_lot_halves_the_list_gross_and_keeps_per_lot_and_the_journal(world):
    root, _ = world
    before = _digest(store.journal_path(root))
    two = daylog.build_log(root, now=syn.NOW)
    one = daylog.build_log(root, now=syn.NOW, lots_per=1)
    assert _digest(store.journal_path(root)) == before  # nothing rewritten
    scored = [r for r in two["rows"] if r["status"] == "scored"]
    assert scored
    by_day = {r["day"]: r for r in one["rows"]}
    for row in scored:
        for key, block in row["lists"].items():
            other = by_day[row["day"]]["lists"][key]
            assert other["gross"] == pytest.approx(block["gross"] / 2, abs=0.01)
            assert other["per_lot_day"] == block["per_lot_day"]
            assert other["lots"] * 2 == block["lots"]
    assert one["lots_per_strategy"] == 1 and two["lots_per_strategy"] is None
    assert one["registered"]["lots_per_strategy"] == 2  # the recorded fact


def test_a_track_log_reads_its_own_journal_and_results(world):
    root, sc = world
    log = daylog.build_log(root, now=syn.NOW, track="t1", lots_per=1)
    assert log["track"] == "t1"
    recorded = [r for r in log["rows"] if r["source"] == "recorded"]
    assert [r["day"] for r in recorded] == [d.isoformat() for d in T1_DAYS]
    for r in recorded:
        assert list(r["lists"]) == ["C"]
        picks = r["lists"]["C"]["picks"]
        assert picks[0]["name"] == T1_NAME and picks[0]["result"] is not None
        assert r["status"] == "scored" and r["placement"] == {}
    # trading days since the track's first entry with none of its own; nothing before it
    missing = [r["day"] for r in log["rows"] if r["source"] == "missing"]
    assert missing == ["2026-10-19", "2026-10-22"]
    assert log["reconstructable"]["available"] == 0
    assert [x["key"] for x in log["registered"]["lists"]] == ["C"]
    assert daylog.build_log(root, now=syn.NOW, track="t1", source="reconstructed")["rows"] == []


def test_a_track_day_in_full_has_no_rescore_and_no_reconstruction(world):
    root, _ = world
    body = daylog.build_day(T1_DAYS[0], root, now=syn.NOW, track="t1", lots_per=1)
    assert body is not None and body["rescore"]["checked"] is False
    assert body["lists"]["C"]["lots"] == len(body["lists"]["C"]["picks"])
    assert daylog.build_day(date(2026, 9, 1), root, now=syn.NOW, track="t1") is None


# --- routes ------------------------------------------------------------------------------------


@pytest.fixture
def paths(monkeypatch):
    def fake(root, day, name, loaded=None):
        row = daylog._Results(root).row(name, day)
        return crafted_path(0.0 if row is None else float(row["gross"]))

    monkeypatch.setattr(pf, "one_lot_path", fake)


def test_portfolio_days_at_one_lot_and_for_the_track(world, paths):
    c = TestClient(create_app())
    two = c.get("/legwise/rotation/portfolio/days?stop=8000").json()
    one = c.get("/legwise/rotation/portfolio/days?stop=8000&lots=1").json()
    assert one["lots_per_strategy"] == 1 and one["rows"]
    blocks = {r["day"]: r["lists"] for r in two["rows"]}
    for row in one["rows"]:
        for key, block in row["lists"].items():
            assert block["gross_without"] == pytest.approx(
                blocks[row["day"]][key]["gross_without"] / 2, abs=0.02
            )
            assert block["matches_log"] is True
    t1 = c.get("/legwise/rotation/portfolio/days?stop=9000&lots=1&track=t1").json()
    assert t1["track"] == "t1" and set(t1["totals"]) == {"C"}
    assert [r["day"] for r in t1["rows"]] == [d.isoformat() for d in T1_DAYS]
    day = c.get(
        f"/legwise/rotation/portfolio/day?day={T1_DAYS[0]}&list=C&track=t1&lots=1&stop=9000"
    )
    assert day.status_code == 200, day.text
    assert all(p["lots"] == 1 for p in day.json()["picks"])
    assert day.json()["picks"][0]["name"] == T1_NAME


def test_the_log_and_day_routes_take_lots(world):
    c = TestClient(create_app())
    two = c.get("/legwise/rotation/log").json()
    one = c.get("/legwise/rotation/log?lots=1").json()
    gross = {r["day"]: r["lists"]["C"]["gross"] for r in two["rows"] if r["status"] == "scored"}
    assert gross
    for r in one["rows"]:
        if r["day"] in gross:
            assert r["lists"]["C"]["gross"] == pytest.approx(gross[r["day"]] / 2, abs=0.01)
    day = next(iter(gross))
    body = c.get(f"/legwise/rotation/day/{day}?lots=1").json()
    assert body["lists"]["C"]["gross"] == pytest.approx(gross[day] / 2, abs=0.01)
    for url in ("/legwise/rotation/log?lots=0", f"/legwise/rotation/day/{day}?lots=x"):
        r = c.get(url)
        assert r.status_code == 422 and "error" in r.json(), url


@pytest.mark.parametrize("query", ["track=t2", "track=core", "lots=0", "lots=11", "lots=x"])
def test_bad_track_or_lots_is_a_422(world, query):
    c = TestClient(create_app())
    for url in (
        f"/legwise/rotation/summary?{query}",
        f"/legwise/rotation/portfolio/days?{query}",
        f"/legwise/rotation/portfolio/day?day={T1_DAYS[0]}&list=C&{query}",
    ):
        r = c.get(url)
        assert r.status_code == 422, (url, r.text)
        assert "error" in r.json()


# --- the read-out -------------------------------------------------------------------------------


def test_readout_at_one_lot_halves_totals_and_keeps_every_per_lot_figure(tmp_path):
    days = _forward(tmp_path, n=12, value=lambda n, d: 100.0 + 7 * (len(n) % 5) - d.day)
    core = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
    for d in days:
        _entry(tmp_path, d, {k: list(core) for k in ("A", "B", "C", "REF")})
    two = readout.build(tmp_path, runs=200)
    one = readout.build(tmp_path, runs=200, lots_per=1)
    assert one["settings"]["lots_per_strategy"] == 1
    assert one["settings"]["registered_lots_per_strategy"] == 2
    for k, a in two["lists"].items():
        b = one["lists"][k]
        assert b["total"] == pytest.approx(a["total"] / 2)
        assert b["max_drawdown"] == pytest.approx(a["max_drawdown"] / 2)
        assert b["lots_per_day"] == a["lots_per_day"] / 2
        for same in (
            "per_lot_day",
            "max_drawdown_per_lot",
            "beats_random_pct",
            "vs_base",
            "vs_ref",
        ):
            assert b[same] == a[same]
        assert b["random"]["p50"] == pytest.approx(a["random"]["p50"] / 2)
    assert one["base"]["total"] == pytest.approx(two["base"]["total"] / 2)
    assert one["days"][0]["C_total"] == pytest.approx(two["days"][0]["C_total"] / 2)


def test_a_track_readout_reads_list_c_from_the_t1_journal_against_the_base(tmp_path):
    days = _forward(tmp_path, n=3)
    for n in track_names("t1"):
        _write(tmp_path, n, {d: 250.0 for d in days}, where="track_t1/results")
    _write(tmp_path, base.DIR_NAME, {d: 100.0 for d in days}, where="base")
    track_pick = track_names("t1")[0]
    for d in days:
        _entry(
            tmp_path,
            d,
            {k: ["N_wide_0932", "N_wide_1017", "N_dir_0947"] for k in ("A", "B", "C", "REF")},
        )
        journal.append(
            store.journal_path(tmp_path, "t1"),
            {
                "day": d.isoformat(),
                "before_first_entry": True,
                "track": "t1",
                "lists": {"C": {"core": [track_pick, "N_wide_1017", "N_dir_0947"], "buy": []}},
            },
        )
    r = readout.build(tmp_path, runs=100, track="t1", lots_per=1)
    assert r["track"] == "t1" and r["n_days"] == 3 and list(r["lists"]) == ["C"]
    c = r["lists"]["C"]
    assert c["per_lot_day"] == pytest.approx((250 + 100 + 100) / 3)
    assert c["total"] == pytest.approx(3 * 450)  # 1 lot each, 3 days
    assert c["vs_ref"] is None  # the track records no REF list
    assert c["vs_base"]["mean"] == pytest.approx(c["per_lot_day"] - r["base"]["per_lot_day"])
    # the live read-out is unchanged by the track's journal
    live = readout.build(tmp_path, runs=100)
    assert set(live["lists"]) == {"A", "B", "C", "REF"} and live["track"] is None
