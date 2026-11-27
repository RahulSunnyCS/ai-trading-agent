"""BL-247 registered grid: Dir and Widesl on four MCX minis, each setting at a 15:30 entry and the
same setting at 17:05.

Never edit after the SHA is recorded in the item's Log: a change is a new dated rule there.
"""

from __future__ import annotations

import hashlib
import itertools
import json
from datetime import date

from option_backtesting.legwise.schema import LegwiseStrategy

VERSION = "bl247-2026-11-27"
ROOTS = ("CRUDEOILM", "NATGASMINI", "GOLDM", "SILVERM")
ENTRY = "15:30"
BASE_ENTRY = "17:05"
ENTRIES = (ENTRY, BASE_ENTRY)
SLIPPAGE_PCT = 1.0
HALVES = {
    "fit": (date(2024, 11, 1), date(2025, 10, 31)),
    "test": (date(2025, 11, 1), date(2026, 10, 31)),
}
WEEKS = {"expiry": range(0, 5), "before": range(5, 10)}
#: 15 minutes before the day's close (23:30 summer, 23:55 winter), as BL-218
CLOSE_EXITS = {"summer": "23:15", "winter": "23:40"}
#: a sold leg is stale when its contract had no trade in this many minutes before the entry
STALE_MINUTES = 15
#: a cohort with more than this share of stale legs at either entry is not judged
STALE_LIMIT = 0.20
RESAMPLES = 2000
SEED = 20261127

FAMILIES: dict[str, dict] = {
    "dir": {
        "strike": ["ITM1", "ATM"],
        "sl": [15, 21, 30],
        "reentry": ["none", "cost1"],
        "exit": ["22:00", "close"],
    },
    "widesl": {
        "strike": ["OTM1", "OTM2"],
        "sl": [80, 115, 150],
        "trail": ["none", "15/10"],
        "exit": ["22:00", "close"],
    },
}


def pairs(family: str) -> list[dict]:
    axes = FAMILIES[family]
    return [dict(zip(axes, combo, strict=True)) for combo in itertools.product(*axes.values())]


def pair_id(family: str, params: dict) -> str:
    return family + "|" + "|".join(f"{k}={v}" for k, v in params.items())


def build(family: str, params: dict, entry: str, root: str, season: str) -> LegwiseStrategy:
    """One side of a pair, built as BL-218 builds its Dir and Widesl."""

    def leg(side: str) -> dict:
        out: dict = {
            "id": side.lower(),
            "lots": 1,
            "position": "sell",
            "option_type": side,
            "expiry": "weekly",  # the nearest listed expiry: the expiring monthly contract
            "strike": {"strike_type": params["strike"]},
            "stop_loss": {"percent": params["sl"]},
        }
        if family == "dir" and params["reentry"] == "cost1":
            out["reentry_on_sl"] = {"mode": "cost", "count": 1}
        if family == "widesl" and params["trail"] != "none":
            x, y = map(int, params["trail"].split("/"))
            out["trail_sl"] = {"percent": [x, y]}
        return out

    return LegwiseStrategy.model_validate(
        {
            "id": f"bl247:{root}:{entry}:{pair_id(family, params)}",
            "underlying": root,
            "entry_time": entry,
            "exit_time": CLOSE_EXITS[season] if params["exit"] == "close" else params["exit"],
            "square_off": "partial",
            "legs": [leg("CE"), leg("PE")],
            "execution": {"slippage_pct": SLIPPAGE_PCT},
        }
    )


def registered() -> dict:
    return {
        "version": VERSION,
        "roots": ROOTS,
        "entries": ENTRIES,
        "slippage_pct": SLIPPAGE_PCT,
        "halves": {k: [d.isoformat() for d in v] for k, v in HALVES.items()},
        "weeks": {k: list(v) for k, v in WEEKS.items()},
        "close_exits": CLOSE_EXITS,
        "stale_minutes": STALE_MINUTES,
        "stale_limit": STALE_LIMIT,
        "resamples": RESAMPLES,
        "seed": SEED,
        "families": FAMILIES,
    }


def grid_sha() -> str:
    blob = json.dumps(registered(), sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]
