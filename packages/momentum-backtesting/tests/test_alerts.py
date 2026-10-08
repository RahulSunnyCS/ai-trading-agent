"""BL-051 Phase 5: the alerts behind the dashboard's pop-up and bell (`alerts.py`,
`GET /api/alerts`). Each kind is tested as a pure function, then end to end against the isolated
TRADING_DATA_ROOT: an alert opens when its check fails, keeps its id across polls, and is
resolved when the check clears."""

from __future__ import annotations

from datetime import datetime, time, timedelta

import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import alerts, api, forward_journal, live_rules, saved_identity, this_week
from momentum_backtesting.notify import IST
from momentum_backtesting.stocks.ui_data import NIFTY200_MOMENTUM30_TRI
from momentum_backtesting.weekly import week_ending_on_or_before

FRIDAY = "2026-10-09"


def at(day: str, hour: int, minute: int = 0) -> datetime:
    return datetime.fromisoformat(f"{day}T{hour:02d}:{minute:02d}:00").replace(tzinfo=IST)


# --- the pure functions --------------------------------------------------------------------------


def test_an_unclassified_split_links_to_its_drawer_on_this_week():
    snapshot = {
        "items": [
            {"symbol": "ABC", "ex_date": "2026-10-07", "previous_close": 200.0, "close": 100.0}
        ]
    }
    (alert,) = alerts.split_alerts(snapshot)
    assert alert["id"] == "split:ABC:2026-10-07"
    assert (alert["kind"], alert["severity"]) == ("split", "warning")
    assert alert["link"] == "/momentum/week?review=ABC"
    assert "50.0%" in alert["title"]
    assert alert["resolved_at"] is None
    assert alerts.split_alerts({"items": []}) == []


def _status(*, etf_ready=True, stock_ready=True, through="2026-10-02"):
    def dataset(key, label, ready):
        return {
            "key": key,
            "label": label,
            "ready": ready,
            "through": None if ready else through,
            "note": "",
            "error": None,
        }

    return {
        "target_week": FRIDAY,
        "datasets": [
            dataset("etf", "Index & ETF prices", etf_ready),
            dataset("stock", "NSE bhavcopy stock data", stock_ready),
        ],
    }


def test_data_not_ready_alerts_only_for_the_headlines_data_and_only_once_its_run_is_past():
    status = _status(etf_ready=False, stock_ready=False)
    # The Friday 16:45 ETF run plus the 15 minute window: not yet at 16:50, yes at 17:05.
    assert alerts.data_alerts(status, "etf", at(FRIDAY, 16, 50)) == []
    (etf,) = alerts.data_alerts(status, "etf", at(FRIDAY, 17, 5))
    assert etf["id"] == f"data:etf:{FRIDAY}" and etf["severity"] == "error"
    assert "through 2026-10-02" in etf["detail"]
    assert etf["link"] == "/momentum/week?panel=run"
    # A stock-based headline cares about the bhavcopy data (19:30), not the ETF prices.
    assert alerts.data_alerts(status, "broad", at(FRIDAY, 18)) == []
    (stock,) = alerts.data_alerts(status, "broad", at(FRIDAY, 20))
    assert stock["id"] == f"data:stock:{FRIDAY}"
    # Any later day the Friday is past; ready data and no headline raise nothing.
    assert len(alerts.data_alerts(status, "etf", at("2026-10-12", 9))) == 1
    assert alerts.data_alerts(_status(), "etf", at("2026-10-12", 9)) == []
    assert alerts.data_alerts(status, None, at("2026-10-12", 9)) == []


def _check(*, missing=0, problems=(), entries=5):
    items = [
        {
            "name": f"Fav {i}",
            "run_kind": "final",
            "status": "missing" if i < missing else "recorded",
        }
        for i in range(3)
    ]
    return {
        "week": FRIDAY,
        "expected": 3,
        "items": items,
        "chain": {"entries": entries, "problems": list(problems)},
    }


def test_a_missing_journal_entry_alerts_only_after_the_21_00_check_has_run():
    assert alerts.journal_alerts(_check(missing=2), at(FRIDAY, 20, 59)) == []
    (alert,) = alerts.journal_alerts(_check(missing=2), at(FRIDAY, 21, 20))
    assert alert["id"] == f"journal:missing:{FRIDAY}" and alert["severity"] == "error"
    assert alert["title"].startswith("Journal: 2 of 3 entries missing")
    assert alert["detail"] == "Fav 0 (final), Fav 1 (final)"
    assert alert["link"] == "/momentum/journal"
    assert alerts.journal_alerts(_check(), at(FRIDAY, 22)) == []
    assert alerts.journal_alerts(None, at(FRIDAY, 22)) == []


