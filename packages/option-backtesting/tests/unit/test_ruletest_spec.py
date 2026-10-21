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


# --- exit_when and the premium-% strike --------------------------------------------------------

BUY_TREND = {
    "id": "st_buy",
    "underlying": "NIFTY",
    "window": {"from": "09:15", "to": "14:00"},
    "when": {"gt": [{"supertrend_dir": {}}, 0]},
    "direction_up": {"gt": [{"supertrend_dir": {}}, 0]},
    "exit_when": {
        "up": {"lt": [{"supertrend_dir": {}}, 0]},
        "down": {"gt": [{"supertrend_dir": {}}, 0]},
    },
    "template": {
        "exit_time": "15:15",
        "legs": [
            {"id": "ce", "lots": 1, "position": "buy", "option_type": "CE",
             "strike": {"premium_pct_of_spot": 1.0}, "on": "up"},
            {"id": "pe", "lots": 1, "position": "buy", "option_type": "PE",
             "strike": {"premium_pct_of_spot": 1.0}, "on": "down"},
        ],
    },
}  # fmt: skip


def test_exit_when_per_side_and_premium_pct_compile_and_read_back():
    rule = from_dict(copy.deepcopy(BUY_TREND))
    assert set(rule.exits) == {"up", "down"} and rule.exit_cap == "15:15"
    strategy = rule.strategy_for("10:01", "up", exit_time="11:42", spot=24165.0)
    assert strategy.exit_time == "11:42" and [leg.id for leg in strategy.legs] == ["ce"]
    assert strategy.legs[0].strike.closest_premium == pytest.approx(241.65)
    assert rule.strategy_for("10:01", "down", spot=20000).exit_time == "15:15"
    back = read_back(rule)
    assert any(s.startswith("On up events, exit the minute after") for s in back["sentences"])
    assert any("premium is nearest 1% of the index" in s for s in back["sentences"])
    assert any("exit by 15:15" in s for s in back["sentences"])


def test_one_exit_applies_to_every_side_and_joins_both_hashes():
    plain = from_dict(spec())
    with_exit = from_dict(spec(exit_when={"lt": ["close", "session_open"]}))
    assert set(with_exit.exits) == {"both"}
    assert with_exit.spec_hash != plain.spec_hash
    assert with_exit.template_hash != plain.template_hash
    assert plain.exits is None


@pytest.mark.parametrize(
    "changes, needle",
    [
        ({"exit_when": {"up": {"gt": ["close", 1]}, "down": {"gt": ["close", 1]}}}, "direction_up"),
        ({"exit_when": "close"}, "true / false"),
    ],
)
def test_exit_when_refusals(changes, needle):
    with pytest.raises(SpecError, match=needle):
        from_dict(spec(**changes))


def test_premium_pct_refusals():
    bad = copy.deepcopy(BUY_TREND)
    bad["template"]["legs"][0]["strike"] = {"premium_pct_of_spot": 0}
    with pytest.raises(SpecError, match="premium_pct_of_spot"):
        from_dict(bad)
    bad["template"]["legs"][0]["strike"] = {"premium_pct_of_spot": 1, "closest_premium": 200}
    with pytest.raises(SpecError, match="alone"):
        from_dict(bad)


def test_an_unquoted_on_key_in_yaml_is_read_as_on():
    text = yaml.safe_dump({"rule": copy.deepcopy(BUY_TREND)}).replace("'on'", "on")
    assert "\n    on: up" in text or "on: up" in text
    rule = load_spec(text)
    assert [leg["on"] for leg in rule.legs] == ["up", "down"]
