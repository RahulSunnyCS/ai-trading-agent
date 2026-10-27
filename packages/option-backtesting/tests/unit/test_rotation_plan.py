"""The Today page's baskets with what the platforms hold (`rotation/plan.py`): the tentative list,
the ledger replay per account, and the route. Read-only over temp files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_plan_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import automation_settings, plan


def _jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n")


def _settings(**rows) -> dict:
    s = json.loads(json.dumps(automation_settings.DEFAULT))
    for key, row in rows.items():
        s["rows"][key.replace("_", ".", 1)].update(row)
    return s


@pytest.fixture
def root(tmp_path: Path) -> Path:
    r = tmp_path / "TradingData"
    notes = r / "rotation" / "result-notifications"
    notes.mkdir(parents=True)
    (notes / "2026-10-27.tentative.json").write_text(json.dumps({"adaptive": {"core": ["OLD"]}}))
    (notes / "2026-10-28.tentative.json").write_text(
        json.dumps(
            {
                "adaptive": {
                    "day": "2026-10-28",
                    "sent_on": "2026-10-27",
                    "core": ["S_p320_1302", "N_ditm1_0947"],
                    "buy": [],
                },
                "t1": {"day": "2026-10-28", "sent_on": "2026-10-27", "core": ["N_x-t1s1_0917"]},
            }
        )
    )
    q = r / "rotation" / "quantiply"
    _jsonl(
        q / "ledger.jsonl",
        [
            # Tuesday's algos, deleted after the session
            {
                "action": "create",
                "ok": True,
                "id": "1",
                "name": "Core · N_dir_0917",
                "day": "2026-10-27",
                "weekday": "TUE",
            },
            {
                "action": "delete",
                "ok": True,
                "id": "1",
                "name": "Core · N_dir_0917",
                "day": "2026-10-28",
                "weekday": "WED",
            },
            # Wednesday's: one picked, one left over from an earlier Wednesday
            {
                "action": "create",
                "ok": True,
                "id": "2",
                "name": "Core · N_ditm1_0947",
                "day": "2026-10-28",
                "weekday": "WED",
            },
            {
                "action": "create",
                "ok": True,
                "id": "3",
                "name": "Core · S_p250_1317",
                "day": "2026-10-21",
                "weekday": "WED",
            },
            {
                "action": "create",
                "ok": False,
                "id": "4",
                "name": "Core · S_p320_1302",
                "day": "2026-10-28",
                "weekday": "WED",
            },
            {
                "action": "create",
                "ok": True,
                "id": "5",
                "name": "T1 · N_x-t1s1_0917",
                "day": "2026-10-28",
                "weekday": "WED",
            },
        ],
    )
    _jsonl(
        q / "deploy-ledger.jsonl",
        [{"session": "2026-10-27", "action": "disable", "ok": True, "name": "Core · N_dir_0917"}],
    )
    return r


def test_tentative_is_the_newest_list_after_the_recorded_day(root: Path):
    t = plan._tentative(root, "2026-10-27")
    assert t["day"] == "2026-10-28" and t["sent_on"] == "2026-10-27"
    assert [p["name"] for p in t["books"]["core"]] == ["N_ditm1_0947", "S_p320_1302"]
    assert t["books"]["core"][0]["start"] == "09:47"
    assert plan._tentative(root, "2026-10-28") is None


def test_quantiply_replay_per_session(root: Path):
    st = plan.quantiply_state(
        root, "angelone", "core", ["2026-10-27", "2026-10-28"], today="2026-10-28"
    )
    # Tuesday: deleted now, but it was uploaded for that session and switched off at 15:40
    assert st["2026-10-27"]["uploaded"] == ["N_dir_0917"]
    assert st["2026-10-27"]["held"] == []
    assert st["2026-10-27"]["enabled"] == ["N_dir_0917"]
    # Wednesday: the failed create is not uploaded; the T1 algo is another book's
    assert st["2026-10-28"]["uploaded"] == ["N_ditm1_0947", "S_p250_1317"]
    assert st["2026-10-28"]["enabled"] == []


def test_a_missing_ledger_is_said_not_read_as_nothing_uploaded(root: Path):
    assert "error" in plan.quantiply_state(root, "finvasia", "t1", ["2026-10-28"])
    assert "error" in plan.algotest_state(root, "t1", ["2026-10-28"])


def test_build_lists_only_uploading_accounts_and_flags_leftovers(root: Path, monkeypatch):
    monkeypatch.setattr(
        plan,
        "_recorded",
        lambda r: {"day": "2026-10-27", "kind": "recorded", "on_time": True, "books": {"core": []}},
    )
    settings = _settings(
        quantiply_angelone={"upload": True, "list": "core"},
        algotest_finvasia={"upload": False, "list": "t1"},
    )
    out = plan.build(root, settings)
    assert [s["kind"] for s in out["sessions"]] == ["recorded", "tentative"]
    assert [(a["platform"], a["broker"], a["book"]) for a in out["accounts"]] == [
        ("quantiply", "angelone", "core")
    ]
    wed = out["accounts"][0]["state"]["2026-10-28"]
    assert wed["extra"] == ["S_p250_1317"]
    assert out["paused_until"] is None


def test_uploads_switched_off_lists_no_account(root: Path, monkeypatch):
    monkeypatch.setattr(plan, "_recorded", lambda r: None)
    settings = _settings()
    settings["masters"]["uploads"] = False
    assert plan.build(root, settings)["accounts"] == []


def test_the_route(root: Path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(plan, "_recorded", lambda r: None)
    monkeypatch.setattr(automation_settings, "read", lambda: (_settings(), "settings v1"))
    rotation_plan_routes._cache.clear()
    body = TestClient(create_app()).get("/legwise/rotation/plan").json()
    assert body["sessions"][0]["kind"] == "tentative"
    assert body["settings"] == "settings v1"


def test_a_past_session_counts_only_its_own_uploads(root: Path):
    """The Wednesday algo left over from 21 Oct is held now; it does not make 21 Oct's pick
    'uploaded' unless that session created it (it did here), and a later past Wednesday that
    created nothing reads nothing."""
    st = plan.quantiply_state(
        root, "angelone", "core", ["2026-10-21", "2026-10-14"], today="2026-10-28"
    )
    assert st["2026-10-21"]["uploaded"] == ["S_p250_1317"]
    assert st["2026-10-14"]["uploaded"] == []
