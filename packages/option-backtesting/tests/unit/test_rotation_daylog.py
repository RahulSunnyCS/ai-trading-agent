"""The rotation daily log (`rotation/daylog.py`), the placement record (`rotation/placements.py`)
and `/legwise/rotation/*` (`api/rotation_log_routes.py`).

A synthetic store is built through the real `pick.record`, so the entries are genuine hash-chained
ones; nothing touches the real TRADING_DATA_ROOT. The log reads the journal and the stored results
and never writes them: that is checked by hashing every file before and after.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.rotation import daylog, journal, pick, placements, store
from option_backtesting.rotation.lists import LISTS, LOTS_PER
from option_backtesting.rotation.score import family_index

from . import rotation_synth as syn

NOW = syn.NOW
SCENARIO_DAYS = {
    "on_time": [date(2026, 10, 12), date(2026, 10, 13), date(2026, 10, 16)],
    "late": date(2026, 10, 14),
    "missing": date(2026, 10, 15),
    "angelone": date(2026, 10, 19),
    "waiting": date(2026, 10, 22),
}


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_built")
    sc = syn.forward_scenario(root)
    return root, sc


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    """A private copy of the scenario store, the universe pinned to the synthetic variants and the
    clock set to the scenario's 'now'."""
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(daylog, "now_ist", lambda: NOW)
    daylog._recon_cache.clear()
    return root, sc


