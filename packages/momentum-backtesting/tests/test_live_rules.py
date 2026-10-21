"""BL-025 Phase 2: the live-money rules check."""

from __future__ import annotations

import json

import pandas as pd
import pytest
from typer.testing import CliRunner

from momentum_backtesting import cli, live_rules, notify

RULES = live_rules.load()


def _curve(values: list[float], start: str = "2026-10-16") -> pd.Series:
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="W-FRI"))


def _flat(n: int, level: float = 1.0) -> pd.Series:
    return _curve([level] * n)


def _find(report, rule):
    return next(f for f in report.findings if f.rule == rule)


# --- the file is the owner's ---------------------------------------------------------------------


def test_rules_file_holds_the_owners_numbers():
    # Pinned on purpose: changing a number means changing this test in the same commit, with the
    # reason in the BL-025 Log (the file's header says the same).
    assert RULES["stage"]["current"] == "paper"
    assert RULES["drawdown"]["cut_half_at"] == 0.20
    assert RULES["drawdown"]["exit_at"] == 0.30
    assert RULES["trailing"]["window_weeks"] == 13
    assert RULES["trailing"]["review_when_behind_pts"] == 5.0
    assert RULES["money_gate"]["min_paper_weeks"] == 13
    assert RULES["money_gate"]["must_beat"] == "Nifty200 Momentum 30 TRI"
    for key in ("cut_half_action", "exit_action"):
        assert RULES["drawdown"][key]
    assert RULES["trailing"]["review_action"] and RULES["money_gate"]["confirm_action"]


def test_the_followed_money_is_four_sectors_on_the_four_kite_lots():
    # BL-142: the owner follows Four Sectors Monthly, No Tilt, all Fridays; the check measures
    # that, one config per sleeve, not the BL-010 Phase 6 ensemble it tracked before.
    assert RULES["stage"]["paper_start"] == "2026-10-16"
    configs = live_rules.followed_configs(RULES)
    assert [c["rebalance_offset"] for c in configs] == [0, 1, 2, 3]
    assert {c["run_id"] for c in configs} == {"fbb7ab054238"}
    assert {c["rebalance_every"] for c in configs} == {4}
    assert len({json.dumps(c["heavy"], sort_keys=True) for c in configs}) == 1
    assert [c["light"]["rebalance_offset"] for c in configs] == [0, 1, 2, 3]
    assert len({c["id"] for c in configs}) == 4


def test_without_a_config_file_the_frozen_ensemble_is_followed():
    rules = {"strategy": {}}
    ids = [c["id"] for c in live_rules.followed_configs(rules)]
    assert ids == ["1281e8ed6824", "08c4307d7aa9", "535b17b44ba5", "bad83df3821a"]


def test_lots_are_put_in_one_friday_after_another_on_their_own_sleeves():
    starts = live_rules.lot_starts("2026-10-16", 4)
    assert [d.date().isoformat() for d in starts] == [
        "2026-10-16",
        "2026-10-23",
        "2026-10-30",
        "2026-11-06",
    ]
    # the sleeve that trades on each lot's first Friday (calendar-anchored offsets)
    assert [live_rules.lot_offset(d, 4) for d in starts] == [3, 0, 1, 2]


def test_a_new_lot_adds_money_not_return():
    weeks = pd.date_range("2026-10-16", periods=4, freq="W-FRI")
    first = pd.Series([1.0, 1.1, 1.1, 1.21], index=weeks)
    second = pd.Series([1.0, 0.9, 0.99], index=weeks[1:])  # put in a week later, then falls
    index = live_rules.twr_index([first, second])
    assert list(index.round(6)) == [1.0, 1.1, round(1.1 * 2.0 / 2.1, 6), round(1.1 * 2.2 / 2.1, 6)]
    # the second lot's deposit did not lift the peak: the drawdown is only the real fall
    assert index.iloc[2] / index.iloc[1] - 1 == pytest.approx(2.0 / 2.1 - 1)


