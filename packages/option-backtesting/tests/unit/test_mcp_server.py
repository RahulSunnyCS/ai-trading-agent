"""
MCP server tool tests — call each `@mcp.tool()`-decorated function through
`mcp.call_tool()` (the real MCP dispatch path, not just a bare function
call) so a signature/serialization mismatch would be caught, without
spinning up a full stdio transport.

`mcp.call_tool()` splits a `list[...]` return into one content block per
item; `structured_content['result']` conveniently holds the full Python
list back for a list-returning tool, and `content[0].text` holds the full
JSON for a dict-returning tool.
"""

import json
from pathlib import Path

import pytest

from option_backtesting.mcp.server import mcp

pytestmark = pytest.mark.anyio

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


async def _call(name: str, args: dict):
    return await mcp.call_tool(name, args)


class TestPlanRequests:
    async def test_returns_all_23_requests_for_a_single_day(self) -> None:
        result = await _call(
            "plan_requests",
            {"underlying": "NIFTY", "start_date": "2026-09-04", "end_date": "2026-09-04"},
        )
        assert result.is_error is False
        requests = result.structured_content["result"]
        assert len(requests) == 23
        assert any(r["raw_key"]["data_kind"] == "cash" for r in requests)
        assert any(r["raw_key"]["data_kind"] == "greeks" for r in requests)

    async def test_lowercases_are_upper_cased(self) -> None:
        result = await _call(
            "plan_requests",
            {"underlying": "nifty", "start_date": "2026-09-04", "end_date": "2026-09-04"},
        )
        requests = result.structured_content["result"]
        assert all(r["raw_key"]["underlying"] == "NIFTY" for r in requests)