def _fingerprint(root: Path) -> dict[str, str]:
    out = {}
    for p in sorted((root / "rotation").rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            out[str(p.relative_to(root))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def _row(log: dict, day: date) -> dict:
    return next(r for r in log["rows"] if r["day"] == day.isoformat())


# --- the log: statuses ------------------------------------------------------------------------


def test_an_empty_store_gives_no_rows_and_the_registered_lists(tmp_path, monkeypatch):
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    now = datetime(2026, 10, 10, 12, 0, tzinfo=syn.IST)  # the Saturday before the first entry
    log = daylog.build_log(tmp_path, now=now)
    assert log["rows"] == [] and log["journal_entries"] == 0
    assert log["registered"]["first_day"] == "2026-10-12"
    assert [x["key"] for x in log["registered"]["lists"]] == list(LISTS)
    assert log["chain"]["intact"] is True and log["chain"]["head"] is None
    assert log["reconstructable"]["available"] == 0
    assert log["counters"]["recorded"]["days"] == 0


def test_every_state_of_a_forward_day_is_named_and_none_is_zero_filled(world):
    root, sc = world
    log = daylog.build_log(root, now=NOW)
    by_day = {r["day"]: r for r in log["rows"]}
    status = {d: by_day[d.isoformat()]["status"] for d in sc["forward"]}
    assert status[date(2026, 10, 12)] == "scored"
    assert status[date(2026, 10, 14)] == "late"
    assert status[date(2026, 10, 15)] == "not_recorded"
    assert status[date(2026, 10, 19)] == "scored"
    assert status[date(2026, 10, 22)] == "waiting"
    # Tue 20 Oct is Dussehra: not a trading day, so it is not "not recorded" either
    assert "2026-10-20" not in by_day
    assert [r["day"] for r in log["rows"]] == sorted(by_day)

    missing = by_day["2026-10-15"]
    assert (
        missing["source"] == "missing" and missing["lists"] == {} and missing["collected"] is True
    )
    assert missing["vix"] is None and missing["recorded"] is None

    waiting = by_day["2026-10-22"]
    assert "nightly update" in waiting["status_detail"]
    for block in waiting["lists"].values():
        assert block["scored"] is False and block["gross"] is None and block["per_lot_day"] is None
        assert all(p["result"] is None for p in block["picks"])
        assert block["missing"] == [p["name"] for p in block["picks"]]


def test_a_late_entry_is_shown_with_its_results_but_is_not_forward(world):
    root, _ = world
    log = daylog.build_log(root, now=NOW)
    late = _row(log, SCENARIO_DAYS["late"])
    assert late["status"] == "late" and late["recorded"]["on_time"] is False
    assert late["recorded"]["time"] == "09:41:12"
    assert "not a forward entry" in late["status_detail"]
    assert late["scored"] is True and late["lists"]["A"]["per_lot_day"] is not None
    c = log["counters"]["recorded"]
    # 8 trading days from 12 Oct, one late, one not recorded: 6 forward entries, 5 scored, 1 waiting
    assert (c["days"], c["late"], c["scored"], c["waiting"], c["not_recorded"]) == (6, 1, 5, 1, 1)


def test_the_vix_source_and_dte_source_are_what_the_entry_recorded(world):
    root, _ = world
    log = daylog.build_log(root, now=NOW)
    angel = _row(log, SCENARIO_DAYS["angelone"])
    assert angel["vix"] == {"open": 15.9, "band": "15-18", "source": "angelone"}
    assert angel["dte"]["source"] == "master"
    first = _row(log, date(2026, 10, 12))
    assert first["vix"]["source"] == "fyers"
    assert first["recorded"]["on_time"] is True and first["recorded"]["commit"] == "synth01"
    assert len(first["recorded"]["hash_short"]) == 12


def test_a_trading_day_without_an_entry_is_not_listed_until_the_entry_window_has_passed(world):
    root, _ = world
    morning = datetime(2026, 10, 23, 8, 45, tzinfo=syn.IST)  # Fri 23 Oct, before 09:17
    log = daylog.build_log(root, now=morning)
    assert "2026-10-23" not in {r["day"] for r in log["rows"]}
    assert log["entry_window_open"] is True
    after = datetime(2026, 10, 23, 9, 17, tzinfo=syn.IST)
    log = daylog.build_log(root, now=after)
    assert _row(log, date(2026, 10, 23))["status"] == "not_recorded"
    # the day-after weekend is no trading day: Sat 24 is never listed
    sat = daylog.build_log(root, now=datetime(2026, 10, 24, 12, 0, tzinfo=syn.IST))
    assert "2026-10-24" not in {r["day"] for r in sat["rows"]}


def test_not_recorded_with_no_collected_data_says_it_may_be_a_closure(world):
    root, _ = world
    now = datetime(2026, 10, 28, 12, 0, tzinfo=syn.IST)  # 23, 26, 27, 28 Oct: nothing collected
    log = daylog.build_log(root, now=now)
    row = _row(log, date(2026, 10, 26))
    assert row["status"] == "not_recorded" and row["collected"] is False
    assert "holiday list" in row["status_detail"]


# --- the log: picks and figures ---------------------------------------------------------------


def test_each_pick_carries_its_stored_one_lot_outcome_and_the_list_gross_is_two_lots(world):
    root, _ = world
    log = daylog.build_log(root, now=NOW)
    day = date(2026, 10, 13)
    row = _row(log, day)
    for block in row["lists"].values():
        total = 0.0
        for p in block["picks"]:
            stored = daylog.read_rows(p["name"], root)[day]
            assert p["result"]["gross"] == stored["gross"]
            assert p["result"]["worst_mtm"] == stored["worst_mtm"]
            assert p["result"]["stopped_by"] == stored["stopped_by"]
            assert p["result"]["n_trades"] == stored["n_trades"]
            total += stored["gross"]
        n = len(block["picks"])
        assert block["lots"] == LOTS_PER * n
        assert block["gross"] == pytest.approx(LOTS_PER * total, abs=0.02)
        assert block["per_lot_day"] == pytest.approx(total / n, abs=0.01)
        assert block["picks"][0]["start"] and block["picks"][0]["index"] in ("NIFTY", "SENSEX")


def test_a_recorded_list_is_the_journals_picks_overridden_and_buy_flags(world):
    root, sc = world
    log = daylog.build_log(root, now=NOW)
    for day, entry in sc["entries"].items():
        row = _row(log, day)
        for key, picked in entry["lists"].items():
            block = row["lists"][key]
            assert [p["name"] for p in block["picks"] if p["role"] == "core"] == picked["core"]
            assert [p["name"] for p in block["picks"] if p["role"] == "buy"] == picked["buy"]
            assert block["overridden"] is picked["overridden"]
            assert block["buy_qualified"] is bool(picked["buy"])
            for p in block["picks"]:
                assert p["composite"] == pytest.approx(picked["composite"][p["name"]], abs=1e-4)
        assert row["recorded"]["hash"] == entry["hash"]


def test_a_pick_without_a_stored_result_withholds_the_lists_gross_and_names_it(world):
    root, sc = world
    day = date(2026, 10, 13)
    entry = sc["entries"][day]
    victim = entry["lists"]["A"]["core"][0]
    path = store.results_dir(root) / f"{victim}.csv"
    kept = [ln for ln in path.read_text().splitlines() if not ln.startswith(day.isoformat())]
    path.write_text("\n".join(kept) + "\n")
    log = daylog.build_log(root, now=NOW)
    row = _row(log, day)
    assert row["status"] == "waiting" and victim in row["status_detail"]
    a = row["lists"]["A"]
    assert a["scored"] is False and a["gross"] is None and a["missing"] == [victim]
    # the picks that do have a result still show it
    assert any(p["result"] is not None for p in a["picks"] if p["name"] != victim)
    assert row["scored"] is False


def test_stop_reason_is_read_from_the_stored_text(world):
    assert daylog.stop_kind("overall SL at 14:46") == "sl"
    assert daylog.stop_kind("overall target at 11:02") == "target"
    assert daylog.stop_kind("") is None
    root, _ = world
    log = daylog.build_log(root, now=NOW)
    fired = [
        p
        for r in log["rows"]
        for b in r["lists"].values()
        for p in b["picks"]
        if p["result"] and p["result"]["stop"] == "sl"
    ]
    assert fired, "the synthetic results include stop-outs"
    assert all(p["result"]["stopped_by"].startswith("overall SL") for p in fired)


def test_counters_are_counted_from_the_forward_rows_only(world):
    root, sc = world
    log = daylog.build_log(root, now=NOW)
    c = log["counters"]["recorded"]
    forward = [d for d, e in sc["entries"].items() if e["before_first_entry"]]
    assert c["days"] == len(forward)
    for key in LISTS:
        assert c["buy_qualified"][key] == sum(
            1 for d in forward if sc["entries"][d]["lists"][key]["buy"]
        )
        assert c["widesl_minimum_applied"][key] == sum(
            1 for d in forward if sc["entries"][d]["lists"][key]["overridden"]
        )
    same = sum(
        1
        for d in forward
        if len({tuple(sorted(p["core"] + p["buy"])) for p in sc["entries"][d]["lists"].values()})
        == 1
    )
    assert c["all_lists_identical"] == same
    assert c["all_lists_identical"] + c["lists_differ"] == c["days"]
    stops = sum(
        1
        for r in log["rows"]
        if r["source"] == "recorded"
        and r["status"] != "late"
        and any(b["stops"] for b in r["lists"].values())
    )
    assert c["days_with_stop"] == stops


# --- reconstruction ---------------------------------------------------------------------------


def test_reconstructed_rows_exist_only_before_the_journal_began(world):
    root, _ = world
    log = daylog.build_log(root, source="reconstructed", now=NOW)
    days = [r["day"] for r in log["rows"]]
    assert days and max(days) < "2026-10-12"
    assert {r["source"] for r in log["rows"]} == {"reconstructed"}
    assert all(r["recorded"] is None and r["vix"]["source"] == "history" for r in log["rows"])
    assert log["reconstructable"]["available"] == 7  # 70 days of history, 63 needed


def test_a_reconstructed_day_is_what_pick_record_would_have_written(world):
    """Reconstruction calls `score_history` with the rows before the day: the day recorded the
    normal way (inputs given) must come out identical, list by list."""
    root, sc = world
    rec = daylog.reconstruction(root, syn.NAMES)
    checked = 0
    for day, entry in sc["entries"].items():
        if sc["events"][day] in ("angelone", "waiting"):
            continue  # a VIX that differs from the stored open / a day with no stored attributes
        got = rec.picks(day)
        assert got is not None
        for key, picked in entry["lists"].items():
            assert got[key]["core"] == picked["core"]
            assert got[key]["buy"] == picked["buy"]
            assert got[key]["overridden"] == picked["overridden"]
            assert got[key]["composite"] == picked["composite"]
        checked += 1
    assert checked >= 5


def test_a_later_day_cannot_move_an_earlier_reconstructed_day(world):
    root, _ = world
    day = date(2026, 10, 6)
    before = daylog.reconstruction(root, syn.NAMES).picks(day)
    for name in syn.NAMES:  # an extreme result on every later day
        p = store.results_dir(root) / f"{name}.csv"
        lines = p.read_text().splitlines()
        out = [lines[0]]
        for ln in lines[1:]:
            cells = ln.split(",")
            if cells[0] > day.isoformat():
                cells[1] = cells[2] = "99999.0"
            out.append(",".join(cells))
        p.write_text("\n".join(out) + "\n")
    daylog._recon_cache.clear()
    after = daylog.reconstruction(root, syn.NAMES).picks(day)
    assert after == before


def test_the_reconstruction_is_cached_until_a_result_file_changes(world):
    root, _ = world
    a = daylog.reconstruction(root, syn.NAMES)
    assert daylog.reconstruction(root, syn.NAMES) is a
    store.append_result(syn.NAMES[0], {"day": "2026-11-02", "net": 1.0, "gross": 1.0}, root)
    assert daylog.reconstruction(root, syn.NAMES) is not a


# --- read-only --------------------------------------------------------------------------------


def test_building_the_log_and_a_day_changes_no_file(world):
    root, sc = world
    before = _fingerprint(root)
    daylog.build_log(root, source="all", now=NOW)
    daylog.build_day(date(2026, 10, 12), root, now=NOW, names=syn.NAMES)
    daylog.build_day(date(2026, 10, 6), root, now=NOW, names=syn.NAMES)
    daylog.build_day(date(2026, 10, 15), root, now=NOW, names=syn.NAMES)
    assert _fingerprint(root) == before
    assert not placements.placements_path(root).exists()


# --- one day in full --------------------------------------------------------------------------


def test_a_day_in_full_has_the_chain_the_rescore_and_the_groups(world):
    root, sc = world
    day = date(2026, 10, 13)
    d = daylog.build_day(day, root, now=NOW, names=syn.NAMES)
    assert d is not None and d["source"] == "recorded"
    assert d["recorded"]["hash"] == sc["entries"][day]["hash"]
    assert d["recorded"]["chain_ok"] is True and d["journal_intact"] is True
    assert d["rescore"] == {"checked": True, "same_inputs": True, "same_picks": True, "differs": []}
    assert sorted(k for g in d["groups"] for k in g) == list(LISTS)
    assert d["list_info"]["A"]["weights"] == LISTS["A"].weights
    assert d["entry"]["inputs_days"] == 71  # 70 history days + 12 Oct


def test_a_rescore_notices_a_stored_result_that_changed_since_the_entry(world):
    root, sc = world
    day = date(2026, 10, 16)
    name = sc["entries"][day]["lists"]["A"]["core"][0]
    path = store.results_dir(root) / f"{name}.csv"
    lines = path.read_text().splitlines()
    cells = lines[3].split(",")  # an early history day
    cells[1] = cells[2] = "88888.0"
    lines[3] = ",".join(cells)
    path.write_text("\n".join(lines) + "\n")
    d = daylog.build_day(day, root, now=NOW, names=syn.NAMES)
    assert d["rescore"]["checked"] is True
    assert d["rescore"]["same_inputs"] is False  # the digest the entry stored no longer matches


def test_days_the_journal_and_the_history_do_not_cover_are_none(world):
    root, _ = world
    assert (
        daylog.build_day(date(2026, 10, 24), root, now=NOW, names=syn.NAMES) is None
    )  # a Saturday
    assert daylog.build_day(date(2020, 1, 6), root, now=NOW, names=syn.NAMES) is None
    assert daylog.build_day(date(2026, 10, 20), root, now=NOW, names=syn.NAMES) is None  # holiday
    missing = daylog.build_day(date(2026, 10, 15), root, now=NOW, names=syn.NAMES)
    assert missing["status"] == "not_recorded" and missing["source"] == "missing"


def test_the_start_band_agrees_with_the_rankings_family_band():
    names = [f"N_{f}_{s}" for f in ("wide", "dir", "buy") for s in ("0917", "1002", "1017", "1202",
             "1217", "1402", "1417", "1517")]  # fmt: skip
    idx = family_index(names)
    for i, a in enumerate(names):
        for j, b in enumerate(names):
            kind_a, kind_b = a.split("_")[1], b.split("_")[1]
            same_band = daylog.start_band(a.split("_")[2]) == daylog.start_band(b.split("_")[2])
            assert (idx[i] == idx[j]) == (kind_a == kind_b and same_band)


# --- the placement record ---------------------------------------------------------------------


def test_a_placement_row_is_appended_and_a_later_one_supersedes_in_the_view(world):
    root, sc = world
    day = "2026-10-12"
    t0 = datetime(2026, 10, 12, 9, 31, 7, tzinfo=syn.IST)
    r1 = placements.append(day, "A", "placed", "", root, now=t0)
    assert r1 == {
        "day": day,
        "list": "A",
        "status": "placed",
        "note": "",
        "at": "2026-10-12T09:31:07+05:30",
    }
    r2 = placements.append(
        day, "A", "changed", "  dropped the Buy leg  ", root, now=t0 + timedelta(minutes=5)
    )
    assert r2["note"] == "dropped the Buy leg"
    placements.append(day, "B", "not_placed", "AlgoTest was down", root, now=t0)
    read = placements.read(root)
    assert len(read.rows) == 3 and read.skipped == 0  # earlier rows are kept
    cur = placements.current(read.rows)
    assert cur[(day, "A")]["status"] == "changed" and cur[(day, "B")]["status"] == "not_placed"
    assert (day, "C") not in cur


def test_a_placement_never_touches_the_journal_or_the_results(world):
    root, _ = world
    before = _fingerprint(root)
    placements.append("2026-10-13", "REF", "placed", "", root)
    after = _fingerprint(root)
    changed = {k for k in after if before.get(k) != after[k]}
    assert changed == {"rotation/placements.jsonl"}
    assert journal.verify(store.journal_path(root)) == []


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (("2026-10-17", "A", "placed", ""), "no journal entry"),  # a day with no entry
        (("2026-10-15", "A", "placed", ""), "no journal entry"),  # not recorded
        (("2026-10-12", "Z", "placed", ""), "not in the 2026-10-12 entry"),
        (("2026-10-12", "A", "done", ""), "status must be one of"),
        (("2026-10-12", "A", "placed", "x" * 301), "at most 300"),
        (("2026-10-12", "A", "changed", "  "), "say what was changed"),
        (("12/10/2026", "A", "placed", ""), "YYYY-MM-DD"),
    ],
)
def test_a_bad_placement_is_refused_and_nothing_is_written(world, args, message):
    root, _ = world
    with pytest.raises(placements.PlacementError, match=message):
        placements.append(*args, root=root)
    assert not placements.placements_path(root).exists()