def test_paper_curves_runs_each_lot_from_cash_on_its_own_friday(monkeypatch):
    from momentum_backtesting import bias, reference_benchmarks, search, tracker

    built, ran = [], []
    weeks = pd.date_range("2026-03-27", "2026-11-13", freq="W-FRI")

    class FakeRunner:
        common = {"outer_prices": pd.DataFrame(index=weeks)}

        def __init__(self, *_a, **_k):
            pass

        def base(self, heavy):
            built.append(heavy)
            return "base"

    def fake_run_config(_runner, cfg, base=None, **window):
        ran.append((cfg["id"], cfg["rebalance_offset"], base, window["start"]))
        index = weeks[weeks >= pd.Timestamp(window["start"])]
        return pd.Series([1.0 + 0.01 * i for i in range(len(index))], index=index)

    monkeypatch.setattr(bias, "Runner", FakeRunner)
    monkeypatch.setattr(search, "load_space", lambda _p: None)
    monkeypatch.setattr(tracker, "run_config", fake_run_config)
    monkeypatch.setattr(
        reference_benchmarks, "load_references", lambda: {"Nifty200 Momentum 30 TRI": _flat(30)}
    )
    followed, _bench = live_rules.paper_curves(echo=lambda _m: None, rules=RULES)
    assert [(i, o, s) for i, o, _b, s in ran] == [
        ("fbb7ab054238#3", 3, "2026-10-16"),
        ("fbb7ab054238#0", 0, "2026-10-23"),
        ("fbb7ab054238#1", 1, "2026-10-30"),
        ("fbb7ab054238#2", 2, "2026-11-06"),
    ]
    assert len(built) == 1 and {b for _, _, b, _ in ran} == {"base"}
    assert followed.index[0] == pd.Timestamp("2026-10-16") and followed.iloc[0] == 1.0


def test_a_lot_put_in_this_week_is_cash_not_a_crash(monkeypatch):
    from momentum_backtesting import bias, reference_benchmarks, search, tracker

    weeks = pd.date_range("2026-03-27", "2026-10-16", freq="W-FRI")

    class FakeRunner:
        common = {"outer_prices": pd.DataFrame(index=weeks)}

        def __init__(self, *_a, **_k):
            pass

        def base(self, _heavy):
            return "base"

    def too_short(_runner, _cfg, base=None, **_window):
        raise ValueError("not enough history to run from the chosen start date")

    monkeypatch.setattr(bias, "Runner", FakeRunner)
    monkeypatch.setattr(search, "load_space", lambda _p: None)
    monkeypatch.setattr(tracker, "run_config", too_short)
    monkeypatch.setattr(
        reference_benchmarks, "load_references", lambda: {"Nifty200 Momentum 30 TRI": _flat(30)}
    )
    followed, bench = live_rules.paper_curves(echo=lambda _m: None, rules=RULES)
    assert list(followed.index) == [pd.Timestamp("2026-10-16")] and followed.iloc[0] == 1.0
    report = live_rules.evaluate(RULES, followed, bench)
    assert not report.breached


def test_a_lot_not_yet_due_is_left_out(monkeypatch):
    from momentum_backtesting import bias, reference_benchmarks, search, tracker

    weeks = pd.date_range("2026-03-27", "2026-10-23", freq="W-FRI")

    class FakeRunner:
        common = {"outer_prices": pd.DataFrame(index=weeks)}

        def __init__(self, *_a, **_k):
            pass

        def base(self, _heavy):
            return "base"

    ran = []

    def fake_run_config(_runner, cfg, base=None, **window):
        ran.append(window["start"])
        index = weeks[weeks >= pd.Timestamp(window["start"])]
        return pd.Series(1.0, index=index)

    monkeypatch.setattr(bias, "Runner", FakeRunner)
    monkeypatch.setattr(search, "load_space", lambda _p: None)
    monkeypatch.setattr(tracker, "run_config", fake_run_config)
    monkeypatch.setattr(
        reference_benchmarks, "load_references", lambda: {"Nifty200 Momentum 30 TRI": _flat(30)}
    )
    live_rules.paper_curves(echo=lambda _m: None, rules=RULES)
    assert ran == ["2026-10-16", "2026-10-23"]  # lots 3 and 4 are not in yet


# --- drawdown -----------------------------------------------------------------------------------


