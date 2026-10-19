"""The ledger, the confirmation lock and the cache of rule tests (BL-120)."""

from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest

from option_backtesting.ruletest import charges, sim, store, study
from option_backtesting.ruletest.spec import from_dict
from tests.unit.test_ruletest_spec import BASE


def test_charges_match_the_bl063_model():
    c = charges.day_charges("NIFTY", "2025-03-03", 2, 120 * 75, 150 * 75)
    assert round(c.total, 4) == 50.7138  # research/bl063/charges.py's trade_charges, same trade
    assert round(c.stt, 2) == round(0.0010 * 150 * 75, 2)
    s = charges.day_charges("SENSEX", "2026-05-04", 2, 100 * 20, 200 * 20)
    assert round(s.total, 4) == 39.0481 and s.sebi_ipft == pytest.approx(0.000001 * 6000)
    assert charges.stt_rate("2026-03-31") == 0.0010 and charges.stt_rate("2026-04-01") == 0.0015


def test_net_subtracts_charges_from_gross():
    row = {
        "day": "2025-03-03",
        "gross": "1000",
        "orders": "2",
        "buy_value": "9000",
        "sell_value": "11250",
    }
    assert sim.net("NIFTY", row) == pytest.approx(1000 - 50.7138, abs=1e-3)


def test_counts_weight_a_sweep_by_its_variants():
    rows = [
        {"at": "2026-10-05T10:00:00+05:30", "tries": 1},  # Monday of the week below
        {"at": "2026-10-07T10:00:00+05:30", "tries": 8},
        {"at": "2026-09-20T10:00:00+05:30", "tries": 1},
    ]
    now = datetime.fromisoformat("2026-10-08T12:00:00+05:30")
    assert store.counts(rows, now) == {"week": 9, "month": 9, "total": 10}
    assert "about 0.5 would look good" in store.lucky_sentence(10)
    assert "only test so far" in store.lucky_sentence(1)


def test_reveal_is_logged_once_and_per_spec(tmp_path):
    assert not store.is_revealed(tmp_path, "abc")
    first = store.reveal(tmp_path, "abc", "first look")
    again = store.reveal(tmp_path, "abc", "again")
    assert store.is_revealed(tmp_path, "abc") and not store.is_revealed(tmp_path, "abd")
    assert len(store.reveals(tmp_path)) == 1 and again["at"] >= first["at"]


def test_confirmation_is_locked_until_revealed(tmp_path):
    rule = from_dict(BASE)
    study.check_allowed(tmp_path, rule, "learning", "locked")  # the learning period is always open
    with pytest.raises(store.LockedError, match="locked for this strategy"):
        study.check_allowed(tmp_path, rule, "confirmation", "locked")
    study.check_allowed(tmp_path, rule, "confirmation", "exploratory")
    store.reveal(tmp_path, rule.spec_hash)
    study.check_allowed(tmp_path, rule, "confirmation", "locked")
    changed = from_dict({**BASE, "when": {"gt": ["close", {"add": ["pivot", 99]}]}})
    with pytest.raises(store.LockedError):  # a changed rule is a new hash and locked again
        study.check_allowed(tmp_path, changed, "confirmation", "locked")


def test_an_exploratory_look_at_the_confirmation_period_is_recorded(tmp_path, monkeypatch):
    """`--open-all` over the confirmation period, then a locked test: the exploratory run is
    logged as the spec's reveal, and the locked result says the period was already seen."""
    monkeypatch.setattr(study.F, "load_frame", lambda *a, **k: None)
    monkeypatch.setattr(
        study, "analyse_period", lambda root, rule, frame, period, options: {"period": period}
    )
    rule = from_dict(BASE)
    both = ("learning", "confirmation")
    first = study.run_test(tmp_path, rule, "text", study.Options(periods=both, mode="exploratory"))
    assert first["confirmation_seen_before"] == []
    assert store.is_revealed(tmp_path, rule.spec_hash)
    assert store.reveals(tmp_path)[0]["note"] == f"exploratory test {first['id']}"

    learning = study.run_test(tmp_path, rule, "text", study.Options(periods=("learning",)))
    assert learning["confirmation_seen_before"] == []  # it did not look at the period

    locked = study.run_test(tmp_path, rule, "text", study.Options(periods=both, mode="locked"))
    assert locked["mode"] == "locked"
    assert locked["confirmation_seen_before"] == [first["id"]]
    assert store.ledger(tmp_path)[-1]["confirmation_seen_before"] == [first["id"]]
    assert len(store.ledger(tmp_path)) == 3  # every test still counted
    assert len(store.reveals(tmp_path)) == 1


def test_sensex_has_no_confirmation_period(tmp_path):
    rule = from_dict({**BASE, "underlying": "SENSEX"})
    with pytest.raises(store.RuleTestError, match="NIFTY data only"):
        study.check_allowed(tmp_path, rule, "confirmation", "exploratory")
    with pytest.raises(store.RuleTestError, match="unknown period"):
        study.check_allowed(tmp_path, rule, "forward", "exploratory")