def test_a_torn_line_is_skipped_not_fatal_and_the_next_row_starts_a_new_line(world):
    root, _ = world
    placements.append("2026-10-12", "A", "placed", "", root)
    with placements.placements_path(root).open("a") as f:
        f.write('{"day": "2026-10-13", "li')  # killed mid-write
    read = placements.read(root)
    assert len(read.rows) == 1 and read.skipped == 1
    placements.append("2026-10-13", "A", "placed", "", root)
    read = placements.read(root)
    assert [r["day"] for r in read.rows] == ["2026-10-12", "2026-10-13"]


def test_concurrent_placements_all_land_as_whole_lines(world):
    root, _ = world
    barrier = threading.Barrier(8)

    def go(i):
        barrier.wait()
        placements.append("2026-10-12", "A", "changed", f"edit {i}", root)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    lines = placements.placements_path(root).read_text().splitlines()
    assert len(lines) == 8 and all(json.loads(ln)["list"] == "A" for ln in lines)


def test_the_log_carries_the_current_placement_per_list(world):
    root, _ = world
    placements.append("2026-10-12", "A", "placed", "", root)
    placements.append("2026-10-12", "C", "not_placed", "no time", root)
    log = daylog.build_log(root, now=NOW)
    row = _row(log, date(2026, 10, 12))
    assert set(row["placement"]) == {"A", "C"}
    assert row["placement"]["C"]["note"] == "no time"
    assert _row(log, date(2026, 10, 13))["placement"] == {}


