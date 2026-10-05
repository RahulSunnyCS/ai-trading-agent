"""Frozen results (BL-001): a code change that moves any backtest result fails here.

A failure is not a bug report by itself. If the change was meant to move results, review the
printed differences and accept them with a reason:

    uv run python scripts/update-goldens.py --accept-results --reason "why the numbers moved"

If it was not meant to, the change has a side effect to find.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from .harness import EXPECTED, FIXTURE, differences, load_expected, run_scenarios
from .scenarios import SCENARIOS

SIZE_BUDGET_MB = 15
HOW_TO_ACCEPT = (
    "If this change was meant to move results, review them and run:\n"
    '  uv run python scripts/update-goldens.py --accept-results --reason "..."'
)


@pytest.fixture(scope="session")
def results() -> dict[str, dict]:
    return run_scenarios(SCENARIOS)


def test_the_frozen_inputs_are_the_ones_the_results_were_taken_from():
    manifest = json.loads((FIXTURE / "manifest.json").read_text())
    files = {
        str(p.relative_to(FIXTURE)): p
        for p in sorted(FIXTURE.rglob("*"))
        if p.is_file() and p.name != "manifest.json"
    }
    assert set(files) == set(manifest["sha256"]), "fixture files were added or removed"
    changed = [
        name
        for name, path in files.items()
        if hashlib.sha256(path.read_bytes()).hexdigest() != manifest["sha256"][name]
    ]
    assert changed == [], "fixture files changed without rebuilding the manifest"
    assert sum(p.stat().st_size for p in files.values()) <= SIZE_BUDGET_MB * 1e6


def test_every_scenario_has_a_frozen_result_and_nothing_else_does():
    frozen = {p.name.removesuffix(".json.gz") for p in EXPECTED.glob("*.json.gz")}
    assert frozen == set(SCENARIOS), HOW_TO_ACCEPT


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_result_is_unchanged(name, results):
    expected = load_expected(name)
    assert expected is not None, f"no frozen result for {name}. {HOW_TO_ACCEPT}"
    assert results[name]["status"] == 200, results[name]["response"]
    found = differences(expected, results[name])
    assert not found, (
        f"{name}: the result moved in {len(found)}+ places:\n  "
        + "\n  ".join(found[:15])
        + f"\n{HOW_TO_ACCEPT}"
    )
