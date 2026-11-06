"""BL-052: what makes two saved runs the same strategy, and why a result moved
(saved_identity.py)."""

from __future__ import annotations

import ast
import itertools
import json
from pathlib import Path

import pytest

from momentum_backtesting import api, db_read, saved_identity
from momentum_backtesting.saved_identity import IGNORED_FIELDS, explain, fingerprint, normalise

API = Path(api.__file__)
GOLDEN = Path(__file__).parent / "golden"


def _unread_fields(dataset: str) -> set[str]:
    """Request fields `_<dataset>_parts` never reads, following every api.py function it calls."""
    tree = ast.parse(API.read_text())
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    read: set[str] = set()
    seen: set[str] = set()
    stack = [f"_{dataset}_parts"]
    while stack:
        name = stack.pop()
        if name in seen or name not in functions:
            continue
        seen.add(name)
        for node in ast.walk(functions[name]):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id in ("req", "request")
            ):
                read.add(node.attr)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                stack.append(node.func.id)
    return set(api.BacktestRequest.model_fields) - read - {"dataset", "fresh"}


@pytest.mark.parametrize("dataset", ["etf", "stock", "custom_index", "broad"])
def test_ignored_fields_are_exactly_the_fields_the_dataset_never_reads(dataset):
    # A field that starts being read must stop being ignored, or two different strategies merge.
    assert set(IGNORED_FIELDS[dataset]) == _unread_fields(dataset)


def test_the_request_never_leaves_api_py_whole():
    # The check above only sees `req.<field>` inside api.py; a function elsewhere handed the
    # whole request could read any field.
    tree = ast.parse(API.read_text())
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    leaks = []
    for name in ("_etf_parts", "_stock_parts", "_custom_index_parts", "_broad_parts"):
        for node in ast.walk(functions[name]):
            if not isinstance(node, ast.Call):
                continue
            args = [*node.args, *(keyword.value for keyword in node.keywords)]
            if any(isinstance(a, ast.Name) and a.id in ("req", "request") for a in args):
                callee = ast.unparse(node.func)
                if callee not in functions:
                    leaks.append(f"{name} -> {callee}")
    assert leaks == []


ETF = {"universe": ["NIFTY", "GOLD"], "top_n": 5}


def test_defaults_ignored_fields_and_run_only_switches_do_not_change_the_fingerprint():
    base = fingerprint("etf", ETF)
    assert fingerprint("etf", {**ETF, "exit_rank": 10}) == base  # the request default
    assert fingerprint("etf", {**ETF, "broad_liquidity_filter": True}) == base  # never read by ETF
    assert fingerprint("etf", {**ETF, "fresh": True}) == base
    assert fingerprint("etf", {**ETF, "end": ""}) == fingerprint("etf", {**ETF, "end": None})
    assert fingerprint("etf", {**ETF, "top_n": 6}) != base


def test_weights_count_only_for_the_ranksum_score():
    equal = {**ETF, "lookbacks": [13, 26, 52]}
    assert fingerprint("etf", {**equal, "weights": [1, 1, 1]}) == fingerprint("etf", equal)
    assert fingerprint("etf", {**equal, "weights": [1, 2, 3]}) != fingerprint("etf", equal)
    voladj = {**equal, "score": "voladj"}
    assert fingerprint("etf", {**voladj, "weights": [4, 3, 2]}) == fingerprint("etf", voladj)
    assert normalise("etf", {**equal, "weights": [1, 1, 1.0]})["weights"] == [1.0, 1.0, 1.0]


def test_broad_needs_no_universe_and_a_refused_config_keeps_its_raw_hash():
    assert normalise("broad", {"top_n": 3}) is not None  # universe is never read for Broad
    assert fingerprint("etf", {"top_n": 99}) == saved_identity.raw_hash({"top_n": 99})


@pytest.mark.parametrize("universe", ["turnover_rank", "all_liquid"])
def test_a_universe_that_forces_the_tradability_filter_on_ignores_the_stored_flag(universe):
    """The filter is forced on for these universes, so a run saved with it left off is the same
    strategy as the identical run saved with it on (it used to be a second strategy)."""
    on = {"broad_universe": universe, "broad_liquidity_filter": True}
    off = {"broad_universe": universe, "broad_liquidity_filter": False}
    assert fingerprint("broad", off) == fingerprint("broad", on)
    assert normalise("broad", off) == normalise("broad", on)
    assert normalise("broad", off)["broad_liquidity_filter"] is True


def test_the_tradability_flag_still_counts_on_todays_list():
    on = {"broad_universe": "total_market", "broad_liquidity_filter": True}
    off = {"broad_universe": "total_market", "broad_liquidity_filter": False}
    assert fingerprint("broad", off) != fingerprint("broad", on)
    # A config that names no universe ran on Total Market, where the flag alone decides.
    assert fingerprint("broad", {"broad_liquidity_filter": False}) == fingerprint("broad", off)


