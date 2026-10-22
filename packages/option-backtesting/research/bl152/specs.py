"""BL-152: the 192 rule specs of the registered grid (backlog/BL-152, Phase 0; criteria.json).

level x stop x trade x exit = 4 x 4 x 3 x 4. The up side is written out; the down side mirrors it
(lows, `<`, PE for CE). Every spec is a BL-120 rule (`ruletest/spec.py`), so it is validated, read
back and tested by the tester itself:

    uv run python research/bl152/specs.py            # write out/specs/<id>.yaml and check all 192
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
CRITERIA = json.loads((HERE / "criteria.json").read_text())
AXES = CRITERIA["axes"]
SET = CRITERIA["settings"]
RULE = CRITERIA["rule"]

FIVE = {"bar_close": RULE["breakout_candle_minutes"]}
OPEN5 = {"lag": {"x": "open", "n": 4}}
HIGH5 = {"roll_max": {"x": "high", "n": 5}}
LOW5 = {"roll_min": {"x": "low", "n": 5}}
ENTRY = {"at_entry": "close"}
ST = {"supertrend_dir": SET["trail_supertrend"]}


def _cum(op: str, src: str, lag: int) -> dict:
    return {"lag": {"x": {op: {"x": src}}, "n": lag}}


def levels() -> dict[str, dict]:
    """{level id: {up, dn, extra_up, extra_dn}}: the level before the breakout candle, and any extra
    condition on the candle (the held-high check)."""
    held = SET["held30_minutes"]
    roll = SET["roll30_minutes"]
    return {
        "or30": {
            "up": {"at": {"x": {"cum_max": {"x": "high"}}, "clock": SET["or30_until"]}},
            "dn": {"at": {"x": {"cum_min": {"x": "low"}}, "clock": SET["or30_until"]}},
        },
        "roll30": {
            "up": {"lag": {"x": {"roll_max": {"x": "high", "n": roll}}, "n": 5}},
            "dn": {"lag": {"x": {"roll_min": {"x": "low", "n": roll}}, "n": 5}},
        },
        "held30": {
            "up": _cum("cum_max", "high", 5),
            "dn": _cum("cum_min", "low", 5),
            "extra_up": {"le": ["lvl_up", _cum("cum_max", "high", 5 + held)]},
            "extra_dn": {"ge": ["lvl_dn", _cum("cum_min", "low", 5 + held)]},
        },
        "prevday": {"up": "prev_high", "dn": "prev_low"},
    }


def define(level: str) -> dict:
    lv = levels()[level]
    share = RULE["body_share_beyond_level_min"]
    by = {"le": ["minute", {"clock": RULE["breakout_candle_close_by"]}]}
    bo_up = [
        FIVE,
        {"gt": ["close", "lvl_up"]},
        {"lt": [OPEN5, "lvl_up"]},
        {"ge": [{"div": [{"sub": ["close", "lvl_up"]}, {"sub": ["close", OPEN5]}]}, share]},
        by,
    ]
    bo_dn = [
        FIVE,
        {"lt": ["close", "lvl_dn"]},
        {"gt": [OPEN5, "lvl_dn"]},
        {"ge": [{"div": [{"sub": ["lvl_dn", "close"]}, {"sub": [OPEN5, "close"]}]}, share]},
        by,
    ]
    if "extra_up" in lv:
        bo_up.append(lv["extra_up"])
        bo_dn.append(lv["extra_dn"])
    return {
        "lvl_up": lv["up"],
        "lvl_dn": lv["dn"],
        "bo_up": {"all": bo_up},
        "bo_dn": {"all": bo_dn},
        # frozen at the breakout candle, held for the rest of the day
        "level_up": {"at_first": {"x": "lvl_up", "when": "bo_up"}},
        "level_dn": {"at_first": {"x": "lvl_dn", "when": "bo_dn"}},
        "bo_high_up": {"at_first": {"x": HIGH5, "when": "bo_up"}},
        "bo_low_up": {"at_first": {"x": LOW5, "when": "bo_up"}},
        "bo_high_dn": {"at_first": {"x": HIGH5, "when": "bo_dn"}},
        "bo_low_dn": {"at_first": {"x": LOW5, "when": "bo_dn"}},
        "hold_up": {"ge": [{"min_since_first": {"x": "close", "when": "bo_up"}}, "level_up"]},
        "hold_dn": {"le": [{"max_since_first": {"x": "close", "when": "bo_dn"}}, "level_dn"]},
        "entry_up": {"all": ["hold_up", {"gt": ["close", "bo_high_up"]}]},
        "entry_dn": {"all": ["hold_dn", {"lt": ["close", "bo_low_dn"]}]},
    }


def stop_conditions(stop: str) -> tuple[dict | None, dict | None, dict | None, dict | None]:
    """(up exit, down exit, up stop level, down stop level) for an index stop; Nones for prem30."""
    atr = {"mul": [SET["atr03_multiple"], "atr14"]}
    if stop == "lvl":
        up_lvl, dn_lvl = "level_up", "level_dn"
    elif stop == "cndl":
        up_lvl, dn_lvl = "bo_low_up", "bo_high_dn"
    elif stop == "atr03":
        up_lvl, dn_lvl = {"sub": [ENTRY, atr]}, {"add": [ENTRY, atr]}
    else:
        return None, None, None, None
    return {"lt": ["close", up_lvl]}, {"gt": ["close", dn_lvl]}, up_lvl, dn_lvl


def exit_conditions(stop: str, exit_: str) -> tuple[dict | None, dict | None]:
    k = SET["tgt2r_multiple"]
    if exit_ == "trail":
        return {"lt": [ST, 0]}, {"gt": [ST, 0]}
    if exit_ == "t60":
        held = {"ge": ["minutes_in_trade", SET["t60_minutes"]]}
        return held, held
    if exit_ == "tgt2r" and stop != "prem30":
        _u, _d, up_lvl, dn_lvl = stop_conditions(stop)
        up = {"ge": ["close", {"add": [ENTRY, {"mul": [k, {"sub": [ENTRY, up_lvl]}]}]}]}
        dn = {"le": ["close", {"sub": [ENTRY, {"mul": [k, {"sub": [dn_lvl, ENTRY]}]}]}]}
        return up, dn
    return None, None  # eod; tgt2r with prem30 is the leg's own target


def legs(trade: str, stop: str, exit_: str) -> list[dict]:
    strike = (
        {"premium_pct_of_spot": SET["pct1_premium_pct_of_spot"]}
        if trade == "pct1"
        else {"strike_type": "ATM"}
    )
    if trade == "sellopp":
        sides = [("pe", "sell", "PE", "up"), ("ce", "sell", "CE", "down")]
    else:
        sides = [("ce", "buy", "CE", "up"), ("pe", "buy", "PE", "down")]
    out = []
    for leg_id, position, option_type, on in sides:
        leg = {
            "id": leg_id,
            "lots": SET["lots"],
            "position": position,
            "option_type": option_type,
            "strike": dict(strike),
            "on": on,
        }
        if stop == "prem30":
            leg["stop_loss"] = {"percent": SET["prem30_percent"]}
            if exit_ == "tgt2r":
                leg["target"] = {"percent": SET["tgt2r_premium_percent_with_prem30"]}
        out.append(leg)
    return out


def _either(parts: list[dict | None]) -> dict | None:
    kept = [p for p in parts if p is not None]
    if not kept:
        return None
    return kept[0] if len(kept) == 1 else {"any": kept}


def spec(level: str, stop: str, trade: str, exit_: str) -> dict:
    vid = f"bl152_{level}_{stop}_{trade}_{exit_}"
    stop_up, stop_dn, _ul, _dl = stop_conditions(stop)
    exit_up, exit_dn = exit_conditions(stop, exit_)
    rule = {
        "id": vid,
        "name": f"BL-152 {level} / {stop} / {trade} / {exit_}",
        "underlying": CRITERIA["underlying"],
        "window": {"from": RULE["window"][0], "to": RULE["window"][1]},
        "define": define(level),
        "when": {"any": ["entry_up", "entry_dn"]},
        "direction_up": "entry_up",
        "control_when": {
            "up": {"ge": ["close", "level_up"]},
            "down": {"le": ["close", "level_dn"]},
        },
        "template": {"exit_time": RULE["exit_time"], "legs": legs(trade, stop, exit_)},
        "notes": "BL-152 registered grid (research/bl152/criteria.json)",
    }
    up, dn = _either([stop_up, exit_up]), _either([stop_dn, exit_dn])
    if up is not None:
        rule["exit_when"] = {"up": up, "down": dn}
    return rule


def grid() -> list[tuple[str, dict]]:
    out = []
    for level, stop, trade, exit_ in itertools.product(
        AXES["level"], AXES["stop"], AXES["trade"], AXES["exit"]
    ):
        rule = spec(level, stop, trade, exit_)
        out.append((rule["id"], rule))
    assert len(out) == CRITERIA["n_variants"]
    return out


def main() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from option_backtesting.ruletest.spec import from_dict, read_back

    folder = HERE / "out" / "specs"
    folder.mkdir(parents=True, exist_ok=True)
    hashes = set()
    for vid, rule in grid():
        compiled = from_dict(rule)
        hashes.add(compiled.spec_hash)
        (folder / f"{vid}.yaml").write_text(yaml.safe_dump({"rule": rule}, sort_keys=False))
    assert len(hashes) == len(grid()), "two variants compiled to the same rule"
    print(f"{len(hashes)} specs written to {folder}")
    print("\n".join(read_back(from_dict(grid()[0][1]))["sentences"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
