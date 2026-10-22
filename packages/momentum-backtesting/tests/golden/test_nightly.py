"""The slow checks of BL-001 Phase 2, run nightly (MOMENTUM_GOLDEN_FULL=1; CI sets it on the
schedule trigger).

- **Order does not matter.** The same scenarios in reverse order, in a fresh process, give the
  same results. A result that depends on what ran before it is a cache keyed too loosely.
- **Every setting is wired.** For each setting a scenario changes from its default, the same
  scenario with that one setting put back must give a different result. A setting that changes
  nothing is not reaching the engine (or is not read by that dataset: list it in INERT with the
  reason).
"""

from __future__ import annotations

import os

import pytest

from momentum_backtesting.api import BacktestRequest

from .harness import differences, load_expected, run_scenarios
from .scenarios import SCENARIOS

pytestmark = pytest.mark.skipif(
    os.environ.get("MOMENTUM_GOLDEN_FULL") != "1",
    reason="nightly: set MOMENTUM_GOLDEN_FULL=1 to run",
)

#: (scenario, setting) -> why putting it back changes nothing in that scenario.
LOCKS_IDLE = (
    "no circuit lock changes a fill in this scenario; only broad_gates_loosened_and_tilted has a "
    "result that depends on the setting: finding F3"
)
INERT: dict[tuple[str, str], str] = {
    ("etf_filter_taxed_itemised", "cost_pct"): "the itemised cost model prices every fill from "
    "its own rates; cost_pct is the flat model's (engine.py cost model)",
    ("broad_two_categories_three_picks_fortnightly_taxed", "tax"): "the API's Broad runs do not "
    "take tax (api.py `_run_broad` docstring; saved_identity.IGNORED_FIELDS)",
    (
        "broad_default",
        "broad_respect_circuits",
    ): LOCKS_IDLE,
    (
        "broad_one_category_three_picks_four_weekly",
        "broad_respect_circuits",
    ): LOCKS_IDLE,
    (
        "broad_one_category_three_picks_four_weekly_all_fridays",
        "broad_respect_circuits",
    ): LOCKS_IDLE,
    (
        "broad_eight_categories_one_pick",
        "broad_respect_circuits",
    ): LOCKS_IDLE,
    (
        "broad_two_categories_three_picks_fortnightly_taxed",
        "broad_respect_circuits",
    ): LOCKS_IDLE,
    ("broad_eight_categories_one_pick", "max_category"): "one pick per category: a group is one "
    "stock, held to max_position (15%) long before the 30% group cap",
    ("broad_gates_loosened_and_tilted", "max_category"): "the group cap never binds in this "
    "scenario even at the default 30%: finding F4, no scenario makes max_category bind",
}
#: Not strategy settings: they name the run, not what it does.
RUN_IDENTITY = {"dataset", "universe"}


#: What a run produced. The rest of a response describes the request (a section such as
#: circuit_exposure echoes the setting that was just changed), so it would make every setting
#: look wired.
RESULT_SECTIONS = ("kpis", "series", "trades", "rotations", "yearly", "open_positions", "timeline")


def _result_only(run: dict) -> dict:
    response = run["response"]
    return {
        "status": run["status"],
        "response": {k: response[k] for k in RESULT_SECTIONS if k in response},
    }


def test_scenarios_in_reverse_order_give_the_same_results():
    results = run_scenarios({name: SCENARIOS[name] for name in reversed(list(SCENARIOS))})
    moved = {
        name: found
        for name in SCENARIOS
        if (found := differences(load_expected(name), results[name]))
    }
    assert moved == {}, f"results depend on the order scenarios run in: {sorted(moved)}"


def test_every_setting_a_scenario_changes_changes_its_result():
    defaults = {
        name: field.get_default(call_default_factory=True)
        for name, field in BacktestRequest.model_fields.items()
    }
    variants, expected = {}, {}
    for name in SCENARIOS:
        frozen = load_expected(name)
        for setting, value in frozen["request"].items():
            if setting in RUN_IDENTITY or setting not in defaults or value == defaults[setting]:
                continue
            if (name, setting) in INERT:
                continue
            key = f"{name}::{setting}"
            variants[key] = {**frozen["request"], setting: defaults[setting]}
            expected[key] = frozen
    results = run_scenarios(variants)
    inert = []
    for key, result in results.items():
        if result["status"] != 200:
            continue  # putting it back made the request invalid: something reads it
        if not differences(_result_only(expected[key]), _result_only(result)):
            inert.append(key)
    assert inert == [], (
        "putting these settings back to their default changed nothing, so they may not be "
        f"wired: {inert}"
    )
