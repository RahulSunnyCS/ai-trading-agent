"""BL-211: the day-type rules of Settings › Automation in the Python reader. The resolution cases
are the shared fixture `packages/broker-login/src/fixtures/automation-rules-cases.json`, which the
TypeScript and dashboard resolvers run too, so the three cannot drift."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.rotation import automation_settings as a
from option_backtesting.rotation import day_type

FIXTURES = Path(__file__).resolve().parents[3] / "broker-login" / "src" / "fixtures"
CASES = json.loads((FIXTURES / "automation-rules-cases.json").read_text())


def _settings(rules: list[dict]) -> dict:
    return {**json.loads(json.dumps(CASES["base"])), "rules": rules}


@pytest.mark.parametrize("case", CASES["cases"], ids=[c["name"] for c in CASES["cases"]])
def test_the_shared_resolution_cases(case):
    dt = day_type.from_json(case["dayType"])
    settings = _settings(case["rules"])
    if case.get("error"):
        with pytest.raises(a.DayTypeUnknown):
            a.resolve(settings, dt)
        return
    resolved = a.resolve(settings, dt)
    applied = resolved.get("rules_applied", {})
    for key, want in case["expect"].items():
        row = resolved["rows"][key]
        assert (row["list"], row["upload"]) == (want["list"], want["upload"]), key
        assert (applied.get(key) or {}).get("rule") == want["rule"], key


def test_no_rules_returns_the_settings_themselves():
    settings = _settings([])
    dt = day_type.from_json(CASES["cases"][0]["dayType"])
    assert a.resolve(settings, dt) is settings


def test_resolving_does_not_touch_the_settings_it_was_given():
    case = CASES["cases"][1]
    settings = _settings(case["rules"])
    a.resolve(settings, day_type.from_json(case["dayType"]))
    assert settings["rows"]["algotest.finvasia"]["list"] == "t1"
    assert "rules_applied" not in settings


def test_resolved_settings_feed_the_existing_readers_unchanged():
    case = CASES["cases"][1]  # SENSEX 0 DTE: Shoonya on AlgoTest trades Classic
    resolved = a.resolve(_settings(case["rules"]), day_type.from_json(case["dayType"]))
    assert a.upload_books(resolved, "algotest") == ["core"]
    assert a.upload_books(resolved, "quantiply") == ["core"]
    assert a.book_capital(resolved, "t1") == a.DEFAULT_CAPITAL  # nobody uploads T1 that day


def _write(tmp_path, rules):
    data = json.loads((FIXTURES / "automation-settings-v2.json").read_text())
    data["rules"] = rules
    path = tmp_path / "automation-settings.json"
    path.write_text(json.dumps(data))
    return path


def test_a_snapshot_without_rules_reads_as_none():
    data, _ = a.read(FIXTURES / "automation-settings-v1.json")
    assert data["rules"] == []


def test_a_good_rule_is_read_back(tmp_path):
    rule = {
        "row": "algotest.finvasia",
        "when": {"kind": "dte", "index": "SENSEX", "dte": "0"},
        "list": "core",
    }
    data, _ = a.read(_write(tmp_path, [rule]))
    assert data["rules"] == [rule]


@pytest.mark.parametrize(
    "rule",
    [
        {"row": "nope.finvasia", "when": {"kind": "weekday", "weekday": "Fri"}, "list": "core"},
        {"row": "algotest.finvasia", "when": {"kind": "weekday", "weekday": "Fri"}, "list": "all"},
        {"row": "algotest.finvasia", "when": {"kind": "weekday", "weekday": "Sat"}, "list": "core"},
        {
            "row": "algotest.finvasia",
            "when": {"kind": "dte", "index": "BANKNIFTY", "dte": "0"},
            "list": "core",
        },
        {
            "row": "algotest.finvasia",
            "when": {"kind": "dte", "index": "NIFTY", "dte": "8"},
            "list": "core",
        },
        {"row": "algotest.finvasia", "when": {"kind": "vix", "above": 20}, "list": "core"},
        {"row": "algotest.finvasia", "list": "core"},
    ],
)
def test_a_bad_rule_is_an_error(tmp_path, rule):
    with pytest.raises(ValueError):
        a.read(_write(tmp_path, [rule]))


def test_more_than_twenty_rules_is_an_error(tmp_path):
    rule = {
        "row": "algotest.finvasia",
        "when": {"kind": "weekday", "weekday": "Fri"},
        "list": "core",
    }
    with pytest.raises(ValueError):
        a.read(_write(tmp_path, [rule] * (a.MAX_RULES + 1)))


def test_read_for_session_is_read_when_there_are_no_rules(tmp_path, monkeypatch):
    monkeypatch.setattr(
        day_type, "ensure", lambda day, root=None: pytest.fail("no day type needed")
    )
    data, source = a.read_for_session(date(2026, 11, 5), FIXTURES / "automation-settings-v1.json")
    assert source == "settings v1"
    assert data["rules"] == []


def test_read_for_session_applies_the_rule_for_that_day(tmp_path, monkeypatch):
    rule = {
        "row": "algotest.finvasia",
        "when": {"kind": "dte", "index": "SENSEX", "dte": "0"},
        "list": "core",
    }
    path = _write(tmp_path, [rule])
    expiry = day_type.from_json(CASES["cases"][1]["dayType"])
    monkeypatch.setattr(day_type, "ensure", lambda day, root=None: expiry)
    data, source = a.read_for_session(date(2026, 11, 5), path)
    assert data["rows"]["algotest.finvasia"]["list"] == "core"
    assert "algotest.finvasia → core (rule 1)" in source
    quiet = day_type.from_json(CASES["cases"][2]["dayType"])
    monkeypatch.setattr(day_type, "ensure", lambda day, root=None: quiet)
    data, source = a.read_for_session(date(2026, 11, 6), path)
    assert data["rows"]["algotest.finvasia"]["list"] == "t1"
    assert "no rule applies" in source


def test_the_day_type_file_is_kept_and_reused_only_when_listed(tmp_path, monkeypatch):
    calls = []

    def fake(day):
        calls.append(day)
        return day_type.DayType(day, day.strftime("%a"), {"NIFTY": "2", "SENSEX": "0"}, "master")

    monkeypatch.setattr(day_type, "for_day", fake)
    day = date(2026, 11, 5)
    first = day_type.ensure(day, tmp_path)
    assert day_type.path(day, tmp_path).exists() and first.dte["SENSEX"] == "0"
    assert day_type.ensure(day, tmp_path) == first and calls == [day]  # read back, not recomputed
    day_type.write(
        day_type.DayType(day, "Thu", {"NIFTY": "2", "SENSEX": "0"}, "calendar"), tmp_path
    )
    day_type.ensure(day, tmp_path)
    assert calls == [day, day]  # a calendar fallback is read again


def test_the_daytype_command_prints_the_labels(monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting.rotation.cli import rotation_app

    dt = day_type.DayType(date(2026, 11, 5), "Thu", {"NIFTY": "2", "SENSEX": "0"}, "master")
    monkeypatch.setattr(day_type, "for_day", lambda day: dt)
    result = CliRunner().invoke(rotation_app, ["daytype", "--day", "2026-11-05", "--json"])
    assert result.exit_code == 0
    assert json.loads(result.output) == dt.as_json()
    plain = CliRunner().invoke(rotation_app, ["daytype", "--day", "2026-11-05"])
    assert "NIFTY 2 DTE · SENSEX 0 DTE" in plain.output


def test_the_route_answers_today_and_tomorrow_and_names_a_failure(monkeypatch):
    from option_backtesting.api import rotation_day_type_routes as routes

    routes._cache.clear()
    good = day_type.DayType(date(2026, 11, 5), "Thu", {"NIFTY": "2", "SENSEX": "0"}, "master")

    def fake(day, root=None):
        if day == date(2026, 11, 5):
            return good
        raise RuntimeError("master unreachable")

    monkeypatch.setattr(day_type, "ensure", fake)
    monkeypatch.setattr(
        routes, "now_ist", lambda: __import__("datetime").datetime(2026, 11, 5, 9, 0)
    )
    monkeypatch.setattr(routes, "next_session", lambda d: date(2026, 11, 6))
    body = TestClient(create_app()).get("/legwise/rotation/day-type").json()
    assert body["today"] == good.as_json()
    assert body["tomorrow"] is None
    assert body["errors"] == ["tomorrow: RuntimeError: master unreachable"]