# --- the HTTP routes --------------------------------------------------------------------------


@pytest.fixture
def client(world):
    root, _ = world
    return TestClient(create_app(root / "cache")), root


def test_log_route_returns_rows_counters_and_the_registered_lists(client):
    c, _ = client
    r = c.get("/legwise/rotation/log")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "recorded" and body["basis"] == "gross"
    assert {x["status"] for x in body["rows"]} == {"scored", "late", "not_recorded", "waiting"}
    assert body["counters"]["recorded"]["days"] == 6
    assert body["holidays"] and any(h["day"] == "2026-10-20" for h in body["holidays"])


def test_log_route_window_and_source(client):
    c, _ = client
    r = c.get("/legwise/rotation/log", params={"from": "2026-10-13", "to": "2026-10-16"})
    assert [x["day"] for x in r.json()["rows"]] == [
        "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16",
    ]  # fmt: skip
    r = c.get("/legwise/rotation/log", params={"source": "reconstructed"})
    assert {x["source"] for x in r.json()["rows"]} == {"reconstructed"}
    r = c.get("/legwise/rotation/log", params={"source": "all"})
    assert {"reconstructed", "recorded", "missing"} <= {x["source"] for x in r.json()["rows"]}


@pytest.mark.parametrize(
    "params",
    [
        {"from": "10/12/2026"},
        {"to": "2026-13-45"},
        {"from": "2026-10-20", "to": "2026-10-12"},
        {"source": "everything"},
    ],
)
def test_log_route_bad_input_is_a_422_with_an_error_field(client, params):
    c, _ = client
    r = c.get("/legwise/rotation/log", params=params)
    assert r.status_code == 422 and "error" in r.json()


