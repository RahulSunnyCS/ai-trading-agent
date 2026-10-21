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
INERT: dict[tuple[str, str], str] = {
    ("etf_filter_taxed_itemised", "cost_pct"): "the itemised cost model prices every fill from "
    "its own rates; cost_pct is the flat model's (engine.py cost model)",
    ("broad_two_categories_three_picks_fortnightly_taxed", "tax"): "the API's Broad runs do not "
    "take tax (api.py `_run_broad` docstring; saved_identity.IGNORED_FIELDS)",
    ("broad_one_category_three_picks_four_weekly_all_fridays", "broad_respect_circuits"): "no "
    "circuit lock blocks a trade here (circuit_exposure blocked_entries and blocked_exits are 0) "
    "and a split run has no circuit_exposure section to echo the flag: finding F3, the setting's "
    "wiring is not exercised by any scenario",
    ("broad_eight_categories_one_pick", "max_category"): "one pick per category: a group is one "
    "stock, held to max_position (15%) long before the 30% group cap",
    ("broad_gates_loosened_and_tilted", "max_category"): "the group cap never binds in this "
    "scenario even at the default 30%: finding F4, no scenario makes max_category bind",
}
#: Not strategy settings: they name the run, not what it does.
NOT_WIRED = {"dataset", "universe"}


def test_scenarios_in_reverse_order_give_the_same_results():
    results = run_scenarios({name: SCENARIOS[name] for name in reversed(list(SCENARIOS))})
    moved = {
        name: found
        for name in SCENARIOS
        if (found := differences(load_expected(name), results[name]))
    }
    assert moved == {}, f"results depend on the order scenarios run in: {sorted(moved)}"


def test_every_setting_a_scenario_changes_changes_its_result():
    defaults = {name: field.default for name, field in BacktestRequest.model_fields.items()}
    variants, expected = {}, {}
    for name in SCENARIOS:
        frozen = load_expected(name)
        for setting, value in frozen["request"].items():
            if setting in NOT_WIRED or setting not in defaults or value == defaults[setting]:
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
        same_request = {**result, "request": expected[key]["request"]}
        if not differences(expected[key], same_request):
            inert.append(key)
    assert inert == [], (
        "putting these settings back to their default changed nothing, so they may not be "
        f"wired: {inert}"
    )
