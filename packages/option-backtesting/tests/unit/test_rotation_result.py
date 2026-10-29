"""The evening message reports complete net paper results for the three public strategies."""

import json
from datetime import date

import pytest

from option_backtesting.rotation import journal, messages, result, store

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


# -- capital and month to date (owner, 2026-10-29) ------------------------------------------------


def _month_day(root, day, core, values):
    journal.append(
        store.journal_path(root),
        {"day": day.isoformat(), "weekday": "", "lists": {"C": {"core": core, "buy": []}}},
    )
    for name, net in values.items():
        store.append_result(name, {"day": day.isoformat(), "net": net, "gross": net}, root)


def _manifest(root, platform, day, book, lots):
    folder = store.rotation_dir(root) / platform / day.isoformat() / book
    folder.mkdir(parents=True)
    strategies = [{"variant": v, "lots": n} for v, n in lots.items()]
    (folder / "manifest.json").write_text(json.dumps({"strategies": strategies}))


def test_month_to_date_adds_the_months_days_at_the_lots_traded(tmp_path):
    _month_day(tmp_path, date(2026, 9, 30), ["a"], {"a": 9999})  # last month: left out
    _month_day(tmp_path, date(2026, 10, 1), ["a", "dir"], {"a": 100, "dir": 400})
    _month_day(tmp_path, date(2026, 10, 2), ["a", "b"], {"a": 50})  # b never scored
    _month_day(tmp_path, date(2026, 10, 5), ["a", "b"], {"a": -30, "b": 10})
    _manifest(tmp_path, "quantiply", date(2026, 10, 1), "core", {"a": 1, "dir": 2})

    today = result.calculate(date(2026, 10, 5), tmp_path)
    month = result.month_to_date(today, tmp_path)

    # 1 Oct at Dir ×2 (100 + 2 × 400) + 5 Oct at 1 lot (−20); 2 Oct incomplete, not zero
    assert (month.total, month.unscored, month.capital) == (880, 1, 850_000)
    lines = messages.month_lines(month)
    assert lines == ["   Capital ₹8.5 L", "   October +₹880 (+0.1%) · 1 day not scored"]


def test_a_month_that_cannot_be_read_leaves_only_its_lines_out(tmp_path, monkeypatch):
    _month_day(tmp_path, date(2026, 10, 5), ["a"], {"a": -8500})
    today = result.calculate(date(2026, 10, 5), tmp_path)

    def boom(*a, **k):
        raise OSError("disk gone")

    months = result.months_to_date(today, "not ready", tmp_path)
    assert months["t1"] is None
    assert messages.month_lines(months["adaptive"])[1] == "   October −₹8,500 (−1.0%)"
    monkeypatch.setattr(result, "month_to_date", boom)
    assert result.months_to_date(today, None, tmp_path) == {"adaptive": None, "t1": None}
    text = result.render(today, months=result.months_to_date(today, None, tmp_path))
    assert "Capital" not in text and "🎯 Adaptive" in text


def test_the_real_month_lines():
    real = result.RealMonth(
        date(2026, 10, 28),
        25000.40,
        1_700_000,
        {"Angel One": -5000.25, "Shoonya": 30000.65},
        date(2026, 10, 28),
        1,
        700.30,
        100.10,
    )
    assert messages.real_lines(real) == [
        "💼 Total capital ₹17 L",
        "   Real, October +₹25,000 (+1.5%) after charges & algo fees",
        "   Angel One −₹5,000 · Shoonya +₹30,001",
        "   Interest −₹700 · other debits −₹100 (est.)",
        "   After debits +₹24,200 (+1.4%)",
        "   contract notes to Wed 28 Oct · 1 day not in yet",
    ]
    no_debits = result.RealMonth(date(2026, 10, 28), 1000.0, 1_700_000, {}, date(2026, 10, 28))
    assert not any("debits" in line for line in messages.real_lines(no_debits))
    empty = result.RealMonth(date(2026, 11, 2), 0.0, 1_700_000, {}, None)
    assert messages.real_lines(empty) == [
        "💼 Total capital ₹17 L",
        "   Real, November: no contract notes yet",
    ]


def test_capital_comes_from_the_accounts_that_upload_each_list():
    from option_backtesting.rotation import automation_settings as auto

    settings = json.loads(json.dumps(auto.DEFAULT))
    for row in settings["rows"].values():
        row.update(list="none", upload=False)
    settings["rows"]["quantiply.angelone"].update(list="core", upload=True)
    settings["rows"]["quantiply.finvasia"].update(list="t1", upload=True)
    settings["rows"]["algotest.finvasia"].update(list="t1", upload=True)  # same money, once
    assert auto.capital(settings) == {"finvasia": 850_000, "angelone": 850_000}  # none saved yet
    settings["capital"] = {"finvasia": 900_000, "angelone": "lots"}  # a bad figure: the default
    assert auto.capital(settings) == {"finvasia": 900_000, "angelone": 850_000}
    assert auto.book_capital(settings, "t1") == 900_000
    assert auto.book_capital(settings, "core") == 850_000
    settings["rows"]["quantiply.angelone"]["upload"] = False  # nobody uploads Core: the default
    assert auto.book_capital(settings, "core") == 850_000
    settings["rows"]["algotest.angelone"].update(list="t1", upload=True)
    assert auto.book_capital(settings, "t1") == 1_750_000
