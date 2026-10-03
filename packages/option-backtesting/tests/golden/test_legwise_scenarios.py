"""Thirty exact-output regression scenarios for the production leg-wise engine."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from .legwise_scenarios import DAYS, SCENARIOS, build_document, load_expected


@pytest.fixture(scope="module")
def actual_document() -> dict:
    return build_document()


@pytest.fixture(scope="module")
def expected_document() -> dict:
    return load_expected()


def _by_id(document: dict) -> dict[str, dict]:
    return {scenario["id"]: scenario for scenario in document["scenarios"]}


def _unique_days(document: dict) -> Iterator[dict]:
    """Use the four all-window scenarios once, without rechecking duplicated windows."""
    for scenario in document["scenarios"]:
        if scenario["id"].endswith("__all_6d"):
            yield from scenario["days"]


def test_catalog_has_exactly_thirty_named_scenarios() -> None:
    assert len(SCENARIOS) == 30
    assert len({scenario.id for scenario in SCENARIOS}) == 30
    assert sum(scenario.start == scenario.end for scenario in SCENARIOS) == 24
    assert {
        (scenario.start, scenario.end) for scenario in SCENARIOS if scenario.start != scenario.end
    } == {
        (DAYS[0], DAYS[2]),
        (DAYS[3], DAYS[-1]),
        (DAYS[0], DAYS[-1]),
    }


def test_frozen_inputs_and_reference_tables_have_not_changed(
    actual_document: dict, expected_document: dict
) -> None:
    assert actual_document["inputs"] == expected_document["inputs"]


@pytest.mark.parametrize("scenario_id", [scenario.id for scenario in SCENARIOS])
def test_scenario_matches_reviewed_snapshot(
    scenario_id: str, actual_document: dict, expected_document: dict
) -> None:
    actual = _by_id(actual_document)
    expected = _by_id(expected_document)
    assert set(actual) == set(expected)
    assert actual[scenario_id] == expected[scenario_id]


def test_every_saved_day_obeys_financial_and_trade_ledger_invariants(
    actual_document: dict,
) -> None:
    rows = list(_unique_days(actual_document))
    assert len(rows) == 4 * len(DAYS)
    for row in rows:
        assert row["net"] == round(row["gross"] - row["costs"], 2)
        # Gross is rounded after summing raw fills, while snapshot trade P&L is
        # rounded per trade for readability. Their displayed totals may differ
        # by at most half a paisa per trade, accumulated at the final rounding.
        displayed_trade_total = round(sum(trade["pnl"] for trade in row["trades"]), 2)
        rounding_bound = 0.005 * len(row["trades"]) + 0.005
        assert abs(row["gross"] - displayed_trade_total) <= rounding_bound
        assert row["mtm_points"] > 0
        for trade in row["trades"]:
            assert trade["quantity"] > 0
            assert trade["exit_time"] is not None
            assert trade["entry_time"] <= trade["exit_time"]
            assert trade["exit_reason"]
