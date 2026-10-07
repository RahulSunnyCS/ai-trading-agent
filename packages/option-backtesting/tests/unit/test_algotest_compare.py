"""AlgoTest trade-log import and the day-by-day comparison (BL-009 Phase 1)."""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.legwise.algotest import (
    AlgoDay,
    AlgoLeg,
    algotest_reasons,
    compare,
    compare_day,
    load_algotest_csv,
    report,
)
from option_backtesting.legwise.engine import DayResult, Trade
from option_backtesting.legwise.market import minute_index
from option_backtesting.legwise.schema import load_legwise

ROOT = Path(__file__).resolve().parents[2]
EXPORT = ROOT / "tests" / "fixtures" / "algotest" / "nifty_widesl_917_otm1.csv"
STRATEGY = load_legwise(ROOT / "strategies" / "legwise" / "nifty_widesl_917_otm1.yaml")
DAY = date(2025, 1, 1)
EXP = date(2025, 1, 2)


def test_the_export_loads_every_day_and_leg():
    days = load_algotest_csv(EXPORT)
    assert len(days) == 436
    assert (days[0].day, days[-1].day) == (date(2025, 1, 1), date(2026, 10, 6))
    assert all(len(d.legs) == 2 for d in days)
    # the per-day P/L is the sum of its legs, and the total is AlgoTest's summary figure
    for d in days:
        assert d.pnl == pytest.approx(sum(leg.pnl for leg in d.legs), abs=0.01)
    assert sum(d.pnl for d in days) == pytest.approx(143_627.25, abs=0.01)
    first = days[0].legs[0]
    assert (first.option_type, first.strike, first.position, first.qty) == ("CE", 23700, "sell", 65)
    assert (first.entry_min, first.exit_min) == (minute_index("09:17"), minute_index("10:51"))
    assert (first.entry_price, first.exit_price) == (100.05, 188.20)
    assert days[0].vix == 14.50


def leg(kind, strike, entry, exit_, px_in=100.0, px_out=50.0):
    return AlgoLeg(kind, strike, "sell", 65, minute_index(entry), minute_index(exit_),
                   px_in, px_out, (px_in - px_out) * 65)  # fmt: skip


def trade(kind, strike, entry, exit_, reason, px_in=100.0, px_out=50.0):
    return Trade(kind.lower(), (EXP, strike, kind), "sell", 65, minute_index(entry), px_in,
                 minute_index(exit_), px_out, reason)  # fmt: skip


def result(*trades):
    return DayResult(DAY, list(trades), sum(t.pnl for t in trades), 0.0, 0.0, 0.0, None)


def algo(*legs):
    return AlgoDay(DAY, 14.5, sum(x.pnl for x in legs), list(legs))


def test_reasons_are_inferred_from_the_log():
    day = algo(leg("CE", 23700, "09:17", "10:51"), leg("PE", 23600, "09:17", "10:51"))
    assert algotest_reasons(day, minute_index("15:28")) == ["OVERALL_SL", "OVERALL_SL"]
    day = algo(leg("CE", 23700, "09:17", "12:26"), leg("PE", 23600, "09:17", "15:28"))
    assert algotest_reasons(day, minute_index("15:28")) == ["STOP", "EXIT_TIME"]


@pytest.mark.parametrize(
    "ours,cls",
    [
        # identical, with AlgoTest's stop stamped one minute later (end of minute)
        ((trade("CE", 23700, "09:17", "12:25", "SL"), trade("PE", 23600, "09:17", "15:28", "EXIT_TIME")), "match"),
        # a price two ticks off
        ((trade("CE", 23700, "09:17", "12:25", "SL", 100.1), trade("PE", 23600, "09:17", "15:28", "EXIT_TIME")), "price"),
        # the stop three minutes earlier
        ((trade("CE", 23700, "09:17", "12:23", "SL"), trade("PE", 23600, "09:17", "15:28", "EXIT_TIME")), "minute"),
        # the leg was not stopped by the engine
        ((trade("CE", 23700, "09:17", "15:28", "EXIT_TIME"), trade("PE", 23600, "09:17", "15:28", "EXIT_TIME")), "reason"),
        # another strike
        ((trade("CE", 23750, "09:17", "12:25", "SL"), trade("PE", 23600, "09:17", "15:28", "EXIT_TIME")), "strike"),
    ],
)  # fmt: skip
def test_each_day_gets_its_most_serious_class(ours, cls):
    theirs = algo(leg("CE", 23700, "09:17", "12:26"), leg("PE", 23600, "09:17", "15:28"))
    assert compare_day(theirs, result(*ours), STRATEGY).cls == cls


def test_a_day_the_engine_did_not_run_is_missing_with_the_reason():
    theirs = algo(leg("CE", 23700, "09:17", "15:28"), leg("PE", 23600, "09:17", "15:28"))
    [diff] = compare([theirs], [], STRATEGY, {DAY: "excluded: short_session:120"})
    assert (diff.cls, diff.note) == ("missing", "excluded: short_session:120")
    text = report([diff], STRATEGY)
    assert "| missing | 1 |" in text and "excluded: short_session:120" in text


def test_a_leg_sl_in_the_minute_of_the_combined_stop_counts_as_the_same_exit():
    """2025-02-13: the PE's own SL and the combined stop fired in the same minute. The log
    shows both legs out together (OVERALL_SL); the engine labels the PE SL. Same exit."""
    theirs = algo(leg("CE", 23150, "09:17", "09:26"), leg("PE", 23050, "09:17", "09:26"))
    ours = result(
        trade("CE", 23150, "09:17", "09:25", "OVERALL_SL"),
        trade("PE", 23050, "09:17", "09:25", "SL"),
    )
    assert compare_day(theirs, ours, STRATEGY).cls == "match"


def test_both_legs_stopped_in_the_same_minute_is_the_same_exit():
    """Both legs' own SLs in one minute: the log reads it as a combined stop."""
    theirs = algo(leg("CE", 23150, "09:17", "10:06"), leg("PE", 23050, "09:17", "10:06"))
    ours = result(
        trade("CE", 23150, "09:17", "10:05", "SL"), trade("PE", 23050, "09:17", "10:05", "SL")
    )
    assert compare_day(theirs, ours, STRATEGY).cls == "match"


def test_a_missing_leg_keeps_the_other_legs_diffs():
    theirs = algo(leg("CE", 23700, "09:17", "15:28"), leg("PE", 23600, "09:17", "15:28"))
    diff = compare_day(theirs, result(trade("CE", 23700, "09:17", "15:28", "EXIT_TIME")), STRATEGY)
    assert diff.cls == "missing"
    assert diff.note == "engine has no sell PE trade"
    assert [x.option_type for x in diff.legs] == ["CE"]