class TestValidateStrategy:
    async def test_valid_strategy(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call("validate_strategy", {"yaml_text": yaml_text})
        body = json.loads(result.content[0].text)
        assert body["valid"] is True
        assert body["strategy_id"] == "nifty_flat_A"

    async def test_invalid_strategy_returns_errors_not_an_mcp_error(self) -> None:
        result = await _call("validate_strategy", {"yaml_text": "not: a valid strategy"})
        assert result.is_error is False
        body = json.loads(result.content[0].text)
        assert body["valid"] is False
        assert len(body["errors"]) > 0


class TestRunBacktest:
    async def test_run_matches_golden_net_against_real_cache(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_backtest",
            {"yaml_text": yaml_text, "from_date": "2026-08-17", "to_date": "2026-09-04"},
        )
        body = json.loads(result.content[0].text)
        assert round(body["net_inr"]) == 7568
        assert "run_id" in body
        assert len(body["sessions"]) == 15
        assert body["margin"]["strategy_type"] == "short-straddle"
        assert body["margin"]["peak_margin_inr"] == 560000

    async def test_invalid_strategy_returns_error_dict(self) -> None:
        result = await _call(
            "run_backtest",
            {"yaml_text": "not: valid", "from_date": "2026-08-17", "to_date": "2026-09-04"},
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "invalid_strategy"

    async def test_no_cached_data_returns_error_dict(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_backtest",
            {"yaml_text": yaml_text, "from_date": "2020-01-01", "to_date": "2020-01-02"},
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "no_data"

    async def test_bootstrap_flag_adds_a_bootstrap_key(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_backtest",
            {
                "yaml_text": yaml_text,
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
                "bootstrap": True,
                "seed": 5,
            },
        )
        body = json.loads(result.content[0].text)
        assert "bootstrap" in body
        assert body["bootstrap"]["seed"] == 5


class TestRunWalkforward:
    async def test_headlines_out_of_sample_against_real_cache(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_walkforward",
            {
                "yaml_text": yaml_text,
                "is_from_date": "2026-08-17",
                "is_to_date": "2026-08-27",
                "oos_from_date": "2026-08-28",
                "oos_to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["in_sample"]["from"] == "2026-08-17"
        assert body["out_of_sample"]["from"] == "2026-08-28"
        assert body["in_sample"]["n_sessions"] > 0
        assert body["out_of_sample"]["n_sessions"] > 0

    async def test_overlapping_windows_returns_error_dict(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_walkforward",
            {
                "yaml_text": yaml_text,
                "is_from_date": "2026-08-17",
                "is_to_date": "2026-08-27",
                "oos_from_date": "2026-08-27",
                "oos_to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "bad_window"

    async def test_invalid_strategy_returns_error_dict(self) -> None:
        result = await _call(
            "run_walkforward",
            {
                "yaml_text": "not: valid",
                "is_from_date": "2026-08-17",
                "is_to_date": "2026-08-27",
                "oos_from_date": "2026-08-28",
                "oos_to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "invalid_strategy"


class TestRunSweep:
    async def test_runs_every_config_against_real_cache(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_sweep",
            {
                "base_yaml_text": yaml_text,
                "changes_list": [
                    {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
                    {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
                ],
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["n_configs"] == 2
        assert body["n_successful"] == 2
        assert len(body["configs"]) == 2

    async def test_empty_changes_list_returns_error_dict(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_sweep",
            {
                "base_yaml_text": yaml_text,
                "changes_list": [],
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "bad_sweep"

    async def test_invalid_config_recorded_with_error_not_dropped(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "run_sweep",
            {
                "base_yaml_text": yaml_text,
                "changes_list": [{"strategy": {"caps": {"max_lots": -1}}}],
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["n_configs"] == 1
        assert body["n_successful"] == 0
        assert body["configs"][0]["error"] is not None


class TestCheckOverfit:
    async def test_computes_pbo_and_deflated_sharpe_against_real_cache(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "check_overfit",
            {
                "base_yaml_text": yaml_text,
                "changes_list": [
                    {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
                    {"strategy": {"entry": {"lots": 3}, "caps": {"max_lots": 3}}},
                    {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
                ],
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
                "n_blocks": 4,
            },
        )
        body = json.loads(result.content[0].text)
        assert body["n_configs"] == 3
        assert body["n_combinations"] == 6  # C(4, 2)
        assert 0.0 <= body["pbo"] <= 1.0
        assert body["deflated_sharpe"]["n_trials"] == 3

    async def test_too_few_configs_returns_error_dict(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        result = await _call(
            "check_overfit",
            {
                "base_yaml_text": yaml_text,
                "changes_list": [{"strategy": {"caps": {"max_lots": 4}}}],
                "from_date": "2026-08-17",
                "to_date": "2026-09-04",
            },
        )
        body = json.loads(result.content[0].text)
        assert body["error"] == "cannot_compute"


class TestListRunsAndCritique:
    async def test_list_runs_after_a_run_includes_it(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        run_result = await _call(
            "run_backtest",
            {"yaml_text": yaml_text, "from_date": "2026-08-17", "to_date": "2026-09-04"},
        )
        run_id = json.loads(run_result.content[0].text)["run_id"]

        list_result = await _call("list_runs", {"limit": 50})
        runs = list_result.structured_content["result"]
        assert any(r["run_id"] == run_id for r in runs)

    async def test_critique_unknown_run_id(self) -> None:
        result = await _call("critique_result", {"run_id": "does-not-exist"})
        body = json.loads(result.content[0].text)
        assert "error" in body

    async def test_critique_a_real_run(self) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        run_result = await _call(
            "run_backtest",
            {"yaml_text": yaml_text, "from_date": "2026-08-17", "to_date": "2026-09-04"},
        )
        run_id = json.loads(run_result.content[0].text)["run_id"]

        result = await _call("critique_result", {"run_id": run_id})
        body = json.loads(result.content[0].text)
        assert body["run_id"] == run_id
        assert isinstance(body["notes"], list)
        assert len(body["notes"]) > 0


class TestExportPersonality:
    async def test_unknown_run_id_returns_error_dict(self) -> None:
        result = await _call("export_personality", {"run_id": "does-not-exist"})
        body = json.loads(result.content[0].text)
        assert "error" in body

    async def test_exports_a_real_run(self) -> None:
        yaml_text = (STRATEGIES_DIR / "B_pyramid.yaml").read_text()
        run_result = await _call(
            "run_backtest",
            {"yaml_text": yaml_text, "from_date": "2026-08-17", "to_date": "2026-09-04"},
        )
        run_id = json.loads(run_result.content[0].text)["run_id"]

        result = await _call("export_personality", {"run_id": run_id})
        body = json.loads(result.content[0].text)
        assert body["source_run_id"] == run_id
        assert body["source_strategy_id"] == "nifty_pyramid_B"
        assert body["entryType"] == "fixed_time"
        assert body["managementStyle"] == "roll"
        assert len(body["manual_review"]) > 0


class TestProposeStrategy:
    async def test_valid_mutation(self) -> None:
        result = await _call(
            "propose_strategy",
            {
                "base_preset": "A_flat",
                "changes": {"strategy": {"entry": {"lots": 6}, "caps": {"max_lots": 6}}},
            },
        )
        body = json.loads(result.content[0].text)
        assert body["valid"] is True
        assert "lots: 6" in body["yaml"]

    async def test_unknown_preset_is_rejected(self) -> None:
        result = await _call(
            "propose_strategy", {"base_preset": "does_not_exist", "changes": {}}
        )
        body = json.loads(result.content[0].text)
        assert body["valid"] is False
        assert body["yaml"] is None

    async def test_a_mutation_that_breaks_validation_is_rejected(self) -> None:
        # caps.max_lots above the arithmetic maximum must fail the schema's
        # own reachability validator, not silently apply.
        result = await _call(
            "propose_strategy",
            {"base_preset": "A_flat", "changes": {"strategy": {"caps": {"max_lots": 999}}}},
        )
        body = json.loads(result.content[0].text)
        assert body["valid"] is False
        assert len(body["errors"]) > 0
