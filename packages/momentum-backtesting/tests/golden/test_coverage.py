"""A backtest setting nobody exercises is a setting nobody would notice breaking (BL-001).

Every field of the API's backtest request must be given a value other than its default by at
least one frozen scenario, and every choice of a multiple-choice field must be used by one.
Adding a field without a scenario fails here: add a scenario (or extend one) and accept the
new result, or list the field in EXEMPT with the reason.
"""

from __future__ import annotations

import typing

from momentum_backtesting.api import BacktestRequest

from .harness import load_expected
from .scenarios import SCENARIOS

#: field -> why no scenario needs to set it.
EXEMPT = {
    "fresh": "drops server caches before a run; not a strategy setting",
    "broad_universe": "all_liquid needs every NSE stock; the fixture holds 170",
    "broad_category_tags": "extended tags cover stocks outside the fixture's 170",
}
#: (field, choice) -> why no scenario uses that choice.
EXEMPT_CHOICES = {
    ("execution", "mon_10am"): "needs intraday prices, which are not collected yet",
    ("broad_universe", "all_liquid"): EXEMPT["broad_universe"],
    ("broad_category_tags", "extended"): EXEMPT["broad_category_tags"],
    ("broad_universe", "turnover_rank"): "the top 750 by turnover needs the whole lake; the "
    "fixture holds 170. tests/test_broad_parity.py checks the argument plumbing instead",
}


def _requests() -> list[dict]:
    return [load_expected(name)["request"] for name in SCENARIOS]


def test_every_setting_is_changed_from_its_default_by_some_scenario():
    requests = _requests()
    unexercised = []
    for name, field in BacktestRequest.model_fields.items():
        if name in EXEMPT or name in ("dataset", "universe"):
            continue
        if not any(name in r and r[name] != field.default for r in requests):
            unexercised.append(name)
    assert unexercised == [], f"no scenario sets these to a non-default value: {unexercised}"


def test_every_choice_of_every_setting_is_used_by_some_scenario():
    requests = _requests()
    unused = []
    for name, field in BacktestRequest.model_fields.items():
        if typing.get_origin(field.annotation) is not typing.Literal:
            continue
        for choice in typing.get_args(field.annotation):
            used = any(r.get(name, field.default) == choice for r in requests)
            if not used and (name, choice) not in EXEMPT_CHOICES:
                unused.append((name, choice))
    assert unused == [], f"no scenario uses these choices: {unused}"


def test_exemptions_name_real_fields():
    fields = set(BacktestRequest.model_fields)
    assert set(EXEMPT) <= fields
    assert {name for name, _choice in EXEMPT_CHOICES} <= fields
