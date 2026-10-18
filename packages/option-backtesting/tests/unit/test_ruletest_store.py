"""The ledger, the confirmation lock and the cache of rule tests (BL-120)."""

from __future__ import annotations

from datetime import datetime

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
