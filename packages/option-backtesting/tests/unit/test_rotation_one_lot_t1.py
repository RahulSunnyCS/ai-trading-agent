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


def test_replay_accepts_t1_variants_and_still_refuses_unknown_names(tmp_path):
    """The real `one_lot_path` (not the stub the other tests use): a T1 pick passes the name check
    (and fails later only for want of bars), an unknown name or a path never does."""
    day = date(2026, 10, 19)
    with pytest.raises(pf.PortfolioStopError) as t1:
        pf.one_lot_path(tmp_path, day, track_names("t1")[0])
    assert "is not one of the rotation variants" not in str(t1.value)
    for bad in ("N_nothing_0917", "../strategies/rotation/N_wide_0917"):
        with pytest.raises(pf.PortfolioStopError, match="is not one of the rotation variants"):
            pf.one_lot_path(tmp_path, day, bad)


# --- the fixed base as a book (owner, 2026-10-19) -----------------------------------------------


def test_the_base_dir_leg_passes_the_name_check_and_runs_its_registered_file(tmp_path):
    """The real `one_lot_path`: the base's Dir leg is accepted by its enumerated name (and fails
    later only for want of bars); its file is `strategies/rotation_base/`, never a typed path."""
    day = date(2026, 10, 19)
    with pytest.raises(pf.PortfolioStopError) as dirn:
        pf.one_lot_path(tmp_path, day, base.DIR_NAME)
    assert "is not one of the rotation variants" not in str(dirn.value)
    assert pf.strategy_file(base.DIR_NAME) == base.BASE_DIR / f"{base.DIR_NAME}.yaml"
    assert pf.strategy_file(base.WIDE_NAME).parent.name == "rotation"
    with pytest.raises(pf.PortfolioStopError, match="is not one of the rotation variants"):
        pf.one_lot_path(tmp_path, day, "../rotation_base/N_dir_atm_0924")


def test_a_changed_base_file_is_refused_by_the_replay_as_by_the_scoring(tmp_path, monkeypatch):
    monkeypatch.setattr(base, "BASE_YAML_SHA256", "0" * 64)
    with pytest.raises(pf.PortfolioStopError, match="not the registered one"):
        pf.one_lot_path(tmp_path, date(2026, 10, 19), base.DIR_NAME)


