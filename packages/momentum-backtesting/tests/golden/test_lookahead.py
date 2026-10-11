"""No backtest may use prices from after the day it is deciding on (BL-001, BL-010 step 4).

The same run is done twice: on the whole fixture, stopped at a cut date; and on a fixture in
which nothing after the cut date exists at all. If any result up to the cut differs, something
upstream of it read the future: a ranking, a liquidity gate, a pool refresh, a cache.

What this cannot see is hindsight already inside the stored inputs, such as prices adjusted
for a later split or today's index membership applied to earlier years.
"""

from __future__ import annotations

import pytest

from .harness import differences, run_scenarios

CUTS = ("2021-06-25", "2023-03-31", "2025-04-04")  # Fridays
DATASETS = ("etf", "stock", "custom_index", "broad")
#: The parts of a response that are the result. Others (`latest`, `instruments`) describe the
#: data on hand and may honestly differ when later data is absent.
RESULT_KEYS = (
    "kpis",
    "series",
    "trades",
    "rotations",
    "yearly",
    "open_positions",
    "comparisons",
    "benchmarks",
    # The extended-tags companion (BL-036 Phase 1): a second engine pass over the same ranking.
    "companion",
)


#: Fields that honestly depend on later data, and why each is left out of the comparison.
NOT_COMPARED = {
    # A price level on today's share count: a later split rescales it. Returns are unaffected.
    "price",
    # Whether a fill was priced on the index because the ETF was not listed yet. An ETF with
    # no data at all (listed after the cut) is reported as not proxied; a display flag only.
    "proxy",
    "proxy_trades",
}


def _comparable(value):
    """`value` without the fields above."""
    if isinstance(value, dict):
        return {k: _comparable(v) for k, v in value.items() if k not in NOT_COMPARED}
    if isinstance(value, list):
        return [_comparable(v) for v in value]
    return value


@pytest.fixture(scope="module", params=CUTS)
def pair(request) -> tuple[dict, dict]:
    cut = request.param
    scenarios = {dataset: {"$meta": dataset, "with": {"end": cut}} for dataset in DATASETS}
    whole = run_scenarios(scenarios)
    # The truncated run gets the whole run's exact requests: a default universe is built from
    # the data on hand, and the two runs must be the same strategy.
    return whole, run_scenarios({d: whole[d]["request"] for d in whole}, cutoff=cut)


@pytest.mark.parametrize("dataset", DATASETS)
def test_a_run_stopped_at_a_date_equals_a_run_that_never_had_later_data(dataset, pair):
    whole, truncated = pair
    assert whole[dataset]["status"] == 200, whole[dataset]["response"]
    assert truncated[dataset]["status"] == 200, truncated[dataset]["response"]
    found = []
    for key in RESULT_KEYS:
        found += differences(
            _comparable(whole[dataset]["response"].get(key)),
            _comparable(truncated[dataset]["response"].get(key)),
            f"{key}.",
        )
    assert not found, f"{dataset}: later data changed an earlier result:\n  " + "\n  ".join(
        found[:15]
    )
