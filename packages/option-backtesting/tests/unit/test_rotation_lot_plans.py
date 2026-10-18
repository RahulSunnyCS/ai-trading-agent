"""BL-135, lot plans tracked forward (`rotation/lot_plans.py`, `GET /legwise/rotation/lot-plans`).

The plans are pure functions of the day's recorded picks; the builder reads a journal (live or T1)
and the stored one-lot results, read-only. The synthetic stores are built through the real
`pick.record` (`rotation_synth`), so the entries, the expiring-index rule and the 09:16 message's
optional Dir are the genuine ones. tmp_path stores only; the real TRADING_DATA_ROOT is never read.
"""

from __future__ import annotations

import csv
import hashlib
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_lot_plans_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import expiry, journal, lot_plans, pick, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import is_dir, is_wide

from . import rotation_synth as syn

PRE = date(2026, 10, 16)  # Friday before tracking starts: its entry must never be read
#: the forward days and what happens on each (seed 11: the picks are fixed by the stored results)
EVENTS = {
    date(2026, 10, 19): "on_time",  # Dir picked, no expiry
    date(2026, 10, 20): "on_time",  # NIFTY expiry: the BL-122 rule day
    date(2026, 10, 21): "late",  # recorded 09:41
    date(2026, 10, 22): "on_time",  # three Widesl, no expiry
    date(2026, 10, 23): "on_time",  # NIFTY expiry, rule day
    date(2026, 10, 26): "on_time",  # three Widesl on a SENSEX expiry (rule day)
    date(2026, 10, 27): "waiting",  # three Widesl, recorded; the evening update has not run
}
T1 = ["N_p150-t1s11_0917", "S_p285-t1s22_1017", "N_wide-t1s4_1217", "S_dir-t1s5_1417"]


