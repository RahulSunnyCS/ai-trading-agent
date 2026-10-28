"""The rule tester's MCP tools (BL-120 Phase 2), called through `mcp.call_tool()` like
`test_mcp_server.py`: the spec is read back, a test needs the read-back's hash, every test lands in
the ledger, and the confirmation period stays locked (no tool opens it). The lake itself is not
needed: `study.run_test` runs for real with the frame loader and the per-period analysis faked, so
the ledger, the lock and the counts are the real ones."""

from __future__ import annotations

import json

import pytest
import yaml

from option_backtesting.fyers.daily import data_dir
from option_backtesting.mcp.server import mcp
from option_backtesting.ruletest import store, study
from tests.unit.test_ruletest_spec import BASE, spec

pytestmark = pytest.mark.anyio

TEXT = yaml.safe_dump({"rule": BASE})


async def _call(name: str, args: dict) -> dict:
    result = await mcp.call_tool(name, args)
    assert result.is_error is False, result
    return json.loads(result.content[0].text)


async def _hash(text: str = TEXT) -> str:
    return (await _call("validate_rule", {"spec_text": text}))["spec_hash"]


def _period(name: str) -> dict:
    lo, hi = study.PERIODS[name]
    row = {"day": "2025-01-02", "net": 120.0}
    return {
        "period": name,
        "from": lo.isoformat(),
        "to": hi.isoformat(),
        "events_found": 1,
        "events": 1,
        "event_days": 1,
        "thin": True,
        "net_mean": 120.0,
        "net_total": 120.0,
        "gross_mean": 170.0,
        "win_rate": 1.0,
        "stopped_share": 0.0,
        "placebo": {"events": 1, "placebo_mean": 20.0, "diff_mean": 100.0, "diff_t": None},
        "random_time": {"draws": 0},
        "slippage": {"0.5": {"events": 1, "net_mean": 90.0}},
        "equity": [["2025-01-02", 120.0]],
        "rows": [row],
    }


@pytest.fixture
def fake_lake(monkeypatch):
    """run_test without the lake: no frame to load, one made-up event per period."""
    calls: list[str] = []

    def analyse(root, rule, frame, period, options):
        calls.append(period)
        options.progress(f"{period}: faked")
        return _period(period)

    monkeypatch.setattr(study.F, "load_frame", lambda *a, **k: None)
    monkeypatch.setattr(study, "analyse_period", analyse)
    return calls


class TestValidateRule:
    async def test_reads_the_rule_back(self) -> None:
        body = await _call("validate_rule", {"spec_text": TEXT})
        assert body["valid"] is True and len(body["spec_hash"]) == 16
        assert body["sides"] == ["both"] and body["window"] == ["10:30", "14:00"]
        assert body["sentences"][0].startswith("Watch the NIFTY index")
        assert store.ledger(data_dir()) == []  # validating is not a test

    async def test_names_the_problem_without_raising(self) -> None:
        bad = yaml.safe_dump({"rule": spec(when={"gt": ["close", "nope"]})})
        body = await _call("validate_rule", {"spec_text": bad})
        assert body["valid"] is False and "unknown name 'nope'" in body["message"]
        body = await _call("validate_rule", {"spec_text": "x" * 20_001})
        assert body["valid"] is False and "over 20000" in body["message"]


