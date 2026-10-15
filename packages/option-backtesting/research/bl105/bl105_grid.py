"""BL-105 Phase 1 registered grid: the Dir bases and the management variants (lock / trail, restart).

Values are the owner-approved Phase 0 of backlog/BL-105. Roll (B, B') is Phase 2 and is listed
only so the registration is whole; this screen does not run it.

Imports only the package and stdlib so a test can load this file by path.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from option_backtesting.legwise.schema import LegwiseStrategy, Strike, TrailSL, load_legwise

PACKAGE = Path(__file__).resolve().parents[2]
ROTATION = PACKAGE / "strategies" / "rotation"
VERSION = "bl105-phase1-2026-10-15"
INDICES = {"N": "NIFTY", "S": "SENSEX"}
SLOTS = ("09:17", "09:32", "09:47", "10:17", "11:32", "13:02", "14:32")
STRIKES = ("ATM", "ITM1", "ITM2")
TRAILS = (None, (10, 5))  # leg trail, percent [X, Y]
LEVELS = (2000, 3000, 4000)  # A1 target T, A2 / A3 arm A (rupees, one lot)
RESTART_LEVELS = (2000, 3000, 4000)  # after an A1 target
RESTART_LOCK_LEVELS = (3000, 4000)  # after an A2 lock cut
RESTARTS = (1, 2)
RESTART_NOT_AFTER = "14:00"
ROLL_REGISTERED = {  # Phase 2, not run here
    "decay": (0.15, 0.25, 0.35, 0.45, 0.50, 0.70),
    "profit_gate": (None, 3000),
    "fresh_stop_pct": (21, 30),
    "roll_to_atm_bases": ("ITM1", "ITM2"),
    "no_roll_after": "13:30",
}


def band(slot: str) -> str:
    h, m = slot.split(":")
    minute = int(h) * 60 + int(m)
    return "A" if minute <= 602 else "B" if minute <= 722 else "C" if minute <= 842 else "D"


def base_id(strike: str, trail: tuple[int, int] | None) -> str:
    return f"{strike}_" + ("t10-5" if trail else "notrail")


def build_base(
    index: str, slot: str, strike: str, trail: tuple[int, int] | None
) -> LegwiseStrategy:
    """The unmanaged base: the rotation's Dir file at `slot` with the strike and leg trail set."""
    path = ROTATION / f"{index}_dir_{slot.replace(':', '')}.yaml"
    strategy = load_legwise(path).model_copy(deep=True)
    strategy.id = f"bl105_{index}_{slot.replace(':', '')}_{base_id(strike, trail)}"
    for leg in strategy.legs:
        leg.strike = Strike(strike_type=strike)
        leg.trail_sl = None if trail is None else TrailSL(percent=trail)
    return LegwiseStrategy.model_validate(strategy.model_dump())


@dataclass(frozen=True)
class Variant:
    id: str
    idea: str  # base | A1 | A2 | A3 | C1 | C2
    kind: str  # base | target | lock | locktrail | restart_target | restart_lock
    level: int | None = None
    restarts: int = 0


def variants() -> list[Variant]:
    out = [Variant("base", "base", "base")]
    out += [Variant(f"A1_T{t}", "A1", "target", t) for t in LEVELS]
    out += [Variant(f"A2_A{a}", "A2", "lock", a) for a in LEVELS]
    out += [Variant(f"A3_A{a}", "A3", "locktrail", a) for a in LEVELS]
    out += [
        Variant(f"C1_T{t}_R{r}", "C1", "restart_target", t, r)
        for t in RESTART_LEVELS
        for r in RESTARTS
    ]
    out += [
        Variant(f"C2_A{a}_R{r}", "C2", "restart_lock", a, r)
        for a in RESTART_LOCK_LEVELS
        for r in RESTARTS
    ]
    return out


def registered() -> dict:
    return {
        "version": VERSION,
        "indices": INDICES,
        "slots": SLOTS,
        "strikes": STRIKES,
        "trails": TRAILS,
        "variants": [v.__dict__ for v in variants()],
        "restart_not_after": RESTART_NOT_AFTER,
        "roll": ROLL_REGISTERED,
    }


def grid_sha() -> str:
    return hashlib.sha256(
        json.dumps(registered(), sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


if __name__ == "__main__":
    v = variants()
    print(len(v), "variants per base;", len(STRIKES) * len(TRAILS), "bases per index x slot;")
    print("cells:", len(v) * len(STRIKES) * len(TRAILS) * len(SLOTS) * len(INDICES))
    print("sha", grid_sha())