def test_an_empty_journal_is_not_an_alert_yet():
    # A fresh install has no entries at all: nothing was ever recorded, so nothing is missing.
    assert alerts.journal_alerts(_check(missing=3, entries=0), at(FRIDAY, 22)) == []


def test_a_broken_journal_chain_alerts_at_any_time():
    (alert,) = alerts.journal_alerts(_check(problems=["entry 1: changed"]), at(FRIDAY, 10))
    assert alert["id"] == "journal:chain" and "entry 1: changed" in alert["detail"]


def test_result_changes_link_to_the_strategy_and_rank_not_reproducible_above_check():
    changes = [
        {"change_id": "c1", "label": "check", "created_at": "2026-10-08T10:00:00+0000"},
        {
            "change_id": "c2",
            "label": "not_reproducible",
            "created_at": "2026-10-08T11:00:00+0000",
            "kpis_before": {"cagr": 0.2},
            "kpis_after": {"cagr": 0.25},
        },
    ]
    found = alerts.change_alerts(changes, lambda change: ("run-1", "Core"))
    by_id = {a["id"]: a for a in found}
    assert by_id["change:c1"]["severity"] == "warning"
    assert by_id["change:c2"]["severity"] == "error"
    assert by_id["change:c2"]["link"] == "/momentum/saved?strategy=run-1"
    assert by_id["change:c2"]["opened_at"] == "2026-10-08T11:00:00+00:00"
    assert "20.0% -> 25.0%" in by_id["change:c2"]["detail"]
    assert by_id["change:c1"]["title"] == "Core: result moved (Check)"


def _report(findings, *, week="2026-10-09", stale=None):
    return {"week": week, "stale": stale, "findings": findings}


def _finding(rule, level, needs_you=True, action=None):
    return {
        "rule": rule,
        "level": level,
        "title": f"{rule} {level}",
        "detail": "Detail.",
        "action": action,
        "needs_you": needs_you,
    }


def test_live_rules_alerts_cover_breaches_ready_gates_and_stale_checks_but_not_ok_findings():
    report = _report(
        [
            _finding("drawdown", "breach", action="Cut to half."),
            _finding("money_gate", "ready"),
            _finding("trailing", "ok", needs_you=False),
        ],
        stale="2026-10-16",
    )
    found = {a["id"]: a for a in alerts.rules_alerts(report)}
    assert set(found) == {
        "rules:stale:2026-10-16",
        "rules:drawdown:breach:2026-10-09",
        "rules:money_gate:ready:2026-10-09",
    }
    assert found["rules:drawdown:breach:2026-10-09"]["severity"] == "error"
    assert "Your action: Cut to half." in found["rules:drawdown:breach:2026-10-09"]["detail"]
    assert found["rules:money_gate:ready:2026-10-09"]["severity"] == "info"
    assert alerts.rules_alerts(None) == [] and alerts.rules_alerts(_report([])) == []


# --- collect(): state, resolution, unreadable sources --------------------------------------------


def _collect(tmp_path, *, split=True, fail=None):
    class _Con:
        def __enter__(self):
            if fail:
                raise fail
            return object()

        def __exit__(self, *exc):
            return False

    return alerts.collect(
        now=at(FRIDAY, 22),
        catalog=lambda: _Con(),
        weekly_status=lambda today: _status(),
        live_rules_report=lambda: None,
        state_dir=tmp_path,
    )


def test_collect_keeps_open_alerts_when_a_source_cannot_be_read(tmp_path, monkeypatch):
    monkeypatch.setattr(
        alerts,
        "_catalog_alerts",
        lambda con, now: {
            "split": alerts.split_alerts(
                {"items": [{"symbol": "ABC", "ex_date": "x", "previous_close": 2, "close": 1}]}
            ),
            "journal": [],
            "change": [],
            "headline": None,
        },
    )
    first = _collect(tmp_path)
    assert [a["id"] for a in first["alerts"]] == ["split:ABC:x"]
    opened = first["alerts"][0]["opened_at"]

    # A locked catalog is not "all clear": the alert stays, its kind is reported unchecked.
    locked = _collect(tmp_path, fail=RuntimeError("database is locked"))
    assert [a["id"] for a in locked["alerts"]] == ["split:ABC:x"]
    assert set(locked["unchecked"]) == {"split", "journal", "change", "data"}
    assert locked["resolved"] == []

    # A readable catalog without the candidate resolves it, keeping its first opened_at.
    monkeypatch.setattr(
        alerts,
        "_catalog_alerts",
        lambda con, now: {"split": [], "journal": [], "change": [], "headline": None},
    )
    cleared = _collect(tmp_path)
    assert cleared["alerts"] == [] and cleared["unchecked"] == []
    (gone,) = cleared["resolved"]
    assert gone["id"] == "split:ABC:x" and gone["opened_at"] == opened
    assert gone["resolved_at"] is not None


