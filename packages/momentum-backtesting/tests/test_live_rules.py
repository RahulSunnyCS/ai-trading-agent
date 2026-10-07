"""BL-025 Phase 2: the live-money rules check."""

from __future__ import annotations

import pandas as pd
import pytest
from typer.testing import CliRunner

from momentum_backtesting import cli, live_rules, notify

RULES = live_rules.load()


def _curve(values: list[float], start: str = "2026-10-09") -> pd.Series:
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
    assert "First past the line on 2026-11-06" in f.detail  # the week it first fell 30%


def test_paper_tracking_not_started_before_paper_start():
    early = _curve([1, 1.01], start="2026-09-25")  # data ends before 2026-10-09
    report = live_rules.evaluate(RULES, early, _flat(2))
    assert report.weeks == 0 and report.findings[0].level == "pending"
    assert not report.breached


def test_weeks_are_counted_from_the_paper_start():
    data = _curve([1, 1, 1, 1, 1, 1], start="2026-10-02")  # starts one week before paper_start
    report = live_rules.evaluate(RULES, data, _flat(6))
    assert report.weeks == 4  # 10-09, 10-16, 10-23, 10-30, 11-06 -> 4 weeks after the start week


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
    stale = live_rules.evaluate(RULES, _curve([1, 1.01, 1.02]), _flat(3))  # ends 2026-10-23
    monkeypatch.setattr(live_rules, "run_check", lambda **_: stale)
    monkeypatch.setattr(
        "momentum_backtesting.weekly.week_ending_on_or_before",
        lambda _day: __import__("datetime").date(2026, 10, 30),
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