def test_result_file_is_written_with_its_ledger_line(tmp_path):
    row = {"id": "20261008-120000-abcd", "at": "2026-10-08T12:00:00+05:30", "tries": 1}
    store.record_test(tmp_path, row, {"id": row["id"], "ok": True})
    assert store.ledger(tmp_path) == [row]
    assert store.read_result(tmp_path, row["id"]) == {"id": row["id"], "ok": True}
    assert store.read_result(tmp_path, "../../etc/passwd") is None
    assert store.read_result(tmp_path, "nope") is None


def test_unreadable_ledger_lines_are_skipped(tmp_path):
    (tmp_path / "ruletest").mkdir()
    (tmp_path / "ruletest" / "tests.jsonl").write_text('{"id": "a"}\nnot json\n{"id": "b"}\n')
    assert [r["id"] for r in store.ledger(tmp_path)] == ["a", "b"]


def test_cache_skips_error_rows_so_they_are_retried(tmp_path):
    path = sim.cache_path(tmp_path, "tpl")
    path.parent.mkdir(parents=True)
    header = ",".join(sim.COLUMNS)
    good = "2026-01-05,11:01,both,0.0,100,-5,120,,2,9000,11000,2,2026-01-08,23000,23010,"
    bad = "2026-01-06,11:01,both,0.0,,,,,,,,,,,,ERR MissingReferenceData: x"
    path.write_text("\n".join([header, good, bad]) + "\n")
    got = sim.read_cache(tmp_path, "tpl")
    assert list(got) == [("2026-01-05", "11:01", "both", 0.0)]


GOOD_ROW = "2026-01-05,11:01,both,0.0,100,-5,120,,2,9000,11000,2,2026-01-08,23000,23010,"


def test_cache_skips_and_counts_torn_lines(tmp_path):
    path = sim.cache_path(tmp_path, "tpl")
    path.parent.mkdir(parents=True)
    header = ",".join(sim.COLUMNS)
    # a row cut short at a digit boundary (sell_value "11" of "11000", the rest missing), and a
    # full row glued onto a cut one (too many fields, a merged number)
    cut = "2026-01-06,11:01,both,0.0,100,-5,120,,2,9000,11"
    glued = "2026-01-07,11:01,both,0.0,1" + GOOD_ROW.replace("2026-01-05", "2026-01-09")
    path.write_text("\n".join([header, GOOD_ROW, cut, glued]) + "\n")
    got, skipped = sim.read_cache_counted(tmp_path, "tpl")
    assert list(got) == [("2026-01-05", "11:01", "both", 0.0)]
    assert skipped == 2


def test_an_append_after_a_torn_line_starts_a_line_of_its_own(tmp_path, monkeypatch):
    """A killed run leaves the file ending part-way through a row: the next run simulates that
    key again and its rows land on their own lines, not glued onto the cut one."""
    path = sim.cache_path(tmp_path, "tpl")
    path.parent.mkdir(parents=True)
    header = ",".join(sim.COLUMNS)
    path.write_text("\r\n".join([header, GOOD_ROW]) + "\r\n" + "2026-01-06,11:01,both,0.0,12")

    def fake_work(task):
        _root, _spec, day, items = task
        return [
            {"day": day, "entry": e, "side": s, "slip": p, "gross": 250.5, "worst_mtm": -1,
             "best_mtm": 300, "stopped_by": "", "orders": 2, "buy_value": 900.0,
             "sell_value": 1234.5, "n_trades": 2, "weekly_expiry": "2026-01-08",
             "spot_entry": 23000, "spot_exit": 23005, "error": ""}
            for e, s, p in items
        ]  # fmt: skip

    class InlinePool:
        def __init__(self, _workers):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def map(self, fn, tasks, chunksize=1):
            return map(fn, tasks)

    monkeypatch.setattr(sim, "_work", fake_work)
    monkeypatch.setattr(sim, "ProcessPoolExecutor", InlinePool)
    rule = SimpleNamespace(template_hash="tpl", spec=SimpleNamespace(model_dump=lambda **_: {}))
    wanted = {("2026-01-05", "11:01", "both", 0.0), ("2026-01-06", "11:01", "both", 0.0)}
    got = sim.ensure(tmp_path, rule, wanted, workers=1)
    assert float(got[("2026-01-06", "11:01", "both", 0.0)]["sell_value"]) == 1234.5
    again, skipped = sim.read_cache_counted(tmp_path, "tpl")
    assert set(again) == wanted
    assert float(again[("2026-01-06", "11:01", "both", 0.0)]["sell_value"]) == 1234.5
    assert float(again[("2026-01-05", "11:01", "both", 0.0)]["gross"]) == 100.0
    assert skipped == 1  # the cut line stays in the file, never trusted