def test_alerts_are_ordered_error_first_then_oldest():
    found = [
        {"severity": "info", "opened_at": "1"},
        {"severity": "warning", "opened_at": "0"},
        {"severity": "error", "opened_at": "3"},
        {"severity": "error", "opened_at": "2"},
    ]
    ordered = sorted(found, key=alerts.order)
    assert [(a["severity"], a["opened_at"]) for a in ordered] == [
        ("error", "2"),
        ("error", "3"),
        ("warning", "0"),
        ("info", "1"),
    ]


# --- the route, end to end -----------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    # A Saturday noon at least two weeks ahead: the Friday before it is after anything these
    # tests create, and every Friday step (16:45, 19:30, the 21:00 journal check) is past, so
    # the result does not depend on the day or hour the suite runs.
    ahead = (datetime.now(IST) + timedelta(days=14)).date()
    saturday = ahead + timedelta(days=(5 - ahead.weekday()) % 7)
    now = datetime.combine(saturday, time(12, 0), tzinfo=IST)
    monkeypatch.setattr(api, "_now", lambda: now)
    monkeypatch.setattr(
        api, "_weekly_status", lambda today=None: {"datasets": [], "target_week": ""}
    )
    return TestClient(api.create_app())


def _ids(client):
    return {a["id"]: a for a in client.get("/api/alerts").json()["alerts"]}


def test_an_unclassified_split_opens_an_alert_and_classifying_it_resolves_it(client):
    with connect() as con:
        con.execute(
            "INSERT INTO stock_action_scan_state (id, manual_review_after) VALUES (1, '2025-01-01')"
        )
        con.execute(
            "INSERT INTO category_membership (category, year, symbol) "
            "VALUES ('Total Market', 2025, 'ABC')"
        )
        con.execute(
            """INSERT INTO stock_action_candidates
               (symbol, ex_date, previous_close, close, previous_volume, volume,
                previous_turnover, turnover, implied_factor, suggested_factor,
                cumulative_factor, status)
               VALUES ('ABC', '2025-01-02', 100, 50, 100, 200, 10000, 10000, 2, 2, 1, 'review')"""
        )
    body = client.get("/api/alerts").json()
    (alert,) = body["alerts"]
    assert alert["id"] == "split:ABC:2025-01-02"
    assert alert["link"] == "/momentum/week?review=ABC"
    assert body["unchecked"] == []

    # The same alert on the next poll: same id, same opened_at.
    again = _ids(client)["split:ABC:2025-01-02"]
    assert again["opened_at"] == alert["opened_at"]

    classify = client.post(
        "/api/stock-actions/review",
        json={
            "symbol": "ABC",
            "ex_date": "2025-01-02",
            "decision": "bonus",
            "factor": 2,
            "source_url": "https://example.com/filing",
            "note": None,
        },
    )
    assert classify.status_code == 200
    after = client.get("/api/alerts").json()
    assert after["alerts"] == []
    assert [r["id"] for r in after["resolved"]] == ["split:ABC:2025-01-02"]
    assert after["resolved"][0]["resolved_at"] is not None


UNIVERSE = ["NIFTY", "GOLD", "BANK"]


def _saved(curve=(100.0, 101.5), versions=None):
    return {
        "dataset": "etf",
        "name": "Core",
        "config": {"universe": UNIVERSE, "top_n": 5},
        "kpis": {"cagr": curve[-1] / 100 - 1},
        "dates": ["2020-01-03", "2020-01-10"],
        "strategy": list(curve),
        "overlay": False,
        "versions": versions
        or {"data": "d1", "tables": {"prices": "d1"}, "lake": "l", "files": "f", "code": "c1"},
    }


def test_an_unreviewed_result_change_opens_an_alert_until_it_is_marked_reviewed(client):
    first = client.post("/api/saved-runs", json=_saved()).json()
    client.post("/api/saved-runs", json=_saved(curve=(100.0, 103.0)))
    (alert,) = client.get("/api/alerts").json()["alerts"]
    assert alert["kind"] == "change" and alert["severity"] == "error"
    assert alert["link"] == f"/momentum/saved?strategy={first['id']}"
    assert alert["title"] == "Core: result moved (Not reproducible)"

    change_id = alert["id"].removeprefix("change:")
    client.post(f"/api/result-changes/{change_id}/reviewed", json={"reviewed_by": "rahul"})
    assert client.get("/api/alerts").json()["alerts"] == []