def test_scenarios_with_different_golden_results_have_different_fingerprints():
    import importlib.util

    spec = importlib.util.spec_from_file_location("golden_scenarios", GOLDEN / "scenarios.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    SCENARIOS = module.SCENARIOS  # noqa: N806

    summary = json.loads((GOLDEN / "expected" / "summary.json").read_text())
    by_dataset: dict[str, list[tuple[str, str, tuple]]] = {}
    for name, scenario in SCENARIOS.items():
        dataset = scenario["$meta"]
        config = {"universe": ["_"], **scenario.get("with", {})}
        kpis = summary[name]["kpis"]
        result = (kpis.get("cagr"), kpis.get("max_drawdown"), kpis.get("final_value"))
        by_dataset.setdefault(dataset, []).append((name, fingerprint(dataset, config), result))
    for runs in by_dataset.values():
        for (a, fp_a, result_a), (b, fp_b, result_b) in itertools.combinations(runs, 2):
            if result_a != result_b:
                assert fp_a != fp_b, f"{a} and {b} differ in result but share a fingerprint"


# --- versions ---------------------------------------------------------------------------------


def test_versions_split_the_data_version_into_what_can_be_named():
    data_version = (("prices", 10, 123), ("membership", 5, 9), ("year=2026", 1000, 1.5))
    files = (("/data/a.csv", 10, 1),)
    versions = saved_identity.versions_from_input((data_version, files), "abc")
    assert set(versions["tables"]) == {"prices", "membership"}
    assert versions["code"] == "abc"
    moved = saved_identity.versions_from_input(
        ((("prices", 11, 124), ("membership", 5, 9), ("year=2026", 1000, 1.5)), files), "abc"
    )
    assert moved["data"] != versions["data"]
    assert saved_identity.changed_parts(versions, moved) == ["prices"]


def test_the_change_log_is_not_part_of_the_data_version(tmp_path):
    from trading_data.db import connect

    assert "momentum_result_changes" in db_read.RUN_RECORD_TABLES
    with connect(tmp_path):
        pass
    before = db_read.table_fingerprints(tmp_path)
    with connect(tmp_path) as con:
        con.execute(
            "INSERT INTO momentum_result_changes (change_id, dataset, version_id, anchor_run_id, "
            "prev_run_id, run_id, label, kpis_before, kpis_after) "
            "VALUES ('c', 'etf', 'v', 'a', 'p', 'r', 'check', '{}', '{}')"
        )
    # Otherwise the first logged change would make an identical rerun read as "data revised".
    assert db_read.table_fingerprints(tmp_path) == before


def test_your_orders_state_is_not_part_of_the_data_version(tmp_path):
    from trading_data.db import connect

    from momentum_backtesting import holdings_store

    for table in (
        "momentum_holdings",
        "momentum_holding_rules",
        "momentum_owner_settings",
        "momentum_orders",
    ):
        assert table in db_read.RUN_RECORD_TABLES
    with connect(tmp_path):
        pass
    before = db_read.table_fingerprints(tmp_path)
    with connect(tmp_path) as con:
        # Saving settings, syncing holdings, setting a rule and the 14:15 orders job.
        holdings_store.save_settings(con, "rahul", min_trade_rs=5000)
        holdings_store.save_holdings(
            con, "rahul", "paste", [{"symbol": "SBIN", "quantity": 10, "avg_price": 800.0}]
        )
        holdings_store.set_rule(con, "rahul", "LIQUIDBEES", "cash")
        holdings_store.save_orders(
            con,
            "rahul",
            week="2026-10-09",
            trigger="scheduled",
            favourite_id="f1",
            holdings_source="paper",
            payload={"rows": []},
        )
        for table in (
            "momentum_holdings",
            "momentum_holding_rules",
            "momentum_owner_settings",
            "momentum_orders",
        ):
            assert con.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 1
    # Otherwise saving settings or syncing holdings would empty the caches and could make a
    # rerun read as "data revised".
    assert db_read.table_fingerprints(tmp_path) == before


# --- why it moved -----------------------------------------------------------------------------


def _run(curve, code="c1", data="d1", tables=None):
    return {
        "dates": ["2026-01-02", "2026-01-09", "2026-01-16"],
        "strategy": curve,
        "kpis": {"cagr": curve[-1] / 100 - 1},
        "versions": {"data": data, "tables": tables or {"prices": data}, "code": code},
    }


A, B = [100.0, 101.0, 102.0], [100.0, 101.0, 103.0]


def test_a_run_without_fingerprints_is_unknown():
    before = {**_run(A), "versions": None}
    assert explain("etf", before, _run(B))["label"] == "unknown"


def test_same_code_and_data_with_a_different_result_is_not_reproducible():
    assert explain("etf", _run(A), _run(B))["label"] == "not_reproducible"


def test_same_code_new_data_is_data_revised_and_names_what_changed():
    moved = explain("etf", _run(A), _run(B, data="d2", tables={"prices": "d2"}))
    assert moved["label"] == "data_revised"
    assert moved["changed"] == ["prices"]
    assert moved["first_difference"] == "2026-01-16"


def test_code_change_with_a_same_dataset_golden_change_is_intended(monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: "Fix E12")
    moved = explain("etf", _run(A), _run(B, code="c2"))
    assert moved == {**moved, "label": "intended", "reason": "Fix E12"}


def test_code_change_without_one_is_check(monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: None)
    assert explain("etf", _run(A), _run(B, code="c2"))["label"] == "check"


def test_code_and_data_both_changed_is_check_even_with_a_golden_change(monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: "Fix E12")
    assert explain("etf", _run(A), _run(B, code="c2", data="d2"))["label"] == "check"


def test_uncommitted_code_is_never_not_reproducible_or_intended(monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: "Fix E12")
    dirty = "c1+dirty"
    assert explain("etf", _run(A, code=dirty), _run(B, code=dirty))["label"] == "check"


# Two clean commits of the whole repo whose Momentum code is the same (another package moved).
C1, C2 = "c9cf22b1", "96a00ca0"


def _weeks(run, *extra):
    """`run` with later weeks added to its curve."""
    weeks = ["2026-01-23", "2026-01-30"][: len(extra)]
    return {**run, "dates": run["dates"] + weeks, "strategy": run["strategy"] + list(extra)}


def test_a_commit_to_another_package_is_not_a_code_change(monkeypatch):
    seen = []
    monkeypatch.setattr(
        saved_identity, "same_result_code", lambda a, b: seen.append((a, b)) or True
    )
    revised = explain("broad", _run(A, code=C1), _run(B, code=C2, data="d2"))
    assert revised["label"] == "data_revised"
    assert seen == [(C1, C2)]
    # Same package code and the same data, yet a different result: a bug, not "check".
    assert explain("broad", _run(A, code=C1), _run(B, code=C2))["label"] == "not_reproducible"


def test_a_new_friday_with_only_other_packages_commits_is_data_extended(monkeypatch):
    monkeypatch.setattr(saved_identity, "same_result_code", lambda a, b: True)
    before = _run(A, code=C1)
    after = _weeks(_run(A, code=C2, data="d2", tables={"prices": "d2"}), 104.0)
    moved = explain("broad", before, after)
    assert moved["label"] == "data_extended"
    assert moved["first_difference"] == "2026-01-23"
    assert moved["changed"] == ["prices"]
    assert "data_extended" not in saved_identity.NEEDS_REVIEW
    # The same code on the same commit extends the same way.
    assert explain("broad", _run(A), _weeks(_run(A, data="d2"), 104.0))["label"] == "data_extended"
    # An earlier week that moved as well is a revision.
    revised = _weeks(_run(B, code=C2, data="d2"), 104.0)
    assert explain("broad", before, revised)["label"] == "data_revised"
    # When the package code did change, an extension still needs a look.
    monkeypatch.setattr(saved_identity, "same_result_code", lambda a, b: False)
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: None)
    assert explain("broad", before, after)["label"] == "check"


