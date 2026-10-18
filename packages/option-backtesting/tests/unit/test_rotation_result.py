"""The evening message reports complete net paper results for the three public strategies."""

from datetime import date

import pytest

from option_backtesting.rotation import journal, result, store

DAY = date(2026, 10, 13)


def _entry(root):
    return journal.append(
        store.journal_path(root),
        {
            "day": DAY.isoformat(),
            "weekday": "Tue",
            "lists": {
                "A": {"core": ["a", "b", "c"], "buy": []},
                "B": {"core": ["a", "d", "e"], "buy": ["buy"]},
                "C": {"core": ["b", "d", "e"], "buy": []},
                "REF": {"core": ["ref1", "ref2", "ref3"], "buy": []},
            },
        },
    )


def _write(root, values):
    for name, net in values.items():
        store.append_result(
            name,
            {
                "day": DAY.isoformat(),
                "net": net,
                "gross": net + 1,
                "costs": 1,
                "worst_mtm": min(net, 0),
                "stopped_by": "",
                "n_trades": 2,
            },
            root,
        )


def test_calculates_net_two_lot_gain_and_omits_baseline(tmp_path):
    entry = _entry(tmp_path)
    _write(tmp_path, {"a": 100, "b": -20, "c": 30, "d": 50, "e": -10, "buy": 25})

    got = result.calculate(DAY, tmp_path)

    assert got.gains == {"C": 20}  # Adaptive only
    assert got.strategies["C"]
    assert got.entry_hash == entry["hash"]
    text = result.render(got)
    assert text.startswith("📊 Tue 13 Oct · result\n1 lot per strategy, after costs")
    assert "🎯 Adaptive   +₹20" in text
    assert "Steady" not in text and "Calendar" not in text
    assert "Baseline" not in text and "REF" not in text


def test_waits_until_every_picked_strategy_is_scored(tmp_path):
    _entry(tmp_path)
    _write(tmp_path, {"a": 100, "b": -20, "c": 30, "d": 50})

    with pytest.raises(result.NotScored, match="1 picked strategies missing"):
        result.calculate(DAY, tmp_path)


def test_requires_a_morning_entry(tmp_path):
    with pytest.raises(result.NoEntry, match="no rotation picks"):
        result.calculate(DAY, tmp_path)


def test_sent_marker_is_specific_to_the_day_and_entry(tmp_path):
    completed = result.DailyResult(DAY, "Tue", {"A": 1, "B": 2, "C": 3}, "abc123")
    assert not result.was_sent(completed, tmp_path)
    result.mark_sent(completed, tmp_path)
    assert result.was_sent(completed, tmp_path)
    changed = result.DailyResult(DAY, "Tue", completed.gains, "different")
    assert not result.was_sent(changed, tmp_path)
