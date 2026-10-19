"""Rule specs (BL-120): what validates, what is refused and why, and which edits change a hash."""

from __future__ import annotations

import copy

import pytest
import yaml

from option_backtesting.ruletest.spec import SpecError, from_dict, load_spec, read_back

BASE = {
    "id": "gap_up_dir",
    "underlying": "NIFTY",
    "window": {"from": "10:30", "to": "14:00"},
    "when": {"gt": ["close", {"add": ["pivot", 10]}]},
    "template": {
        "exit_time": "15:28",
        "legs": [
            {
                "id": "ce",
                "lots": 1,
                "position": "sell",
                "option_type": "CE",
                "strike": {"strike_type": "ATM"},
                "stop_loss": {"percent": 21},
            },
            {
                "id": "pe",
                "lots": 1,
                "position": "sell",
                "option_type": "PE",
                "strike": {"strike_type": "ATM"},
                "stop_loss": {"percent": 21},
            },
        ],
        "overall": {"stop_loss_inr": 3000},
    },
}


def spec(**changes):
    data = copy.deepcopy(BASE)
    data.update(changes)
    return data


def test_a_valid_spec_compiles_and_reads_back():
    rule = from_dict(spec())
    assert rule.sides == ("both",) and (rule.start, rule.stop) == (75, 285)
    back = read_back(rule)
    assert back["sentences"][0].startswith("Watch the NIFTY index from 10:30 to 14:00.")
    assert "close > (pivot + 10)" in back["when"]
    assert any("sell 1 lot ATM CE" in s for s in back["sentences"])


def test_hash_ignores_labels_and_key_order_but_not_the_rule():
    a = from_dict(spec())
    b = from_dict(spec(id="renamed", name="Renamed", notes="x", parent="abc"))
    assert a.spec_hash == b.spec_hash and a.template_hash == b.template_hash
    reordered = copy.deepcopy(BASE)
    reordered["template"]["legs"][0] = dict(
        reversed(list(reordered["template"]["legs"][0].items()))
    )
    assert from_dict(reordered).spec_hash == a.spec_hash
    changed = from_dict(spec(when={"gt": ["close", {"add": ["pivot", 11]}]}))
    assert changed.spec_hash != a.spec_hash
    assert (
        changed.template_hash == a.template_hash
    )  # the simulation cache is shared across conditions
    other_stop = copy.deepcopy(BASE)
    other_stop["template"]["overall"]["stop_loss_inr"] = 2500
    assert from_dict(other_stop).template_hash != a.template_hash


def test_directional_legs_need_direction_and_pick_legs_per_side():
    data = spec()
    data["template"]["legs"][0]["on"] = "up"
    data["template"]["legs"][1]["on"] = "down"
    with pytest.raises(SpecError, match="needs `direction_up`"):
        from_dict(data)
    data["direction_up"] = {"gt": ["close", "open"]}
    rule = from_dict(data)
    assert rule.sides == ("up", "down")
    up = rule.strategy_for("11:01", "up")
    down = rule.strategy_for("11:01", "down")
    assert [leg.id for leg in up.legs] == ["ce"] and [leg.id for leg in down.legs] == ["pe"]
    assert up.entry_time == "11:01" and up.exit_time == "15:28"


def test_direction_without_directional_legs_is_refused():
    with pytest.raises(SpecError, match="no leg depends on it"):
        from_dict(spec(direction_up={"gt": ["close", "open"]}))


def test_slippage_override_reaches_the_strategy():
    rule = from_dict(spec())
    assert rule.strategy_for("11:01", "both").execution.slippage_pct == 0
    assert rule.strategy_for("11:01", "both", 0.5).execution.slippage_pct == 0.5


@pytest.mark.parametrize(
    "mutate,needle",
    [
        (lambda d: d["window"].update({"from": "10:30", "to": "15:29"}), "entry minute after it"),
        (lambda d: d["window"].update({"from": "14:00", "to": "10:30"}), "`from` is after `to`"),
        (lambda d: d["window"].update({"to": "25:99"}), "outside the 09:15-15:29"),
        (lambda d: d["window"].update({"to": "noon"}), "is not a HH:MM time"),
        (lambda d: d["template"].update({"exit_time": "14:00"}), "exit_time must be after"),
        (
            lambda d: d["template"]["legs"][0].update(
                {"range_breakout": {"until": "11:00", "side": "high"}}
            ),
            "not supported in a rule yet",
        ),
        (
            lambda d: d["template"]["legs"][0].update({"on": "sideways"}),
            "expected up, down or both",
        ),
        (lambda d: d.update({"template": {"exit_time": "15:28"}}), "give the legs"),
        (lambda d: d.update({"underlying": "BANKNIFTY"}), "NIFTY or SENSEX"),
        (lambda d: d.update({"id": "Has Spaces"}), "pattern"),
        (lambda d: d.update({"when": {"gt": ["close", "nope"]}}), "unknown name"),
        (lambda d: d.update({"when": {"add": [1, 2]}}), "must be true / false"),
        (lambda d: d.update({"surprise": 1}), "Extra inputs"),
    ],
)
def test_refusals_say_why(mutate, needle):
    data = copy.deepcopy(BASE)
    mutate(data)
    with pytest.raises(SpecError) as error:
        from_dict(data)
    assert needle in str(error.value)


def test_load_spec_text_errors():
    with pytest.raises(SpecError, match="one top-level key"):
        load_spec("id: x")
    with pytest.raises(SpecError, match="not valid YAML at line"):
        load_spec("rule: [unclosed")
    assert load_spec(yaml.safe_dump({"rule": BASE})).spec.id == "gap_up_dir"