def test_day_route_and_its_404(client):
    c, _ = client
    r = c.get("/legwise/rotation/day/2026-10-12")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "recorded" and set(body["lists"]) == set(LISTS)
    assert body["recorded"]["hash"] and body["rescore"]["same_picks"] is True
    assert c.get("/legwise/rotation/day/2026-10-24").status_code == 404
    bad = c.get("/legwise/rotation/day/not-a-day")
    assert bad.status_code == 422 and "error" in bad.json()


def test_placement_routes_round_trip_and_validate(client):
    c, root = client
    assert c.get("/legwise/rotation/placement").json()["current"] == []
    r = c.post(
        "/legwise/rotation/placement",
        json={"day": "2026-10-12", "list": "A", "status": "changed", "note": "swapped the Dir"},
    )
    assert r.status_code == 200 and r.json()["row"]["status"] == "changed"
    c.post(
        "/legwise/rotation/placement", json={"day": "2026-10-12", "list": "A", "status": "placed"}
    )
    got = c.get(
        "/legwise/rotation/placement", params={"from": "2026-10-12", "to": "2026-10-13"}
    ).json()
    assert [(x["list"], x["status"]) for x in got["current"]] == [("A", "placed")]
    assert [x["status"] for x in got["history"]] == ["changed", "placed"]
    # the day route and the log show it
    assert c.get("/legwise/rotation/day/2026-10-12").json()["placement"]["A"]["status"] == "placed"
    assert len(c.get("/legwise/rotation/day/2026-10-12").json()["placement_history"]) == 2

    for body in (
        {"day": "2026-10-15", "list": "A", "status": "placed"},  # no entry
        {"day": "2026-10-12", "list": "Z", "status": "placed"},
        {"day": "2026-10-12", "list": "A", "status": "maybe"},
        {"day": "2026-10-12", "list": "A", "status": "placed", "note": "x" * 301},
        {"day": "2026-10-12", "list": "A", "status": "placed", "extra": 1},
    ):
        r = c.post("/legwise/rotation/placement", json=body)
        assert r.status_code == 422, body
    assert len(placements.read(root).rows) == 2  # none of the refused ones were written