def test_drawdown_levels_and_the_peak_moves_up():
    bench = _flat(6)
    ok = live_rules.evaluate(RULES, _curve([1, 1.1, 1.2, 1.1, 1.0, 1.0]), bench)
    f = _find(ok, "drawdown")
    assert f.level == "ok" and "-16.7%" in f.detail  # from the 1.2 peak, not from the start

    cut = live_rules.evaluate(RULES, _curve([1, 1.2, 1.0, 0.94, 0.93, 0.95]), bench)
    f = _find(cut, "drawdown")
    assert f.level == "breach" and "cut half at 20%" in f.title
    assert f.action == RULES["drawdown"]["cut_half_action"]

    out = live_rules.evaluate(RULES, _curve([1, 1.2, 1.0, 0.9, 0.8, 0.82]), bench)
    f = _find(out, "drawdown")
    assert f.level == "breach" and "exit at 30%" in f.title  # exit outranks cut
    assert f.action == RULES["drawdown"]["exit_action"]
    assert "First past the line on 2026-11-13" in f.detail  # the week it first fell 30%


def test_paper_tracking_not_started_before_paper_start():
    early = _curve([1, 1.01], start="2026-10-02")  # data ends 2026-10-09, before 2026-10-16
    report = live_rules.evaluate(RULES, early, _flat(2))
    assert report.weeks == 0 and report.findings[0].level == "pending"
    assert not report.breached
    _, title, _ = live_rules.summary(report)
    assert "not started" in title and "no rule breached" not in title  # nothing was measured


def test_weeks_are_counted_from_the_paper_start():
    data = _curve([1, 1, 1, 1, 1, 1], start="2026-10-09")  # starts one week before paper_start
    report = live_rules.evaluate(RULES, data, _flat(6))
    assert report.weeks == 4  # 10-16, 10-23, 10-30, 11-06, 11-13 -> 4 weeks after the start week


# --- trailing -----------------------------------------------------------------------------------


def test_trailing_is_not_measurable_without_a_journal_scored_series():
    report = live_rules.evaluate(RULES, _flat(20), _flat(20))
    f = _find(report, "trailing")
    assert f.level == "unmeasurable" and "BL-024 Phase 2" in f.detail
    assert not f.needs_you  # said in every message, never an alert of its own


def test_trailing_pending_ok_and_breach():
    backtest = _curve([1 + 0.01 * i for i in range(20)])
    few = live_rules.evaluate(
        RULES, backtest, _flat(20), live=backtest.iloc[:10], backtest=backtest.iloc[:10]
    )
    assert _find(few, "trailing").level == "pending"

    live_ok = backtest.copy()
    live_ok.iloc[-13:] = live_ok.iloc[-14] * (backtest.iloc[-13:] / backtest.iloc[-14] - 0.03)
    ok = live_rules.evaluate(RULES, backtest, _flat(20), live=live_ok, backtest=backtest)
    assert _find(ok, "trailing").level == "ok"  # 3 points behind: inside the 5-point line

    live_bad = backtest.copy()
    live_bad.iloc[-13:] = live_bad.iloc[-14]  # flat while the backtest rises ~12%
    bad = live_rules.evaluate(RULES, backtest, _flat(20), live=live_bad, backtest=backtest)
    f = _find(bad, "trailing")
    assert f.level == "breach" and f.action == RULES["trailing"]["review_action"]
    assert "-12.3 points" in f.detail  # 1.19 / 1.06 - 1 for the backtest, 0 for live


# --- the money gate -----------------------------------------------------------------------------


def test_money_gate_needs_weeks_beating_the_benchmark_and_no_drawdown_hit():
    up = _curve([1 + 0.01 * i for i in range(15)])
    bench = _curve([1 + 0.004 * i for i in range(15)])
    ready = _find(live_rules.evaluate(RULES, up, bench), "money_gate")
    assert ready.level == "ready" and ready.action == RULES["money_gate"]["confirm_action"]

    young = _find(live_rules.evaluate(RULES, up.iloc[:8], bench.iloc[:8]), "money_gate")
    assert young.level == "pending" and "not yet: weeks tracked: 7 of 13" in young.detail

    behind = _find(live_rules.evaluate(RULES, bench, up), "money_gate")
    assert behind.level == "pending" and "not yet: return" in behind.detail

    dipped = up.copy()
    dipped.iloc[5] = dipped.iloc[4] * 0.75  # a -25% week that later recovers
    hit = _find(live_rules.evaluate(RULES, dipped, bench), "money_gate")
    assert hit.level == "pending" and "not yet: no drawdown rule hit" in hit.detail


