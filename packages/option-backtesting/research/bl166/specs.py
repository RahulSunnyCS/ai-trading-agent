"""BL-166: the one registered rule (backlog/BL-166, Phase 0): higher-high / higher-low structure on
5-minute NIFTY bars, buy the weekly ATM on the first 1-minute close through the latest swing, exit on
a close back through the latest opposite swing, -30% backstop, 15:15.

    uv run python research/bl166/specs.py            # validate and read back; runs nothing
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SWING = {"minutes": 5, "n": 2}
DEFINE = {
    "sh0": {"swing": {"kind": "high", "back": 0, **SWING}},
    "sh1": {"swing": {"kind": "high", "back": 1, **SWING}},
    "sl0": {"swing": {"kind": "low", "back": 0, **SWING}},
    "sl1": {"swing": {"kind": "low", "back": 1, **SWING}},
    "structure_up": {"all": [{"gt": ["sh0", "sh1"]}, {"gt": ["sl0", "sl1"]}]},
    "structure_down": {"all": [{"lt": ["sh0", "sh1"]}, {"lt": ["sl0", "sl1"]}]},
    "break_up": {"all": ["structure_up", {"gt": ["close", "sh0"]}]},
    "break_down": {"all": ["structure_down", {"lt": ["close", "sl0"]}]},
}
LEG = {"lots": 1, "position": "buy", "expiry": "weekly", "strike": {"strike_type": "ATM"},
       "stop_loss": {"percent": 30}}  # fmt: skip
RULE = {
    "id": "bl166_s1_hh_hl_break",
    "name": "BL-166 S1 HH/HL structure, break of the last swing",
    "underlying": "NIFTY",
    "window": {"from": "09:40", "to": "14:00"},
    "define": DEFINE,
    "when": {"any": ["break_up", "break_down"]},
    "direction_up": "break_up",
    "exit_when": {"up": {"lt": ["close", "sl0"]}, "down": {"gt": ["close", "sh0"]}},
    "template": {
        "exit_time": "15:15",
        "legs": [
            {"id": "ce", "option_type": "CE", **LEG, "on": "up"},
            {"id": "pe", "option_type": "PE", **LEG, "on": "down"},
        ],
    },
    "notes": "BL-166, registered in the backlog item",
}


def main() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from option_backtesting.ruletest.spec import from_dict, read_back

    compiled = from_dict(RULE)
    print(f"== {RULE['id']}  {compiled.spec_hash[:12]}")
    print("\n".join(read_back(compiled)["sentences"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