def test_extends_needs_every_earlier_week_unchanged_and_one_more():
    run = _run(A)
    assert saved_identity.extends(run, _weeks(run, 104.0))
    assert not saved_identity.extends(run, run)  # nothing added
    assert not saved_identity.extends(_weeks(run, 104.0), run)  # a week removed
    assert not saved_identity.extends(run, _weeks(_run(B), 104.0))  # an earlier week moved
    shifted = {**_weeks(run, 104.0), "dates": ["2025-12-26", *run["dates"]]}
    assert not saved_identity.extends(run, shifted)  # started a week earlier
    assert not saved_identity.extends({**run, "dates": [], "strategy": []}, run)


def test_uncommitted_or_unknown_code_never_reaches_the_package_diff(monkeypatch):
    calls = []
    monkeypatch.setattr(saved_identity, "same_result_code", lambda a, b: calls.append(1) or True)
    assert explain("broad", _run(A, code=C1 + "+dirty"), _run(B, code=C2))["label"] == "check"
    assert explain("broad", _run(A, code="unknown"), _run(B, code=C2))["label"] == "check"
    assert calls == []


def test_same_result_code_refuses_anything_but_a_commit_id(monkeypatch):
    calls = []
    monkeypatch.setattr(
        saved_identity.subprocess, "run", lambda *args, **kw: calls.append(args) or None
    )
    assert saved_identity.same_result_code("--output=/tmp/x", C2) is False
    assert saved_identity.same_result_code(C1, "HEAD") is False
    assert saved_identity.same_result_code(C1, f"{C2} -p") is False
    assert calls == []


