"""The Shadow scoreboard (BL-083 triggers, the override against the pick it displaces, BL-081's
forward candidates): read-only over a tmp TRADING_DATA_ROOT built from synthetic journal, results
and trigger files. Every state the page must handle: nothing yet, an entry not yet scored, a late
entry, a day before the forward window, a thin sample."""

from __future__ import annotations

import csv
import re
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_shadow_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import journal, shadow, store
from option_backtesting.rotation import triggers as T

# ---- builders ----


def _write(path: Path, columns: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for r in rows:
            w.writerow([r.get(c, "") for c in columns])


def stamp_of(entry: str) -> int:
    """The stamp whose next minute is `entry` (HH:MM): entry = 09:15 + stamp + 1."""
    return int(entry[:2]) * 60 + int(entry[3:]) - 555 - 1


class World:
    """A tmp root with the three stores; methods add one thing each."""

    def __init__(self, root: Path):
        self.root = root
        self.events: list[dict] = []
        self.sims: list[dict] = []
        self.scored: list[dict] = []

    def event(self, day, trigger, entry, und="NIFTY", detail=""):
        self.events.append(
            dict(day=day, underlying=und, trigger=trigger, stamp=stamp_of(entry), entry=entry,
                 detail=detail)
        )  # fmt: skip
        self.scored.append(dict(underlying=und, day=day))

    def sims_for(self, day, trigger, entry, und="NIFTY", template="dir", event=1000.0,
                 placebo=300.0, n_placebo=12):  # fmt: skip
        base = dict(ref_day=day, trigger=trigger, underlying=und, template=template, entry=entry)
        if event is not None:
            self.sims.append(dict(base, kind="event", day=day, net=event))
        for p in range(n_placebo):
            self.sims.append(dict(base, kind="placebo", day=f"2026-09-{p + 1:02d}", net=placebo))

    def scored_day(self, day, und="NIFTY"):
        self.scored.append(dict(underlying=und, day=day))

    def save(self):
        d = T.triggers_dir(self.root)
        _write(d / "events.csv", T.EVENT_COLUMNS, self.events)
        _write(d / "sims.csv", T.SIM_COLUMNS, self.sims)
        _write(d / "scored_days.csv", T.SCORED_COLUMNS, self.scored)

    def entry(self, day, picks: dict[str, list[str]], before=True):
        lists = {k: {"core": v, "buy": [], "overridden": False, "composite": {}}
                 for k, v in picks.items()}  # fmt: skip
        journal.append(
            store.journal_path(self.root),
            {"day": day, "lists": lists, "before_first_entry": before},
        )

    def result(self, name, day, gross):
        store.append_result(
            name, {"day": day, "net": gross, "gross": gross, "costs": 0.0, "n_trades": 3}, self.root
        )


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


#: a list whose next not-yet-started pick after 11:38 is N_wide_1202, and removing it leaves two Widesl
CORE = ["N_wide_0917", "S_wide_1032", "N_wide_1202"]
ALL_LISTS = {k: CORE for k in ("A", "B", "C", "REF")}


def rows_of(report, list_key, status=None):
    out = [r for r in report["override"]["days"] if r["list"] == list_key]
    return [r for r in out if status is None or r["status"] == status]


def list_of(report, key):
    return next(x for x in report["override"]["lists"] if x["list"] == key)


# ---- nothing yet ----


def test_an_empty_store_gives_every_row_with_zero_days_and_nothing_scored(tmp_path):
    r = shadow.report(tmp_path)
    assert r["banner"]["sessions"] == 0 and r["banner"]["with_event"] == 0
    assert r["banner"]["judged_at"] == 60 and r["banner"]["remaining"] == 60
    assert r["files"] == {"events": False, "sims": False, "scored_days": False, "journal": False}
    assert len(r["triggers"]) == 12  # 4 triggers x 3 templates, each a row even with no events
    assert all(t["days"] == 0 and t["diff"] is None and t["t"] is None for t in r["triggers"])
    assert all(t["thin"] for t in r["triggers"])
    assert r["override"]["days"] == []
    assert all(x["scored"] == 0 and x["total_basket"] is None for x in r["override"]["lists"])
    assert [c["status"] for c in r["candidates"]] == ["not_scored", "not_scored"]


def test_the_two_bl081_candidates_are_returned_not_scored_with_their_definitions(tmp_path):
    cands = shadow.report(tmp_path)["candidates"]
    assert [c["list"] for c in cands] == ["A", "C"]
    for c in cands:
        assert c["status"] == "not_scored" and "No nightly scoring" in c["reason"]
        assert c["definition"] and c["research"]["explore"] and c["research"]["confirm"]
    assert "drop" in cands[0]["definition"] and "free swap" in cands[1]["definition"]


# ---- the displaced pick ----


def test_the_displaced_pick_is_the_earliest_not_started_pick_15_minutes_after_the_entry():
    # entry 11:38: 11:53 and later count; N_wide_1202 is the earliest of those
    assert shadow.displaced_pick(CORE, "11:38") == ("N_wide_1202", "")
    # exactly 15 minutes later still counts, 14 does not
    assert shadow.displaced_pick(CORE, "11:47")[0] == "N_wide_1202"
    assert shadow.displaced_pick(CORE, "11:48")[0] is None


def test_an_event_with_no_pending_pick_is_ignored_with_the_reason():
    name, why = shadow.displaced_pick(CORE, "13:30")
    assert name is None and "no core pick starts 15 minutes or more after" in why


def test_the_override_is_skipped_when_the_widesl_minimum_would_break():
    name, why = shadow.displaced_pick(["N_wide_0917", "N_dir_1202", "S_buy_1232"], "11:38")
    assert name is None and "below the minimum 2" in why  # one Widesl is left, not two
    # a closest-premium Widesl counts as Widesl
    assert shadow.displaced_pick(["N_p80_0917", "N_wide_1032", "S_dir_1202"], "11:38")[0] == (
        "S_dir_1202"
    )


# ---- the override against the displaced pick ----


def test_a_scored_day_is_dir_at_the_event_minus_the_displaced_pick_per_lot_and_per_basket(world):
    world.event("2026-10-12", "T1", "11:38")
    world.sims_for("2026-10-12", "T1", "11:38", event=1500.0, placebo=300.0)
    world.entry("2026-10-12", ALL_LISTS)
    world.result("N_wide_1202", "2026-10-12", 800.0)
    world.save()
    r = shadow.report(world.root)
    day = rows_of(r, "B")[0]
    assert day["status"] == "scored" and day["candidate"] is True
    assert (day["trigger"], day["underlying"], day["entry"]) == ("T1", "NIFTY", "11:38")
    assert (day["displaced"], day["displaced_start"], day["displaced_gross"]) == (
        "N_wide_1202", "12:02", 800.0,
    )  # fmt: skip
    assert day["dir_net"] == 1500.0
    assert day["diff_lot"] == 700.0 and day["diff_basket"] == 1400.0  # the lists trade 2 lots
    # the time-matched placebo Dir in place of the same pick: 300 - 800, two lots
    assert day["placebo_dir"] == 300.0 and day["control_diff_basket"] == -1000.0
    b = list_of(r, "B")
    assert b["scored"] == 1 and b["total_basket"] == 1400.0 and b["mean_lot"] == 700.0
    assert b["beat_share"] == 1.0 and b["control_total_basket"] == -1000.0
    assert b["series"] == [
        {"day": "2026-10-12", "diff_basket": 1400.0, "cum_basket": 1400.0,
         "control_diff_basket": -1000.0, "cum_control": -1000.0}
    ]  # fmt: skip
    # all four lists are shown; only B and REF are the registered candidates
    assert [x["list"] for x in r["override"]["lists"] if x["candidate"]] == ["B", "REF"]
    assert r["banner"]["sessions"] == 1 and r["banner"]["with_event"] == 1


def test_a_displaced_pick_with_no_result_yet_is_pending_never_zero(world):
    world.event("2026-10-12", "T1", "11:38")
    world.sims_for("2026-10-12", "T1", "11:38")
    world.entry("2026-10-12", ALL_LISTS)  # no result stored for N_wide_1202 yet
    world.save()
    r = shadow.report(world.root)
    day = rows_of(r, "B")[0]
    assert day["status"] == "pending" and day["diff_lot"] is None and day["diff_basket"] is None
    assert "no stored result" in day["reason"] and day["displaced"] == "N_wide_1202"
    b = list_of(r, "B")
    assert b["pending"] == 1 and b["scored"] == 0 and b["total_basket"] is None
    assert b["series"] == []  # not a zero point on the chart


def test_an_event_whose_dir_simulation_is_not_stored_is_pending(world):
    world.event("2026-10-12", "T4", "11:38", detail="from_over70")
    world.sims_for("2026-10-12", "T4", "11:38", event=None, n_placebo=0)
    world.entry("2026-10-12", ALL_LISTS)
    world.result("N_wide_1202", "2026-10-12", 800.0)
    world.save()
    day = rows_of(shadow.report(world.root), "REF")[0]
    assert day["status"] == "pending" and "Dir simulation" in day["reason"]
    assert day["displaced_gross"] == 800.0 and day["dir_net"] is None


def test_a_late_entry_is_not_forward_and_counts_nowhere(world):
    world.event("2026-10-12", "T1", "11:38")
    world.sims_for("2026-10-12", "T1", "11:38")
    world.entry("2026-10-12", ALL_LISTS, before=False)
    world.result("N_wide_1202", "2026-10-12", 800.0)
    world.save()
    r = shadow.report(world.root)
    day = rows_of(r, "B")[0]
    assert day["status"] == "late_entry" and day["diff_basket"] is None
    b = list_of(r, "B")
    assert b["late_entry"] == 1 and b["scored"] == 0 and b["total_basket"] is None
    assert r["journal"]["late"] == 1 and r["journal"]["forward"] == 0
    assert b["forward_days"] == 0


def test_an_event_day_without_a_journal_entry_says_so(world):
    world.event("2026-10-13", "T1", "11:38")
    world.sims_for("2026-10-13", "T1", "11:38")
    world.save()
    day = rows_of(shadow.report(world.root), "A")[0]
    assert day["status"] == "no_entry" and "no journal entry" in day["reason"]


def test_a_day_before_the_forward_window_is_never_counted(world):
    # 9 Oct is after the research window but before the BL-058 forward window (12 Oct)
    for d in ("2026-10-08", "2026-10-09"):
        world.event(d, "T1", "11:38")
        world.sims_for(d, "T1", "11:38")
        world.entry(d, ALL_LISTS)
        world.result("N_wide_1202", d, 800.0)
    world.save()
    r = shadow.report(world.root)
    assert r["banner"]["sessions"] == 0 and r["override"]["days"] == []
    assert all(t["days"] == 0 and t["events_seen"] == 0 for t in r["triggers"])
    assert r["journal"]["entries"] == 0
    # a `from` before the window is raised to it
    assert shadow.report(world.root, date(2026, 1, 1))["window"]["from"] == "2026-10-12"


def test_the_earliest_lead_event_of_the_day_fires_across_both_indices(world):
    world.event("2026-10-12", "T4", "12:40", und="NIFTY")
    world.event("2026-10-12", "T1", "11:38", und="SENSEX")  # earlier, other index
    world.event("2026-10-12", "T2", "10:40", und="NIFTY")  # not a lead trigger
    world.sims_for("2026-10-12", "T1", "11:38", und="SENSEX", event=900.0)
    world.sims_for("2026-10-12", "T4", "12:40", und="NIFTY", event=5000.0)
    world.entry("2026-10-12", ALL_LISTS)
    world.result("N_wide_1202", "2026-10-12", 400.0)
    world.save()
    day = rows_of(shadow.report(world.root), "B")[0]
    assert (day["trigger"], day["underlying"], day["entry"]) == ("T1", "SENSEX", "11:38")
    assert day["dir_net"] == 900.0 and day["diff_lot"] == 500.0


def test_totals_and_the_running_sum_follow_the_scored_days_only(world):
    plan = [
        ("2026-10-12", 1500.0, 800.0),
        ("2026-10-13", 200.0, 900.0),
        ("2026-10-14", 600.0, None),
    ]
    for day, dir_net, gross in plan:
        world.event(day, "T1", "11:38")
        world.sims_for(day, "T1", "11:38", event=dir_net, placebo=100.0)
        world.entry(day, ALL_LISTS)
        if gross is not None:
            world.result("N_wide_1202", day, gross)
    world.save()
    b = list_of(shadow.report(world.root), "B")
    assert (b["event_days"], b["scored"], b["pending"]) == (3, 2, 1)
    assert [p["cum_basket"] for p in b["series"]] == [1400.0, 1400.0 + 2 * (200.0 - 900.0)]
    assert b["total_basket"] == b["series"][-1]["cum_basket"] == 0.0
    assert b["mean_lot"] == 0.0 and b["beat_share"] == 0.5
    assert b["forward_days"] == 3


def test_the_random_time_control_is_reported_not_recorded(world):
    c = shadow.report(world.root)["override"]["controls"]
    assert c["random_time"]["status"] == "not_recorded"
    assert "event and placebo simulations only" in c["random_time"]["reason"]
    assert c["placebo"]["status"] == "recorded"
    assert "kind" in T.SIM_COLUMNS  # the control would need a third kind next to event / placebo


def test_a_thin_placebo_gives_the_event_but_no_control_line(world):
    world.event("2026-10-12", "T1", "11:38")
    world.sims_for("2026-10-12", "T1", "11:38", event=1000.0, n_placebo=5)
    world.entry("2026-10-12", ALL_LISTS)
    world.result("N_wide_1202", "2026-10-12", 800.0)
    world.save()
    r = shadow.report(world.root)
    day = rows_of(r, "B")[0]
    assert day["status"] == "scored" and day["diff_lot"] == 200.0
    assert day["placebo_dir"] is None and day["control_diff_basket"] is None
    b = list_of(r, "B")
    assert b["control_days"] == 0 and b["control_total_basket"] is None
    assert "cum_control" not in b["series"][0]


# ---- the trigger table ----


def _trigger_days(world, n, trigger="T4", template="dir", event=900.0, placebo=300.0):
    for k in range(n):
        day = f"2026-10-{12 + k:02d}"
        world.event(day, trigger, "11:38")
        world.sims_for(day, trigger, "11:38", template=template, event=event + 10 * k,
                       placebo=placebo)  # fmt: skip


def test_the_trigger_table_is_summary_over_the_forward_window_and_t_needs_ten_days(world):
    _trigger_days(world, 9)
    world.save()
    row = next(
        t
        for t in shadow.report(world.root)["triggers"]
        if (t["trigger"], t["template"]) == ("T4", "dir")
    )
    assert row["days"] == 9 and row["thin"] is True and row["t"] is None
    assert row["candidate"] is True and row["event_avg"] == pytest.approx(940.0)
    assert row["placebo_avg"] == pytest.approx(300.0)
    assert row["diff"] == pytest.approx(640.0)

    world2 = World(world.root)
    _trigger_days(world2, 12)
    world2.save()
    rows = shadow.report(world.root)["triggers"]
    row = next(t for t in rows if (t["trigger"], t["template"]) == ("T4", "dir"))
    assert row["days"] == 12 and row["thin"] is False and row["t"] is not None
    # equal to triggers.summary(): nothing re-implemented
    s = next(x for x in T.summary(world.root, since="2026-10-12") if x["trigger"] == "T4")
    assert (row["event_avg"], row["placebo_avg"], row["diff"], row["t"]) == (
        s["event"], s["placebo"], s["diff"], s["t"],
    )  # fmt: skip
    # a cell with no events is a row, not a gap
    t1 = next(t for t in rows if (t["trigger"], t["template"]) == ("T1", "wide"))
    assert t1["days"] == 0 and t1["diff"] is None and t1["events_seen"] == 0


def test_an_event_with_too_few_placebo_days_is_seen_but_not_scored(world):
    world.event("2026-10-12", "T2", "11:08")
    world.sims_for("2026-10-12", "T2", "11:08", template="wide", n_placebo=9)
    world.save()
    row = next(
        t
        for t in shadow.report(world.root)["triggers"]
        if (t["trigger"], t["template"]) == ("T2", "wide")
    )
    assert row["events_seen"] == 1 and row["events"] == 0 and row["days"] == 0
    assert row["unscored_events"] == 1 and row["diff"] is None


def test_summary_since_until_keep_only_those_days(world):
    _trigger_days(world, 6)
    world.save()
    allrows = T.summary(world.root)
    assert allrows[0]["days"] == 6
    assert T.summary(world.root, since="2026-10-15")[0]["days"] == 3
    assert T.summary(world.root, until="2026-10-13")[0]["days"] == 2
    assert T.summary(world.root, since="2026-11-01") == []


def test_research_reference_sits_beside_the_forward_rows(tmp_path):
    rows = {(t["trigger"], t["template"]): t for t in shadow.report(tmp_path)["triggers"]}
    t1 = rows[("T1", "dir")]["research"]
    assert (t1["explore"], t1["explore_t"], t1["confirm"], t1["confirm_t"]) == (754, 3.5, -20, -0.1)
    assert rows[("T3", "wide")]["research"]["explore_t_bound"] == 0.6
    assert all(r["research"] is not None for r in rows.values())


# ---- reading is not writing ----


def _snapshot(root: Path) -> dict[str, tuple[int, int]]:
    return {
        str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns)
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_the_report_changes_no_file(world):
    _trigger_days(world, 6)
    for k in range(6):
        day = f"2026-10-{12 + k:02d}"
        world.entry(day, ALL_LISTS)
        world.result("N_wide_1202", day, 700.0)
    world.save()
    before = _snapshot(world.root)
    shadow.report(world.root)
    assert _snapshot(world.root) == before


def test_a_corrupt_journal_is_reported_not_raised(world):
    world.event("2026-10-12", "T1", "11:38")
    world.sims_for("2026-10-12", "T1", "11:38")
    world.save()
    path = store.journal_path(world.root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json\n")
    r = shadow.report(world.root)
    assert r["journal"]["error"] and r["journal"]["chain_intact"] is None
    assert rows_of(r, "A")[0]["status"] == "no_entry"
    assert "cannot be read" in rows_of(r, "A")[0]["reason"]


def test_the_chain_badge_follows_the_journal(world):
    world.entry("2026-10-12", ALL_LISTS)
    assert shadow.report(world.root)["journal"]["chain_intact"] is True
    path = store.journal_path(world.root)
    path.write_text(
        path.read_text().replace('"before_first_entry": true', '"before_first_entry": false')
    )
    assert shadow.report(world.root)["journal"]["chain_intact"] is False


# ---- research numbers are the backlog's ----


BACKLOG = Path(__file__).resolve().parents[4] / "backlog"


def _lakh(n: int) -> str:
    s = str(abs(n))
    head, tail = s[:-3], s[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    return ",".join([*groups, tail])


@pytest.mark.skipif(
    not (BACKLOG / "BL-083-event-triggered-intraday-entries.md").exists(), reason="no backlog"
)
def test_the_research_constants_are_the_numbers_in_the_backlog_tables():
    text = (BACKLOG / "BL-083-event-triggered-intraday-entries.md").read_text()
    for r in shadow.RESEARCH_OVERRIDE:
        assert _lakh(r["plain"]) in text, r
        assert _lakh(r["override"]) in text, r
        sign = "+" if r["gain"] > 0 else "−"
        assert f"{sign}{abs(r['gain']):,}" in text, r
        assert f"+{r['random_time_p90']:,}" in text and f"+{r['random_day_p90']:,}" in text, r
    for (trig, tpl), cell in shadow.RESEARCH_EVENT_STUDY.items():
        if "explore" not in cell:
            continue
        sign = "+" if cell["explore"] > 0 else "−"
        t = f"{abs(cell['explore_t']):g}"
        assert f"{sign}{abs(cell['explore'])} ({'−' if cell['explore_t'] < 0 else ''}{t})" in text, (
            trig, tpl,
        )  # fmt: skip
    # the two figures the owner named
    by = {(r["period"], r["list"]): r["gain"] for r in shadow.RESEARCH_OVERRIDE}
    assert by[("explore", "B")] == 79389 and by[("explore", "REF")] == 54556
    assert by[("confirm", "B")] == -26749 and by[("confirm", "REF")] == 16268


# ---- the route ----


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(rotation_shadow_routes, "CACHE_SECONDS", 0.0)
    rotation_shadow_routes._cache.clear()
    return TestClient(create_app(tmp_path / "cache"))


def test_the_route_returns_the_report_and_validates_dates(client, tmp_path):
    w = World(tmp_path)
    w.event("2026-10-12", "T1", "11:38")
    w.sims_for("2026-10-12", "T1", "11:38", event=1500.0, placebo=300.0)
    w.entry("2026-10-12", ALL_LISTS)
    w.result("N_wide_1202", "2026-10-12", 800.0)
    w.save()
    body = client.get("/legwise/rotation/shadow").json()
    assert body["banner"]["sessions"] == 1 and body["forward_from"] == "2026-10-12"
    assert [c["status"] for c in body["candidates"]] == ["not_scored", "not_scored"]
    b = next(x for x in body["override"]["lists"] if x["list"] == "B")
    assert b["total_basket"] == 1400.0
    narrowed = client.get("/legwise/rotation/shadow?from=2026-10-13&to=2026-10-20").json()
    assert narrowed["banner"]["sessions"] == 0 and narrowed["window"]["from"] == "2026-10-13"
    assert client.get("/legwise/rotation/shadow?from=nope").status_code == 422
    assert client.get("/legwise/rotation/shadow?from=2026-10-20&to=2026-10-13").json() == {
        "error": "from must not be after to"
    }
    assert re.search(
        r"must be YYYY-MM-DD", client.get("/legwise/rotation/shadow?to=x").json()["error"]
    )
