"""The journal as readers see it (owner, 2026-11-09): from `EVENING_FROM`, a day's Adaptive picks
are last evening's list; the journal file and its hashes are never changed."""

from __future__ import annotations

import json
from datetime import date

from option_backtesting.rotation import entries, journal, result, store

DAY = date(2026, 11, 9)
RECORDED = ["N_dir_1117", "N_wide_0917", "N_wide_1017"]
EVENING = ["N_dir_0947", "N_wide_0917", "N_wide_1017"]


def _record(root, day=DAY, core=RECORDED, track=None):
    return journal.append(
        store.journal_path(root, track),
        {
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "before_first_entry": True,
            "lists": {
                "A": {"core": ["S_wide_0917"], "buy": []},
                "C": {
                    "core": list(core),
                    "buy": [],
                    "overridden": [],
                    "composite": {n: 0.5 for n in core},
                },
            },
        },
    )


def _evening(root, day=DAY, core=EVENING, key="adaptive", buy=()):
    path = result.tentative_path(day, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = json.loads(path.read_text()) if path.exists() else {}
    doc[key] = {"day": day.isoformat(), "sent_on": "2026-11-06", "core": core, "buy": list(buy)}
    path.write_text(json.dumps(doc))


def test_the_evening_list_replaces_list_c_and_the_recorded_block_is_kept(tmp_path):
    written = _record(tmp_path)
    _evening(tmp_path, buy=["N_buy_0917"])
    (e,) = entries.read(tmp_path)
    assert e["lists"]["C"]["core"] == EVENING and e["lists"]["C"]["buy"] == ["N_buy_0917"]
    # composites only for the names the two lists share: nothing is guessed
    assert e["lists"]["C"]["composite"] == {"N_wide_0917": 0.5, "N_wide_1017": 0.5}
    assert e["lists"]["A"] == written["lists"]["A"]  # only Adaptive has an evening list
    assert e[entries.OVERRIDE]["recorded"] == written["lists"]["C"]
    assert e[entries.OVERRIDE]["sent_on"] == "2026-11-06"
    # the file and its chain are untouched, and `raw` gives the entry back exactly
    assert journal.read(store.journal_path(tmp_path)) == [written]
    assert journal.verify(store.journal_path(tmp_path)) == []
    assert entries.raw(e) == written
    assert journal.entry_hash(entries.raw(e)) == e["hash"]


def test_a_day_before_the_rule_reads_as_recorded(tmp_path):
    early = date(2026, 11, 6)
    written = _record(tmp_path, early)
    _evening(tmp_path, early)
    assert entries.read(tmp_path) == [written]


def test_a_matching_or_missing_evening_list_leaves_the_entry_as_it_is(tmp_path):
    written = _record(tmp_path)
    assert entries.read(tmp_path) == [written]  # none saved
    _evening(tmp_path, core=RECORDED)
    (e,) = entries.read(tmp_path)
    assert e == written and entries.OVERRIDE not in e
    assert entries.raw(e) is e


def test_a_malformed_evening_list_is_ignored(tmp_path):
    written = _record(tmp_path)
    path = result.tentative_path(DAY, tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    for doc in (
        {"adaptive": "oops"},
        {"adaptive": {"day": DAY.isoformat(), "core": []}},
        {"adaptive": {"day": DAY.isoformat(), "core": [5]}},
        {"adaptive": {"day": "2026-11-10", "core": EVENING}},
    ):
        path.write_text(json.dumps(doc))
        assert entries.read(tmp_path) == [written]


def test_the_t1_journal_reads_the_t1_evening_list(tmp_path):
    _record(tmp_path, track="t1")
    _evening(tmp_path, core=["N_wide-t1s4_0917"], key="t1")
    _evening(tmp_path, core=EVENING, key="adaptive")
    (t1,) = entries.read(tmp_path, "t1")
    assert t1["lists"]["C"]["core"] == ["N_wide-t1s4_0917"]


def test_the_evening_result_scores_the_evening_list(tmp_path):
    _record(tmp_path)
    _evening(tmp_path)
    for name, value in (("N_dir_0947", 300.0), ("N_wide_0917", 100.0), ("N_wide_1017", -50.0)):
        store.append_result(name, {"day": DAY.isoformat(), "net": value, "gross": value}, tmp_path)
    r = result.calculate(DAY, tmp_path)
    assert r.gains["C"] == 350.0
    assert [n for n, _ in r.strategies["C"]] == EVENING


def test_the_stamp_follows_the_saved_lists_from_the_rule_on(tmp_path):
    assert entries.evening_stamp(tmp_path) == ()
    _evening(tmp_path, date(2026, 11, 6))
    assert entries.evening_stamp(tmp_path) == ()  # before the rule: not read as the list
    _evening(tmp_path)
    first = entries.evening_stamp(tmp_path)
    assert [name for name, *_ in first] == ["2026-11-09.tentative.json"]