def test_a_corrupt_journal_is_an_error_not_a_partial_log(client):
    c, root = client
    with store.journal_path(root).open("a") as f:
        f.write("not json\n")
    r = c.get("/legwise/rotation/log")
    assert r.status_code == 500 and "journal" in r.json()["error"]


def test_an_unreadable_result_row_is_missing_not_nan_and_does_not_fail_the_log(client):
    c, root = client
    p = store.results_dir(root) / f"{syn.NAMES[0]}.csv"
    with p.open("a") as f:
        f.write("2026-11-30,,,0.0,,,\n")  # a row with no values
    r = c.get("/legwise/rotation/log", params={"source": "all"})
    assert r.status_code == 200  # strict JSON: no NaN anywhere
    body = r.json()
    assert any(x["source"] == "recorded" and x["status"] == "scored" for x in body["rows"])
    # the ranking's own reader cannot parse that row, so there is no reconstruction, and it says so
    assert body["reconstructable"]["error"] and body["reconstructable"]["available"] == 0
    assert not any(x["source"] == "reconstructed" for x in body["rows"])


def test_the_picks_helpers_are_the_rankings_not_a_copy(world):
    # the log reads `pick.score_history` for reconstruction rather than re-implementing it
    assert daylog.pick.score_history is pick.score_history