# --- stage live ---------------------------------------------------------------------------------


def test_stage_live_is_blocked_not_checked_on_paper_numbers():
    live_rules_cfg = {**RULES, "stage": {**RULES["stage"], "current": "live"}}
    report = live_rules.evaluate(live_rules_cfg, None, None)
    assert report.findings[0].level == "blocked" and report.breached
    severity, title, body = live_rules.summary(report)
    assert severity == "error" and "cannot protect your money" in title
    assert "BL-024 Phase 3" in body


# --- the message --------------------------------------------------------------------------------


def test_summary_severity_and_it_quotes_the_owners_action():
    quiet = live_rules.evaluate(RULES, _curve([1, 1.01, 1.02]), _flat(3))
    severity, title, _ = live_rules.summary(quiet)
    assert severity == "info" and "no rule breached" in title

    cut = live_rules.evaluate(RULES, _curve([1, 1.2, 0.9]), _flat(3))
    severity, title, body = live_rules.summary(cut)
    assert severity == "action_required" and "cut half" in title
    assert f"Your action: {RULES['drawdown']['cut_half_action']}" in body


@pytest.mark.parametrize("kind", live_rules.SIMULATIONS)
def test_every_simulation_trips_its_rule(kind):
    report = live_rules.run_check(simulate=kind)
    assert report.simulated == kind and report.breached
    _, title, body = live_rules.summary(report)
    assert title.startswith(f"SIMULATED ({kind})") and "simulation" in body
    expected = {
        "drawdown-cut": ("drawdown", "breach"),
        "drawdown-exit": ("drawdown", "breach"),
        "trailing": ("trailing", "breach"),
        "gate-ready": ("money_gate", "ready"),
    }[kind]
    assert (_find(report, expected[0]).rule, _find(report, expected[0]).level) == expected


# --- the command --------------------------------------------------------------------------------


@pytest.fixture
def sent(monkeypatch):
    messages: list[notify.Notification] = []
    monkeypatch.setattr(notify, "send", lambda n: messages.append(n) or "")
    return messages


def _invoke(*args):
    return CliRunner().invoke(cli.app, ["live-rules", "check", *args])


def test_breach_is_sent_untagged_so_it_cannot_be_switched_off(sent):
    result = _invoke("--simulate", "drawdown-cut", "--send")
    assert result.exit_code == 0
    assert len(sent) == 1 and sent[0].type is None and sent[0].severity == "action_required"


def test_routine_status_is_the_optional_type(sent, monkeypatch):
    quiet = live_rules.evaluate(RULES, _curve([1, 1.01, 1.02]), _flat(3))
    monkeypatch.setattr(live_rules, "run_check", lambda **_: quiet)
    monkeypatch.setattr(
        "momentum_backtesting.weekly.week_ending_on_or_before",
        lambda _day: __import__("datetime").date(2026, 10, 23),
    )
    result = _invoke("--send")
    assert result.exit_code == 0
    assert sent[0].type == live_rules.NOTIFY_TYPE and sent[0].severity == "info"


def test_stale_data_fails_loudly(sent, monkeypatch):
    stale = live_rules.evaluate(RULES, _curve([1, 1.01, 1.02]), _flat(3))  # ends 2026-10-30
    monkeypatch.setattr(live_rules, "run_check", lambda **_: stale)
    monkeypatch.setattr(
        "momentum_backtesting.weekly.week_ending_on_or_before",
        lambda _day: __import__("datetime").date(2026, 11, 6),
    )
    result = _invoke("--send")
    assert result.exit_code == 1 and "stale data" in sent[0].title
    assert sent[0].severity == "error" and sent[0].type == "momentum.problem"


def test_a_crash_is_reported_not_swallowed(sent, monkeypatch):
    def boom(**_):
        raise RuntimeError("catalog locked")

    monkeypatch.setattr(live_rules, "run_check", boom)
    result = _invoke("--send")
    assert result.exit_code == 1 and "could not run" in sent[0].title
    assert "catalog locked" in sent[0].body


def test_unknown_simulation_is_rejected():
    assert _invoke("--simulate", "nope").exit_code != 0
