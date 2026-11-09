"""The journal as readers see it (owner, 2026-11-09): from `EVENING_FROM`, a day's Adaptive picks
are last evening's list; the journal file and its hashes are never changed."""

from __future__ import annotations

import json
from datetime import date

import pytest

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


# --- review of PR #443 ---------------------------------------------------------------------------


def test_an_entry_recorded_from_the_evening_list_never_changes_with_a_later_save(tmp_path):
    """From 2026-11-10 the entry itself is the evening's list (`picks_from: evening`): a list saved
    afterwards (a `result --force` resend re-ranks the session) must not move it."""
    later = date(2026, 11, 10)
    written = journal.append(
        store.journal_path(tmp_path),
        {
            "day": later.isoformat(),
            "picks_from": "evening",
            "lists": {"C": {"core": RECORDED, "buy": [], "overridden": False, "composite": {}}},
        },
    )
    _evening(tmp_path, later, EVENING)
    assert entries.read(tmp_path) == [written]


def test_the_overlaid_block_keeps_the_entrys_shape_and_rule(tmp_path):
    journal.append(
        store.journal_path(tmp_path),
        {
            "day": DAY.isoformat(),
            "expiry_only": "NIFTY",
            "lists": {
                "C": {
                    "core": RECORDED,
                    "buy": [],
                    "overridden": True,
                    "composite": {},
                    "expiry_only": "NIFTY",
                    "unfiltered": {"core": ["S_wide_0917"], "buy": []},
                }
            },
        },
    )
    _evening(tmp_path)
    (e,) = entries.read(tmp_path)
    block = e["lists"]["C"]
    assert block["overridden"] is False and block["expiry_only"] == "NIFTY"
    assert "unfiltered" not in block  # it described the recorded ranking, kept under the override
    assert e[entries.OVERRIDE]["recorded"]["unfiltered"]["core"] == ["S_wide_0917"]


def test_a_resend_never_rewrites_the_list_of_a_session_already_recorded(tmp_path):
    from option_backtesting.rotation import tomorrow

    def picks(core):
        return tomorrow.NextPicks(DAY, "Mon", core, [], None, None, {"NIFTY": "1", "SENSEX": "3"})

    result.save_tentative(date(2026, 11, 6), picks(EVENING), None, tmp_path)
    _record(tmp_path)  # the session's entry is written
    result.save_tentative(date(2026, 11, 8), picks(RECORDED), picks(["N_wide-t1s4_0917"]), tmp_path)
    doc = result.read_tentative(DAY, tmp_path)
    assert doc["adaptive"]["core"] == EVENING and doc["adaptive"]["sent_on"] == "2026-11-06"
    # T1 had no saved list and no entry: it is saved as before
    assert doc["t1"]["core"] == ["N_wide-t1s4_0917"]
    assert doc["adaptive"]["dte"] == {"NIFTY": "1", "SENSEX": "3"}


def test_the_evening_exports_read_the_list_the_message_saved(tmp_path, monkeypatch):
    from option_backtesting.rotation import algtst_export, tomorrow

    monkeypatch.setattr(
        tomorrow, "next_session_picks", lambda *a, **k: pytest.fail("must not re-rank")
    )
    _evening(tmp_path, DAY, EVENING, buy=["N_buy_0917"])
    path = result.tentative_path(DAY, tmp_path)
    doc = json.loads(path.read_text())
    doc["adaptive"]["dte"] = {"NIFTY": "1", "SENSEX": "3"}
    path.write_text(json.dumps(doc))
    p = algtst_export.preview_picks(DAY, "core", tmp_path)
    assert (p.source, p.core, p.buy, p.dte) == (
        "preview",
        EVENING,
        ["N_buy_0917"],
        {"NIFTY": "1", "SENSEX": "3"},
    )


def test_without_a_saved_list_with_its_dte_the_exports_rank_again(tmp_path, monkeypatch):
    from option_backtesting.rotation import algtst_export, tomorrow

    asked = []
    monkeypatch.setattr(
        tomorrow, "next_session_picks", lambda *a, **k: asked.append(k.get("track")) or None
    )
    _evening(tmp_path, DAY, EVENING)  # an old-format list: no dte
    assert algtst_export.preview_picks(DAY, "t1", tmp_path) is None
    assert asked == ["t1"]


# --- Codex review of PR #443 --------------------------------------------------------------------


def test_lot_plans_never_choose_duos_w1_without_a_recorded_composite(tmp_path):
    from option_backtesting.rotation import lot_plans

    entry = {
        "day": DAY.isoformat(),
        "weekday": "Mon",
        "before_first_entry": True,
        "dte": {"NIFTY": "2", "SENSEX": "3"},
        "lists": {
            "C": {
                "core": ["N_wide_0917", "N_wide_1017", "N_dir_0947"],
                "buy": [],
                # the evening's N_wide_1017 was never scored by this entry's ranking
                "composite": {"N_wide_0917": 0.4, "N_dir_0947": 0.6},
            }
        },
    }
    results = {n: {} for n in ("N_wide_0917", "N_wide_1017", "N_dir_0947")}
    row = lot_plans.day_row(entry, "core", tmp_path, [], results)
    assert row["status"] == "unverified"
    assert row["plans"]["duo"]["status"] == "unverified"
    assert "N_wide_1017" in row["note"]


def test_the_regime_card_reads_an_evening_entrys_open_from_the_collected_day():
    from option_backtesting.rotation import regime

    entries_ = [
        # recorded with the previous evening's close: its own vix fields are not the open
        {"day": "2026-11-10", "before_first_entry": True, "vix_source": "close 2026-11-09",
         "vix_open": 18.4, "vix_band": "18+", "dte": {"NIFTY": "1", "SENSEX": "3"}},
        {"day": "2026-11-11", "before_first_entry": True, "vix_source": "open 2026-11-10",
         "vix_open": 18.4, "vix_band": "18+", "dte": {"NIFTY": "0", "SENSEX": "2"}},
        # recorded at 09:16 on the observed open: read as before
        {"day": "2026-11-06", "before_first_entry": True, "vix_source": "fyers",
         "vix_open": 12.1, "vix_band": "11.5-13", "dte": {"NIFTY": "2", "SENSEX": "0"}},
    ]  # fmt: skip
    attrs = {date(2026, 11, 10): {"vix_open": 14.2, "vix_band": "13-15"}}
    rows = regime._forward_rows(entries_, attrs)
    assert rows[date(2026, 11, 10)]["vix_open"] == 14.2
    assert rows[date(2026, 11, 10)]["vix_band"] == "13-15"
    assert rows[date(2026, 11, 11)]["vix_open"] is None  # not collected yet: unknown
    assert rows[date(2026, 11, 6)]["vix_band"] == "11.5-13"