def test_same_result_code_asks_git_about_the_package_paths_only(monkeypatch):
    calls = []

    class Done:
        returncode = 0

    def run(args, **kw):
        calls.append(args)
        return Done()

    monkeypatch.setattr(saved_identity.subprocess, "run", run)
    assert saved_identity.same_result_code(C1, C2) is True
    assert calls == [["git", "diff", "--quiet", C1, C2, "--", *saved_identity.RESULT_CODE]]
    Done.returncode = 1  # the package code differs
    assert saved_identity.same_result_code(C1, C2) is False
    Done.returncode = 128  # a commit this checkout does not have
    assert saved_identity.same_result_code(C1, C2) is False


def test_same_result_code_on_this_checkout():
    head = saved_identity._git("rev-parse", "HEAD")
    if not head:
        pytest.skip("not a git checkout")
    head = head.strip()
    assert saved_identity.same_result_code(head, head) is True
    assert saved_identity.same_result_code(head, "0" * 40) is False


CHANGELOG_DIFF = """\
+++ b/tests/golden/CHANGELOG.md
+## 2026-10-09 (on top of `abc1234`)
+
+Broad: circuit days now counted from the fill week.
+
+| Scenario | CAGR | Max drawdown |
+|---|---|---|
+| broad_default | 18.29% -> 18.40% | -26.72% -> -26.72% |
"""


def test_only_a_golden_change_of_the_same_dataset_explains_a_move(monkeypatch):
    monkeypatch.setattr(saved_identity, "_git", lambda *args: CHANGELOG_DIFF)
    reason = saved_identity.accepted_golden_change("abc1234", "def5678", "broad")
    assert reason == "Broad: circuit days now counted from the fill week."
    # An accepted Broad change cannot hide an ETF move.
    assert saved_identity.accepted_golden_change("abc1234", "def5678", "etf") is None


def test_same_result_ignores_float_noise_only():
    assert saved_identity.same_result(_run(A), _run([100.0, 101.0, 102.0 + 1e-12]))
    assert not saved_identity.same_result(_run(A), _run(B))


def test_the_extended_tags_companion_never_makes_a_run_a_new_result():
    """A run saved before BL-036 Phase 1 has no extended_* keys; its re-run has them."""
    before = _run(A)
    after = _run(A)
    after["kpis"] = {**after.get("kpis", {}), "extended_cagr": 0.33, "extended_max_drawdown": -0.38}
    assert saved_identity.same_result(before, after)
    assert saved_identity.same_result(after, before)
    # A headline number that moved still does.
    moved = _run(A)
    moved["kpis"] = {**moved.get("kpis", {}), "cagr": 0.5, "extended_cagr": 0.33}
    assert not saved_identity.same_result(before, moved)


def test_a_commit_that_is_not_a_plain_id_never_reaches_git(monkeypatch):
    calls = []
    monkeypatch.setattr(saved_identity, "_git", lambda *args: calls.append(args) or CHANGELOG_DIFF)
    assert saved_identity.accepted_golden_change("--output=/tmp/x", "abc1234", "broad") is None
    assert saved_identity.accepted_golden_change("abc1234", "def5678 -p", "broad") is None
    assert calls == []
    assert saved_identity.accepted_golden_change("abc1234", "def5678", "broad") is not None


def test_tool_state_files_do_not_move_the_input_version(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    (tmp_path / "weekly_closes.csv").write_text("a")
    before = api.input_version()
    (tmp_path / ".fyers_token.json").write_text("{}")  # rewritten every morning
    (tmp_path / "live_rules_last.json").write_text("{}")
    (tmp_path / "alerts_state.json").write_text("{}")  # rewritten when an alert opens or clears
    (tmp_path / "launchd-weekly-final.log").write_text("x")
    assert api.input_version() == before
    (tmp_path / "weekly_closes.csv").write_text("ab")  # a real input still counts
    assert api.input_version() != before


def test_all_fridays_moves_no_existing_fingerprint_and_ignores_the_phase():
    """BL-087: off (or meaningless) it is not part of a strategy; on, the calendar phase is not."""
    base = {"universe": ["Nifty 50"], "rebalance_every": 4, "rebalance_offset": 1}
    assert fingerprint("etf", base) == fingerprint("etf", {**base, "split_fridays": False})
    weekly = {"universe": ["Nifty 50"]}
    assert fingerprint("etf", weekly) == fingerprint("etf", {**weekly, "split_fridays": True})
    split = {**base, "split_fridays": True}
    assert fingerprint("etf", split) != fingerprint("etf", base)
    assert fingerprint("etf", split) == fingerprint("etf", {**split, "rebalance_offset": 3})