# --- replaying a variant's day ----------------------------------------------------------------


def _replay_day():
    from .test_legwise_engine import bars
    from .test_legwise_engine import day as day_data

    return day_data(
        {
            (22050.0, "CE"): bars(100, {"09:16": (100, 101, 99, 100), "15:27": (82, 83, 81, 82)}),
            (21950.0, "PE"): bars(90, {"09:16": (90, 91, 89, 90), "15:27": (95, 96, 94, 95)}),
        }
    )


def test_a_variants_day_replays_with_the_nightly_updates_own_call_and_matches_it(
    client, monkeypatch
):
    """The replay re-runs the variant's file with the lot-sizing date the stored result was made
    with: its gross must equal what `update_day` stored for the same day."""
    from option_backtesting.api import rotation_log_routes as routes
    from option_backtesting.rotation import update

    from .test_legwise_engine import DAY

    c, root = client
    data = _replay_day()
    monkeypatch.setattr(update, "load_day", lambda r, u, d: data)
    monkeypatch.setattr(update, "day_attributes", lambda r, d: attrs_stub(d))
    monkeypatch.setattr(routes, "load_day", lambda r, u, d: data)

    def attrs_stub(d):
        return syn.attrs_for(d)

    name = "N_wide_0917"
    path = store.results_dir(root) / f"{name}.csv"  # drop the synthetic row; let update write it
    kept = [ln for ln in path.read_text().splitlines() if not ln.startswith(DAY.isoformat())]
    path.write_text("\n".join(kept) + "\n")
    out = update.update_day(DAY, root, log=lambda _m: None, names=[name])
    assert out["written"] == 1 and not out["errors"]

    r = c.get("/legwise/rotation/forensics", params={"variant": name, "day": DAY.isoformat()})
    assert r.status_code == 200
    body = r.json()
    stored = daylog.read_rows(name, root)[DAY]["gross"]
    assert body["rotation"] == {
        "variant": name,
        "stored_gross": stored,
        "simulated_gross": stored,
        "matches_stored": True,
    }
    assert body["strategy_id"] == name and body["legs"] and body["mtm"]


def test_the_forensics_route_names_a_variant_by_its_enumerated_file_only(client, monkeypatch):
    from option_backtesting.api import rotation_log_routes as routes

    c, _ = client
    ok = {"day": "2026-09-28"}
    for bad in ("../../etc/passwd", "N_wide_9999", "bl054_wide_0917", ""):
        r = c.get("/legwise/rotation/forensics", params={"variant": bad, **ok})
        assert r.status_code == 404 and "error" in r.json(), bad
    r = c.get("/legwise/rotation/forensics", params={"variant": "N_wide_0917", "day": "28-09-2026"})
    assert r.status_code == 422
    r = c.get(
        "/legwise/rotation/forensics",
        params={"variant": "N_wide_0917", "day": "2026-09-28", "cuts": "25:99;rm"},
    )
    assert r.status_code == 422

    def missing(root, underlying, day):
        raise FileNotFoundError("no bars")

    monkeypatch.setattr(routes, "load_day", missing)
    r = c.get("/legwise/rotation/forensics", params={"variant": "N_wide_0917", **ok})
    assert r.status_code == 404 and "no collected NIFTY data" in r.json()["error"]