def test_a_check_change_is_a_warning(client, monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: None)
    client.post("/api/saved-runs", json=_saved())
    code2 = {"data": "d1", "tables": {"prices": "d1"}, "lake": "l", "files": "f", "code": "c2"}
    client.post("/api/saved-runs", json=_saved(curve=(100.0, 103.0), versions=code2))
    (alert,) = client.get("/api/alerts").json()["alerts"]
    assert alert["severity"] == "warning" and alert["title"].endswith("(Check)")


def _expected_friday(now: datetime) -> str:
    return week_ending_on_or_before(now.date()).isoformat()


def test_a_missing_journal_entry_opens_an_alert_that_clears_when_it_is_recorded(client):
    saved = client.post("/api/saved-runs", json=_saved()).json()
    client.patch(f"/api/saved-runs/{saved['id']}", json={"favorite": True})
    friday = _expected_friday(api._now())
    with connect() as con:  # a journal that exists but lacks this week
        forward_journal.record(
            con, _journal_entry(friday="2000-01-07", config_id=saved["id"], run_kind="final")
        )
    (alert,) = client.get("/api/alerts").json()["alerts"]
    assert alert["id"] == f"journal:missing:{friday}"
    assert (
        alert["detail"] == "Core (preview), Core (final), " + NIFTY200_MOMENTUM30_TRI + " (final)"
    )
    assert alert["link"] == "/momentum/journal"

    with connect() as con:
        for kind in ("preview", "final"):
            forward_journal.record(
                con, _journal_entry(friday=friday, config_id=saved["id"], run_kind=kind)
            )
        forward_journal.record(
            con,
            _journal_entry(
                friday=friday,
                config_id=NIFTY200_MOMENTUM30_TRI,
                run_kind="final",
                dataset="benchmark",
            ),
        )
    assert client.get("/api/alerts").json()["alerts"] == []


def _journal_entry(*, friday, config_id, run_kind, dataset="etf"):
    return forward_journal.Entry(
        week=friday,
        run_kind=run_kind,
        source="favourite",
        config_id=config_id,
        config_name="Core",
        dataset=dataset,
        settings={"top_n": 2},
        holdings_before={"Gold": 1.0},
        signal={"week": friday, "rows": [{"asset": "Gold", "action": "HOLD"}]},
        data_fingerprint="fp",
        code_commit="deadbeef",
    )


def test_the_headlines_data_not_ready_opens_an_alert(client, monkeypatch):
    saved = client.post("/api/saved-runs", json=_saved()).json()
    client.patch(f"/api/saved-runs/{saved['id']}", json={"favorite": True, "active": True})
    friday = _expected_friday(api._now())
    monkeypatch.setattr(api, "_weekly_status", lambda today=None: _status_for(friday))
    (alert,) = [a for a in client.get("/api/alerts").json()["alerts"] if a["kind"] == "data"]
    assert alert["id"] == f"data:etf:{friday}"


def _status_for(friday):
    return {**_status(etf_ready=False), "target_week": friday}


def test_a_saved_live_rules_breach_opens_an_alert_until_the_next_check_clears_it(client):
    folder = this_week.state_dir()
    breach = live_rules.Report(
        stage="paper",
        week="2026-10-09",
        weeks=9,
        findings=[live_rules.Finding("drawdown", "breach", "Drawdown cut line hit", "Down 20%.")],
    )
    live_rules.save_last(breach, "action_required", "Drawdown cut line hit", folder)
    (alert,) = client.get("/api/alerts").json()["alerts"]
    assert alert["id"] == "rules:drawdown:breach:2026-10-09" and alert["severity"] == "error"

    ok = live_rules.Report(
        stage="paper",
        week="2026-10-16",
        weeks=10,
        findings=[live_rules.Finding("drawdown", "ok", "Drawdown fine", "Down 2%.")],
    )
    live_rules.save_last(ok, "info", "Live rules check: no rule breached", folder)
    after = client.get("/api/alerts").json()
    assert after["alerts"] == []
    assert [r["kind"] for r in after["resolved"]] == ["rules"]


def test_no_catalog_yet_is_an_empty_list_not_an_error(client, tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path / "nothing-here"))
    body = client.get("/api/alerts")
    assert body.status_code == 200
    assert body.json()["alerts"] == []
