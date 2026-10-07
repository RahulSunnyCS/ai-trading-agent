"""The evening top-up (BL-034 Phase 4): after collection, `refresh_day` judges the day, builds
its derived tables and says what it found — on the frozen real NIFTY days."""

import shutil
from datetime import date
from pathlib import Path

import pytest
from trading_data import derived, quality
from trading_data.db import connect

from option_backtesting.legwise.daily import DayCheck, refresh_day, summary, telegram_summary

FIXTURE = Path(__file__).resolve().parents[1] / "golden" / "legwise_fixture"
DAY = date(2026, 9, 24)


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    root = tmp_path_factory.mktemp("lake")
    shutil.copytree(FIXTURE / "lake", root / "lake")
    with connect(root):  # a catalog, as every real root has (tdata init)
        pass
    return root


def test_refresh_day_judges_builds_and_reports(root):
    check = refresh_day(root, DAY, ["NIFTY", "SENSEX"], log=lambda _: None)
    assert check.lines[0] == "data usable: NIFTY"
    assert "SENSEX: no option data for 24 Sep" in check.lines
    assert check.problems  # SENSEX is missing
    [iv_line] = [line for line in check.lines if line.startswith("NIFTY IV 7d")]
    assert "of the last year" in iv_line and "VIX" in iv_line
    # the verdict is in the lock-free file the strategies read, and the day's tables exist
    assert quality.day_verdicts(root, DAY)["NIFTY"][0] == "usable"
    for ds in derived.DATASETS:
        assert derived.derived_path(root, ds, "NIFTY", DAY).exists()
    assert derived.iv_for_day(root, "NIFTY", DAY)["trading_day"] == DAY


def test_a_clean_day_has_no_problems(root):
    check = refresh_day(root, DAY, ["NIFTY"], log=lambda _: None)
    assert not check.problems
    assert check.lines[0] == "data usable: NIFTY"


def test_the_summaries_carry_the_data_lines():
    check = DayCheck(["data usable: NIFTY", "SENSEX: day excluded (short_session:120)"], True)
    text = summary(DAY, [], [], [], check)
    assert "Data\n  data usable: NIFTY\n  SENSEX: day excluded (short_session:120)" in text
    note = telegram_summary(DAY, [], [], [], 0, check)
    assert note.severity == "warn"
    assert "SENSEX: day excluded (short_session:120)" in note.body
    calm = telegram_summary(DAY, [], [], [], 0, DayCheck(["data usable: NIFTY"], False))
    assert calm.severity == "info"