def _history(end: date, n: int = 70) -> list[date]:
    days, d = [], end
    while len(days) < n:
        if d.weekday() < 5:
            days.insert(0, d)
        d -= timedelta(days=1)
    return days


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((root / "rotation").rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """The forward scenario, built once: history to Thu 15 Oct, an entry on Fri 16 Oct (before
    tracking), then EVENTS. The 09:16 message's optional Dir is captured from `pick.record`."""
    root = tmp_path_factory.mktemp("lot_plans") / "TradingData"
    options: dict[date, dict] = {}
    with pytest.MonkeyPatch.context() as mp:
        mp.delenv(expiry.ENV, raising=False)
        real = pick.next_best

        def spy(hist, day, *args, **kwargs):
            out = real(hist, day, *args, **kwargs)
            options[day] = out
            return out

        mp.setattr(pick, "next_best", spy)
        syn.build_store(root, _history(date(2026, 10, 15)))
        syn.record_entry(root, PRE)
        syn.build_store(root, [PRE])
        entries = {}
        for day, event in EVENTS.items():
            at = (9, 41, 12) if event == "late" else (9, 16, 4)
            entries[day] = syn.record_entry(root, day, at)
            if event != "waiting":
                syn.build_store(root, [day])
    return root, entries, options


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, entries, options = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.delenv(expiry.ENV, raising=False)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    lot_plans._rederive_cache.clear()
    rotation_lot_plans_routes._cache.clear()
    return root, entries, options


def _build(root: Path, **kw) -> dict:
    return lot_plans.build("core", root, names=syn.NAMES, today=date(2026, 10, 27), **kw)


def _row(out: dict, day: date) -> dict:
    return next(r for r in out["rows"] if r["day"] == day.isoformat())


def _lots(row: dict, plan: str) -> dict[str, int]:
    return {x["name"]: x["lots"] for x in row["plans"][plan]["lots"]}


# --- the plans, pure --------------------------------------------------------------------------

DIR_DAY = ["N_wide_0917", "N_ditm1_1017", "S_p80_1217"]
COMP = {"N_wide_0917": 0.91, "N_ditm1_1017": 0.95, "S_p80_1217": 0.93}
THREE_WIDE = ["N_wide_0917", "S_wide_1017", "N_p80_1217"]
COMP3 = {"N_wide_0917": 0.90, "S_wide_1017": 0.92, "N_p80_1217": 0.91}


def test_as_picked_is_one_lot_on_each_core_pick_every_day():
    for expiry_day in (False, True):
        assert lot_plans.plan_lots("as_picked", DIR_DAY, COMP, expiry_day) == dict.fromkeys(
            DIR_DAY, 1
        )
        assert lot_plans.plan_lots("as_picked", THREE_WIDE, COMP3, expiry_day) == dict.fromkeys(
            THREE_WIDE, 1
        )


def test_dir_boost_doubles_the_dir_on_other_days_and_is_as_picked_on_expiry():
    got = lot_plans.plan_lots("dir_boost", DIR_DAY, COMP, False)
    assert got == {"N_wide_0917": 1, "N_ditm1_1017": 2, "S_p80_1217": 1}
    assert sum(got.values()) == 4
    assert lot_plans.plan_lots("dir_boost", DIR_DAY, COMP, True) == dict.fromkeys(DIR_DAY, 1)


def test_dir_boost_on_a_three_widesl_day_adds_the_best_unpicked_dir_at_one_lot():
    got = lot_plans.plan_lots("dir_boost", THREE_WIDE, COMP3, False, "S_dir_0917")
    assert got == {**dict.fromkeys(THREE_WIDE, 1), "S_dir_0917": 1}
    # not known: never guessed
    assert lot_plans.plan_lots("dir_boost", THREE_WIDE, COMP3, False, None) is None
    # an expiry day is As picked: the runner-up is not needed
    assert lot_plans.plan_lots("dir_boost", THREE_WIDE, COMP3, True, None) == dict.fromkeys(
        THREE_WIDE, 1
    )


def test_duo_is_the_top_widesl_and_the_dir_two_each_or_two_and_one_on_expiry():
    assert lot_plans.plan_lots("duo", DIR_DAY, COMP, False) == {"S_p80_1217": 2, "N_ditm1_1017": 2}
    assert lot_plans.plan_lots("duo", DIR_DAY, COMP, True) == {"S_p80_1217": 2, "N_ditm1_1017": 1}
    three = lot_plans.plan_lots("duo", THREE_WIDE, COMP3, False, "S_dir_0917")
    assert three == {"S_wide_1017": 2, "S_dir_0917": 2}
    assert lot_plans.plan_lots("duo", THREE_WIDE, COMP3, True, "S_dir_0917") == {
        "S_wide_1017": 2,
        "S_dir_0917": 1,
    }
    assert lot_plans.plan_lots("duo", THREE_WIDE, COMP3, True, None) is None


def test_w1_is_the_higher_recorded_composite_with_ties_by_name():
    assert lot_plans.w1(DIR_DAY, COMP) == "S_p80_1217"
    tie = {"N_wide_0917": 0.9, "S_wide_1017": 0.9, "N_p80_1217": 0.8}
    assert lot_plans.w1(THREE_WIDE, tie) == "N_wide_0917"
    assert lot_plans.dir_pick(THREE_WIDE) is None and lot_plans.dir_pick(DIR_DAY) == "N_ditm1_1017"
    # a T1 variant's family is read through its base family
    assert lot_plans.dir_pick(["N_wide_0917", "S_dir-t1s5_1417", "N_p150-t1s11_0917"]) == (
        "S_dir-t1s5_1417"
    )


def test_expiry_is_label_zero_for_either_index():
    assert lot_plans.is_expiry({"NIFTY": "0", "SENSEX": "3"})
    assert lot_plans.is_expiry({"NIFTY": "2", "SENSEX": "0"})
    assert lot_plans.is_expiry({"NIFTY": "0", "SENSEX": "0"})
    assert not lot_plans.is_expiry({"NIFTY": "1", "SENSEX": "7+"})
    assert not lot_plans.is_expiry({"NIFTY": "unknown", "SENSEX": "unknown"})


def test_brokerage_is_per_strategy_placed_and_lots_share_its_orders():
    assert lot_plans.brokerage(3) == pytest.approx(3 * 2 * 20 * 1.18)
    results = {
        "a": {"gross": 1000.0, "n_trades": 2},
        "b": {"gross": -400.0, "n_trades": 1},
    }
    one = lot_plans.plan_money({"a": 1, "b": 1}, results)
    two = lot_plans.plan_money({"a": 2, "b": 1}, results)
    assert one == {"gross": 600.0, "brokerage": 141.6, "net": 458.4}
    assert two == {"gross": 1600.0, "brokerage": 141.6, "net": 1458.4}
    assert lot_plans.plan_money({"a": 1, "c": 1}, {**results, "c": None}) is None


# --- the builder over a synthetic store -------------------------------------------------------


def test_the_scenario_has_the_days_the_tests_rely_on(world):
    _, entries, _ = world
    three_wide = {d for d, e in entries.items() if not any(map(is_dir, e["lists"]["C"]["core"]))}
    assert three_wide == {date(2026, 10, 22), date(2026, 10, 26), date(2026, 10, 27)}
    assert entries[date(2026, 10, 20)]["expiry_only"] == "NIFTY"
    assert entries[date(2026, 10, 26)]["expiry_only"] == "SENSEX"
    assert not entries[date(2026, 10, 21)]["before_first_entry"]


def test_only_forward_entries_are_read_and_each_gets_a_status(world):
    root, _, _ = world
    out = _build(root)
    assert [r["day"] for r in out["rows"]] == [d.isoformat() for d in EVENTS]
    assert PRE.isoformat() not in {r["day"] for r in out["rows"]}
    status = {r["day"]: r["status"] for r in out["rows"]}
    assert status == {
        "2026-10-19": "scored",
        "2026-10-20": "scored",
        "2026-10-21": "late",
        "2026-10-22": "scored",
        "2026-10-23": "scored",
        "2026-10-26": "scored",
        "2026-10-27": "waiting",
    }
    assert out["counts"] == {
        "scored": 5,
        "waiting": 1,
        "late": 1,
        "unverified": 0,
        "entries": 7,
    }
    assert out["chain"]["intact"] and out["message"] is None


def test_lots_per_plan_follow_the_rules_on_each_kind_of_day(world):
    root, entries, options = world
    out = _build(root)
    # a Dir day, not expiry
    d = date(2026, 10, 19)
    core = entries[d]["lists"]["C"]["core"]
    comp = entries[d]["lists"]["C"]["composite"]
    row = _row(out, d)
    assert not row["expiry"]
    the_dir = next(n for n in core if is_dir(n))
    assert _lots(row, "as_picked") == dict.fromkeys(core, 1)
    assert _lots(row, "dir_boost")[the_dir] == 2 and row["plans"]["dir_boost"]["total_lots"] == 4
    top = min((n for n in core if is_wide(n)), key=lambda n: (-comp[n], n))
    assert _lots(row, "duo") == {top: 2, the_dir: 2}
    assert row["runner_up_dir"] is None  # not needed: nothing re-derived

    # the rule day: expiry, every plan on 3 lots, the recorded (filtered) picks are used
    row = _row(out, date(2026, 10, 20))
    assert row["expiry"] and row["expiry_only"] == "NIFTY"
    assert {p: row["plans"][p]["total_lots"] for p in lot_plans.PLANS} == dict.fromkeys(
        lot_plans.PLANS, 3
    )
    assert set(_lots(row, "as_picked")) == set(entries[date(2026, 10, 20)]["lists"]["C"]["core"])

    # three Widesl, not expiry: the 09:16 message's optional Dir is added
    d = date(2026, 10, 22)
    row = _row(out, d)
    runner = options[d]["C"]["dir"]
    assert row["runner_up_dir"] == {"verified": True, "dir": runner, "note": None}
    assert _lots(row, "dir_boost") == {
        **dict.fromkeys(entries[d]["lists"]["C"]["core"], 1),
        runner: 1,
    }
    assert _lots(row, "duo")[runner] == 2 and row["plans"]["duo"]["total_lots"] == 4
    assert any(x["runner_up"] for x in row["plans"]["duo"]["lots"])

    # three Widesl on a rule (expiry) day: the runner-up comes from the expiring index
    d = date(2026, 10, 26)
    row = _row(out, d)
    runner = options[d]["C"]["dir"]
    assert runner.startswith("S_") and row["runner_up_dir"]["dir"] == runner
    assert _lots(row, "dir_boost") == dict.fromkeys(entries[d]["lists"]["C"]["core"], 1)
    assert _lots(row, "duo")[runner] == 1 and row["plans"]["duo"]["total_lots"] == 3


def test_figures_are_one_lot_results_times_lots_less_brokerage(world):
    root, _, _ = world
    out = _build(root)
    row = _row(out, date(2026, 10, 19))
    for plan in lot_plans.PLANS:
        p = row["plans"][plan]
        gross = sum(x["lots"] * x["gross"] for x in p["lots"])
        cost = sum(lot_plans.brokerage(x["n_trades"]) for x in p["lots"])
        assert p["gross"] == pytest.approx(gross, abs=0.01)
        assert p["brokerage"] == pytest.approx(cost, abs=0.01)
        assert p["net"] == pytest.approx(gross - cost, abs=0.01)
        stored = lot_plans.read_results(p["lots"][0]["name"], root)[date(2026, 10, 19)]
        assert p["lots"][0]["gross"] == stored["gross"]
    # As picked and Dir Boost place the same strategies: the same brokerage
    assert row["plans"]["as_picked"]["brokerage"] == row["plans"]["dir_boost"]["brokerage"]


def test_waiting_and_late_days_are_shown_but_never_counted(world):
    root, _, _ = world
    out = _build(root)
    waiting = _row(out, date(2026, 10, 27))
    assert all(waiting["plans"][p]["net"] is None for p in lot_plans.PLANS)  # never zero
    assert "result not stored (data excluded or evening run pending)" in waiting["note"]
    late = _row(out, date(2026, 10, 21))
    assert late["note"].startswith("recorded at 09:41:12")
    assert late["plans"]["as_picked"]["net"] is not None  # its figures exist, but are not counted
    scored = [r for r in out["rows"] if r["status"] == "scored"]
    for summary in out["plans"]:
        p = summary["plan"]
        nets = [r["plans"][p]["net"] for r in scored]
        assert summary["days"] == 5
        assert summary["net"] == pytest.approx(sum(nets), abs=0.05)
        assert summary["net_per_day"] == pytest.approx(np.mean(nets))
        assert summary["max_drawdown"] == pytest.approx(max_drawdown(np.array(nets)))
        assert summary["worst_day"]["net"] == pytest.approx(min(nets))
        assert summary["lot_days"] == sum(r["plans"][p]["total_lots"] for r in scored)
    assert [c["day"] for c in out["cumulative"]] == [r["day"] for r in scored]
    last = out["cumulative"][-1]
    for summary in out["plans"]:
        assert last[summary["plan"]] == pytest.approx(summary["net"], abs=0.05)


def test_lots_today_are_the_newest_entrys_when_it_is_today(world):
    root, _, _ = world
    out = _build(root)
    assert {p["plan"]: p["lots_today"] for p in out["plans"]} == {
        "as_picked": 3,
        "dir_boost": 4,
        "duo": 4,
    }
    later = lot_plans.build("core", root, names=syn.NAMES, today=date(2026, 10, 28))
    assert all(p["lots_today"] is None for p in later["plans"])


def test_a_re_derivation_that_does_not_reproduce_the_entry_is_unverified(world):
    root, _, _ = world
    assert _build(root)["counts"]["unverified"] == 0  # verified answers are now cached
    # rewrite one stored result of a history day: the inputs the pick read are no longer there
    path = store.result_path(syn.NAMES[0], root)
    rows = list(csv.DictReader(path.open()))
    rows[0]["net"] = rows[0]["gross"] = str(float(rows[0]["gross"]) + 1234.0)
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=store.RESULT_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    out = _build(root)  # the cache is keyed on the files' stamp: no restart needed to see it
    for d in (date(2026, 10, 22), date(2026, 10, 26)):
        row = _row(out, d)
        assert row["status"] == "unverified"
        assert row["runner_up_dir"]["verified"] is False
        assert "differ" in row["note"]
        assert row["plans"]["duo"]["lots"] == [] and row["plans"]["duo"]["net"] is None
        assert row["plans"]["as_picked"]["total_lots"] == 3  # As picked needs no re-derivation
    # 27 Oct (three Widesl, results not stored yet) cannot be verified either
    assert _row(out, date(2026, 10, 27))["status"] == "unverified"
    assert out["counts"]["unverified"] == 3 and out["counts"]["scored"] == 3
    assert all(p["days"] == 3 for p in out["plans"])


def test_history_source_gives_the_picks_own_history(world):
    root, entries, _ = world
    source = lot_plans.HistorySource(root, syn.NAMES)
    for d in (date(2026, 10, 19), date(2026, 10, 22), date(2026, 10, 26)):
        mine = source.history(d)
        theirs = pick.load_history(d, root, syn.NAMES)
        assert mine.digest == theirs.digest == entries[d]["inputs_sha"]
        sliced = source.history(d, n_days=entries[d]["inputs_days"])
        assert sliced.digest == entries[d]["inputs_sha"]
        assert mine.days == theirs.days and np.array_equal(mine.values, theirs.values)
        assert (mine.weekday, mine.band, mine.dte_n, mine.dte_s) == (
            theirs.weekday,
            theirs.band,
            theirs.dte_n,
            theirs.dte_s,
        )


def test_the_builder_writes_nothing(world):
    root, _, _ = world
    before = _fingerprint(root)
    _build(root)
    lot_plans.build("t1", root, names=syn.NAMES, today=date(2026, 10, 27))
    assert _fingerprint(root) == before


def test_an_empty_store_says_tracking_starts_on_monday(tmp_path):
    out = lot_plans.build("core", tmp_path, names=syn.NAMES, today=date(2026, 10, 18))
    assert out["rows"] == [] and out["cumulative"] == []
    assert out["message"].startswith("Tracking starts Mon 19 Oct")
    ro = out["readout"]
    assert (ro["status"], ro["days"], ro["needed"], ro["from"]) == ("n/a", 0, 60, None)
    later = lot_plans.build("core", tmp_path, names=syn.NAMES, today=date(2026, 10, 21))
    assert later["message"] == "No forward entries yet in this book's journal."
    assert all(p["days"] == 0 and p["net_per_day"] is None for p in out["plans"])
    assert lot_plans.render(out).count("Tracking starts") == 1
    with pytest.raises(lot_plans.LotPlanError):
        lot_plans.build("both", tmp_path, names=syn.NAMES)


def test_the_t1_book_reads_its_own_journal_and_track_results(tmp_path, monkeypatch):
    monkeypatch.delenv(expiry.ENV, raising=False)
    root = tmp_path / "TradingData"
    names = syn.NAMES + T1
    syn.build_store(root, _history(date(2026, 10, 16)), names)
    monkeypatch.setattr(pick, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(pick, "track_names", lambda t: T1)
    monkeypatch.setattr(pick, "code_commit", lambda: "synth01")
    for day in (date(2026, 10, 19), date(2026, 10, 20)):
        labels = syn.attrs_for(day)
        dte = {k: syn.from_calendar_label(labels[k], day) for k in ("dte_n", "dte_s")}
        monkeypatch.setattr(pick, "listed_dte_labels", lambda d, dte=dte: (dte, "master"))
        at = datetime(day.year, day.month, day.day, 9, 16, 5, tzinfo=syn.IST)
        pick.record(day, root, vix_open=14.01, now_fn=lambda at=at: at, track="t1")
        syn.build_store(root, [day], names)
    assert not store.journal_path(root).exists()
    t1 = lot_plans.build("t1", root, names=names, today=date(2026, 10, 20))
    assert [r["status"] for r in t1["rows"]] == ["scored", "scored"]
    assert all(r["book"] == "t1" for r in t1["rows"])
    for r in t1["rows"]:
        for x in r["plans"]["as_picked"]["lots"]:
            d = date.fromisoformat(r["day"])
            assert x["gross"] == lot_plans.read_results(x["name"], root)[d]["gross"]
    # the T1 variants' results live in the track's folder, and are read from there
    assert store.result_path(T1[0], root).parent == store.track_dir("t1", root) / "results"
    assert lot_plans.read_results(T1[0], root)
    core = lot_plans.build("core", root, names=syn.NAMES, today=date(2026, 10, 20))
    assert core["rows"] == [] and core["message"].startswith("No forward entries yet")
    assert journal.verify(store.journal_path(root, "t1")) == []


# --- the read-out ------------------------------------------------------------------------------


def _synthetic_rows(n: int, seed: int = 3) -> list[dict]:
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        base = float(rng.normal(1000, 3000))
        expiry_day = i % 3 == 0
        rows.append(
            {
                "day": (date(2026, 10, 19) + timedelta(days=i)).isoformat(),
                "status": "scored",
                "plans": {
                    "as_picked": {"net": base, "total_lots": 3},
                    "dir_boost": {
                        "net": base + float(rng.normal(400, 300)),
                        "total_lots": 3 if expiry_day else 4,
                    },
                    "duo": {
                        "net": base + float(rng.normal(-300, 800)),
                        "total_lots": 3 if expiry_day else 4,
                    },
                },
            }
        )
    return rows


def test_the_read_out_waits_for_sixty_scored_days():
    rows = _synthetic_rows(59)
    ro = lot_plans.readout(rows)
    assert (ro["status"], ro["days"], ro["needed"]) == ("n/a", 59, 60)
    assert (ro["from"], ro["to"]) == (rows[0]["day"], rows[-1]["day"])
    assert "Log entry" in ro["note"]


def test_the_read_out_judges_the_first_sixty_days_with_the_registered_bootstrap():
    rows = _synthetic_rows(75)
    out = lot_plans.readout(rows)
    assert out["status"] == "judged" and out["judged_days"] == 60
    assert out["from"] == rows[0]["day"] and out["to"] == rows[59]["day"]
    ref = np.array([r["plans"]["as_picked"]["net"] for r in rows[:60]])
    ref_dd = max_drawdown(ref) / 3
    for plan in ("dir_boost", "duo"):
        net = np.array([r["plans"][plan]["net"] for r in rows[:60]])
        lots = np.array([r["plans"][plan]["total_lots"] for r in rows[:60]], dtype=float)
        mean, lo, hi = block_bootstrap_mean(net - ref, seed=20261019)
        got = out["plans"][plan]
        assert (got["diff_per_day"], got["lo90"], got["hi90"]) == (mean, lo, hi)
        assert got["dd_per_lot"] == pytest.approx(max_drawdown(net) / lots.mean())
        assert got["comparator_dd_per_lot"] == pytest.approx(ref_dd)
        beats = lo > 0 and got["dd_per_lot"] >= ref_dd
        assert got["verdict"] == ("beats" if beats else "costs" if hi < 0 else "inconclusive")
    assert out["after_readout"]["days"] == 15  # later days are descriptive only
    assert out["after_readout"]["from"] == rows[60]["day"]
    assert out["after_readout"]["to"] == rows[-1]["day"]
    assert "Log entry" in out["note"]
    text = lot_plans.render(
        {
            "book": "core",
            "forward_from": "2026-10-19",
            "chain": {"intact": True, "problems": []},
            "counts": {"entries": 75, "scored": 75, "waiting": 0, "late": 0, "unverified": 0},
            "message": None,
            "plans": [],
            "readout": out,
            "rows": [],
        }
    )
    assert f"read-out on 60 days {rows[0]['day']} -> {rows[59]['day']}" in text
    assert "after the read-out (15 days" in text and "Log entry" in text
    assert lot_plans.readout(rows[:60])["plans"] == out["plans"]


# --- the route --------------------------------------------------------------------------------


def test_the_route_answers_for_each_book_and_refuses_another(world, monkeypatch):
    root, _, _ = world
    monkeypatch.setattr(lot_plans, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(lot_plans, "track_names", lambda t: [])
    c = TestClient(create_app())
    core = c.get("/legwise/rotation/lot-plans", params={"book": "core"})
    assert core.status_code == 200
    body = core.json()
    assert body["book"] == "core" and body["counts"]["entries"] == 7
    assert [p["name"] for p in body["plans"]] == ["As picked", "Dir Boost", "Duo"]
    t1 = c.get("/legwise/rotation/lot-plans", params={"book": "t1"}).json()
    assert t1["rows"] == [] and t1["message"]
    bad = c.get("/legwise/rotation/lot-plans", params={"book": "x"})
    assert bad.status_code == 422 and "error" in bad.json()
    assert (root / "rotation").exists()


# --- re-deriving from what the entry saw (review fixes) ----------------------------------------


@pytest.fixture
def repaired(tmp_path, monkeypatch):
    """An entry on Mon 19 Oct ranked through Thu 15 Oct (Fri 16 Oct not collected), then Fri 16
    Oct stored afterwards, as a Fyers repair of an excluded day would be."""
    monkeypatch.delenv(expiry.ENV, raising=False)
    root = tmp_path / "TradingData"
    syn.build_store(root, _history(date(2026, 10, 15)))
    captured: dict = {}
    real = pick.next_best

    def spy(hist, day, *args, **kwargs):
        out = real(hist, day, *args, **kwargs)
        captured[day] = out
        return out

    monkeypatch.setattr(pick, "next_best", spy)
    entry = syn.record_entry(root, date(2026, 10, 19))
    monkeypatch.setattr(pick, "next_best", real)
    syn.build_store(root, [date(2026, 10, 16)])  # the repair
    lot_plans._rederive_cache.clear()
    return root, entry, captured[date(2026, 10, 19)]["C"]["dir"]


def test_a_day_stored_later_does_not_unverify_an_earlier_entry(repaired):
    root, entry, runner = repaired
    # the 09:16 job's own load now reaches 16 Oct, which the entry never saw
    assert pick.load_history(date(2026, 10, 19), root, syn.NAMES).digest != entry["inputs_sha"]
    got = lot_plans.rederive_runner_up(entry, root, syn.NAMES)
    assert got == {"verified": True, "dir": runner, "note": None}


def test_a_changed_universe_is_rebuilt_from_the_commit_or_named(repaired, monkeypatch):
    root, entry, runner = repaired
    grown = [*syn.NAMES, "S_dir-t1s9_1517"]  # a strategy file added after the pick
    got = lot_plans.rederive_runner_up(entry, root, grown, "t1")
    assert got["verified"] is False
    assert "universe has changed since the pick (40 variants then, 41 now)" in got["note"]
    # the entry's commit gives the universe back: verified again
    monkeypatch.setattr(lot_plans, "universe_at", lambda commit, book: list(syn.NAMES))
    lot_plans._rederive_cache.clear()
    assert lot_plans.rederive_runner_up(entry, root, grown, "t1")["dir"] == runner


def test_composites_and_the_vix_band_must_match_the_entry(repaired):
    root, entry, _ = repaired
    c = entry["lists"]["C"]
    first = c["core"][0]
    off = {**c, "composite": {**c["composite"], first: c["composite"][first] + 0.0001}}
    tampered = {**entry, "hash": "x1", "lists": {**entry["lists"], "C": off}}
    got = lot_plans.rederive_runner_up(tampered, root, syn.NAMES)
    assert got["verified"] is False and "composites differ" in got["note"]
    band = {**entry, "hash": "x2", "vix_band": "nonsense"}
    got = lot_plans.rederive_runner_up(band, root, syn.NAMES)
    assert got["verified"] is False and "VIX band" in got["note"]


def test_universe_at_reads_the_strategy_files_of_a_commit():
    import subprocess

    try:
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=lot_plans.REPO_PACKAGE,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("no git checkout")
    from option_backtesting.rotation.variants import track_names, variant_names

    core = lot_plans.universe_at(head + "+dirty", "core")
    if core != variant_names():  # uncommitted strategy files in this checkout
        pytest.skip("the checkout's strategy files differ from HEAD")
    assert lot_plans.universe_at(head, "t1") == variant_names() + track_names("t1")
    assert lot_plans.universe_at("unknown", "core") is None
    assert lot_plans.universe_at("0000000", "core") is None


def test_the_route_answers_an_unmounted_root_as_an_error(monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", "/Volumes/NoSuchVolume-lot-plans/TradingData")
    rotation_lot_plans_routes._cache.clear()
    r = TestClient(create_app()).get("/legwise/rotation/lot-plans", params={"book": "core"})
    assert r.status_code == 503 and "not mounted" in r.json()["error"]