class TestTestRule:
    async def test_runs_records_and_returns_the_ledger_row(self, fake_lake) -> None:
        h = await _hash()
        body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h})
        assert fake_lake == ["learning"]
        assert body["read_back"]["spec_hash"] == h
        assert body["result"]["mode"] == "locked"
        assert body["result"]["label"] == "a screen, not a finding"
        learning = body["result"]["periods"]["learning"]
        assert "rows" not in learning and "equity" not in learning and learning["events"] == 1
        assert "test 1 this week" in body["summary"]
        assert body["progress"][-1] == "learning: faked"
        rows = store.ledger(data_dir())
        assert len(rows) == 1 and body["ledger_row"] == rows[0]
        assert rows[0]["id"] == body["result"]["id"] and rows[0]["mode"] == "locked"
        assert body["counts"]["total"] == 1
        assert store.read_result(data_dir(), rows[0]["id"])["periods"]["learning"]["rows"]

    async def test_include_rows_and_tries_count(self, fake_lake) -> None:
        h = await _hash()
        body = await _call(
            "test_rule", {"spec_text": TEXT, "spec_hash": h, "tries": 5, "include_rows": True}
        )
        assert body["result"]["periods"]["learning"]["rows"]
        assert body["ledger_row"]["tries"] == 5 and body["counts"]["total"] == 5

    async def test_needs_the_read_back_hash_and_runs_nothing_without_it(self, fake_lake) -> None:
        body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": "0" * 16})
        assert body["error"] == "spec_hash_mismatch"
        assert body["read_back"]["sentences"]
        other = yaml.safe_dump({"rule": spec(window={"from": "10:00", "to": "14:00"})})
        body = await _call("test_rule", {"spec_text": other, "spec_hash": await _hash()})
        assert body["error"] == "spec_hash_mismatch"
        assert fake_lake == [] and store.ledger(data_dir()) == []

    async def test_bad_spec_period_and_tries_are_errors(self, fake_lake) -> None:
        h = await _hash()
        body = await _call("test_rule", {"spec_text": "rule: 1", "spec_hash": h})
        assert body["error"] == "invalid_rule"
        body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h, "period": "all"})
        assert body["error"] == "bad_period"
        body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h, "tries": 0})
        assert body["error"] == "bad_tries"
        sensex = yaml.safe_dump({"rule": spec(underlying="SENSEX")})
        body = await _call(
            "test_rule",
            {"spec_text": sensex, "spec_hash": await _hash(sensex), "period": "confirmation"},
        )
        assert body["error"] == "cannot_test" and "NIFTY data only" in body["message"]
        assert fake_lake == [] and store.ledger(data_dir()) == []

    async def test_confirmation_is_locked_and_no_tool_opens_it(self, fake_lake) -> None:
        h = await _hash()
        for period in ("confirmation", "both"):
            body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h, "period": period})
            assert body["error"] == "locked" and "locked for this strategy" in body["message"]
        assert fake_lake == [] and store.ledger(data_dir()) == []
        assert not store.is_revealed(data_dir(), h)
        tools = {t.name: t for t in await mcp.list_tools()}
        assert not [name for name in tools if "reveal" in name]
        params = set(tools["test_rule"].input_schema["properties"])
        assert params == {"spec_text", "spec_hash", "period", "tries", "include_rows"}

    async def test_a_rule_the_owner_revealed_can_test_confirmation(self, fake_lake) -> None:
        h = await _hash()
        store.reveal(data_dir(), h, "owner")
        body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h, "period": "both"})
        assert fake_lake == ["learning", "confirmation"]
        assert body["ledger_row"]["periods"] == ["learning", "confirmation"]
        assert body["ledger_row"]["mode"] == "locked"
        assert len(store.reveals(data_dir())) == 1  # nothing further logged as a reveal


class TestListRuleTests:
    async def test_empty_ledger(self) -> None:
        body = await _call("list_rule_tests", {})
        assert body["tests"] == [] and body["counts"] == {"week": 0, "month": 0, "total": 0}

    async def test_newest_first_with_counts_and_limit(self, fake_lake) -> None:
        h = await _hash()
        ids = []
        for tries in (1, 2, 3):
            body = await _call("test_rule", {"spec_text": TEXT, "spec_hash": h, "tries": tries})
            ids.append(body["result"]["id"])
        body = await _call("list_rule_tests", {"limit": 2})
        assert [r["id"] for r in body["tests"]] == ids[::-1][:2]
        assert body["counts"]["total"] == 6
        assert "With 6 tests" in body["luck"]