def test_the_real_base_replay_reproduces_the_stored_base_results(tmp_path, monkeypatch):
    """No stub: the Widesl leg stored by the nightly update's own call, the Dir leg by
    `base.score_days`, then the portfolio replay of the base book with no stop must equal the
    stored base gross (`matches_log`), at 1 and at 2 lots a strategy."""
    from option_backtesting.legwise import market
    from option_backtesting.rotation import portfolio_log, update

    from .test_legwise_engine import DAY, bars
    from .test_legwise_engine import day as day_data

    # OTM1 for the Widesl leg, ATM (spot 22,010) for the Dir leg: both legs trade
    data = day_data(
        {
            (22050.0, "CE"): bars(100, {"09:16": (100, 101, 99, 100), "15:27": (82, 83, 81, 82)}),
            (21950.0, "PE"): bars(90, {"09:16": (90, 91, 89, 90), "15:27": (95, 96, 94, 95)}),
            (22000.0, "CE"): bars(150, {"15:27": (140, 141, 139, 140)}),
            (22000.0, "PE"): bars(140, {"15:27": (128, 129, 127, 128)}),
        }
    )
    monkeypatch.setenv("ATA_PORTFOLIO_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(update, "load_day", lambda r, u, d: data)
    monkeypatch.setattr(base, "load_day", lambda r, u, d: data)
    monkeypatch.setattr(market, "load_day", lambda r, u, d: data)
    pf.clear_cache()
    out = update.update_day(
        DAY, tmp_path, log=lambda _m: None, names=[base.WIDE_NAME], write_days=False
    )
    assert out["written"] == 1 and not out["errors"]
    assert base.score_days([DAY], tmp_path, log=lambda _m: None)["written"] == 1
    wide = base.read_column(base.WIDE_NAME, "gross", tmp_path)[DAY]
    dirn = base.read_column(base.base_dir(tmp_path) / f"{base.DIR_NAME}.csv", "gross")[DAY]
    assert wide != 0 and dirn != 0  # both legs traded: the check is not 0 == 0
    for lots in (1, 2):
        r = portfolio_log.base_days(DAY, DAY, None, None, tmp_path, lots_per=lots)
        assert r["errors"] == [] and len(r["rows"]) == 1
        row = r["rows"][0]["lists"]["BASE"]
        assert row["lots"] == 3 * lots
        assert row["gross_log"] == pytest.approx(lots * (2 * wide + dirn), abs=0.01)
        assert row["matches_log"] is True and row["gross_with"] == row["gross_without"]
    day = portfolio_log.base_day(DAY, None, None, tmp_path, lots_per=1)
    assert [(p["name"], p["lots"]) for p in day["picks"]] == [
        (base.WIDE_NAME, 2),
        (base.DIR_NAME, 1),
    ]
    assert day["book"]["matches_log"] is True
    pf.clear_cache()


def _base_results(root: Path, days: list[date]) -> None:
    for i, d in enumerate(days):
        base.append_dir_result(
            {"day": d.isoformat(), "net": -300.0 + 50 * i, "gross": -300.0 + 50 * i}, root
        )


@pytest.fixture
def base_paths(monkeypatch):
    """Every leg dives -4,000 an hour in, then recovers to its stored gross (base legs included)."""

    def fake(root, day, name, loaded=None):
        if name == base.DIR_NAME:
            gross = base.read_column(base.base_dir(root) / f"{name}.csv", "gross").get(day, 0.0)
        else:
            row = daylog._Results(root).row(name, day)
            gross = 0.0 if row is None else float(row["gross"])
        return crafted_path(gross)

    monkeypatch.setattr(pf, "one_lot_path", fake)


def test_the_base_book_route_rows_like_a_list_and_its_422s(world, base_paths):
    root, sc = world
    forward = [d for d in sc["forward"] if sc["events"][d] != "waiting"]
    _base_results(root, forward)
    c = TestClient(create_app())
    off = c.get("/legwise/rotation/portfolio/days?book=base&lots=1&stop=0").json()
    on = c.get("/legwise/rotation/portfolio/days?book=base&lots=1&stop=8000").json()
    assert off["book"] == "base" and [r["day"] for r in off["rows"]] == [
        d.isoformat() for d in forward
    ]
    for r in off["rows"]:
        b = r["lists"]["BASE"]
        assert b["lots"] == 3 and b["matches_log"] is True and b["gross_with"] == b["gross_without"]
    # 3 lots each diving 4,000: -12,000 combined, so the ₹8,000 stop fires every day
    assert on["totals"]["BASE"]["fired"] == len(forward)
    assert all(r["lists"]["BASE"]["gross_with"] <= -8000 for r in on["rows"])
    two = c.get("/legwise/rotation/portfolio/days?book=base&stop=0").json()
    assert two["rows"][0]["lists"]["BASE"]["gross_without"] == pytest.approx(
        2 * off["rows"][0]["lists"]["BASE"]["gross_without"], abs=0.02
    )
    day = c.get(f"/legwise/rotation/portfolio/day?day={forward[0]}&book=base&lots=1&stop=8000")
    assert day.status_code == 200, day.text
    assert day.json()["list"] == "BASE" and day.json()["book"]["stop_minute"] is not None
    assert c.get("/legwise/rotation/portfolio/day?day=2020-01-06&book=base").status_code == 404
    for q in ("book=nope", "book=base&track=t1"):
        for url in (
            f"/legwise/rotation/portfolio/days?{q}",
            f"/legwise/rotation/portfolio/day?day={forward[0]}&{q}",
        ):
            r = c.get(url)
            assert r.status_code == 422 and "error" in r.json(), url
