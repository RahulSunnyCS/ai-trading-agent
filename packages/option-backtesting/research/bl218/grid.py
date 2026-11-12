"""BL-218 registered grid: Dir, Widesl (evening) and Buy — range breakout and timed — (morning
and evening) on four MCX minis, run over the 10 sessions before each option expiry.

Never edit after the SHA is recorded in the item's Log: a change is a new dated rule there.
"""

from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import dataclass
from datetime import date

from option_backtesting.legwise.schema import LegwiseStrategy

VERSION = "bl218-2026-11-11"
ROOTS = ("CRUDEOILM", "NATGASMINI", "GOLDM", "SILVERM")
SLIPPAGE_PCT = 1.0
#: option expiries in each half (the sessions E-9..E0 of every expiry inside)
FIT = (date(2024, 11, 1), date(2025, 10, 31))
TEST = (date(2025, 11, 1), date(2026, 10, 31))
#: sessions counted back from expiry day (E0): expiry week E-4..E0, the week before E-9..E-5
WEEKS = {"expiry": range(0, 5), "before": range(5, 10)}

MORNING_EXIT = "16:55"
#: evening exit: 15 minutes before the day's close (23:30 summer -> 23:15, 23:55 winter -> 23:40)
EVENING_EXITS = {"summer": "23:15", "winter": "23:40"}

#: family -> session, ordered axes {name: values}. Order inside each list is the plateau chain.
FAMILIES: dict[str, dict] = {
    "dir": {
        "session": "evening",
        "axes": {
            "entry": ["17:05", "18:00", "19:00", "20:00"],
            "strike": ["ITM1", "ATM"],
            "sl": [15, 21, 30],
            "reentry": ["none", "cost1"],
            "exit": ["22:00", "close"],
        },
    },
    "widesl": {
        "session": "evening",
        "axes": {
            "entry": ["17:05", "18:00", "19:00", "20:00"],
            "strike": ["OTM1", "OTM2"],
            "sl": [80, 115, 150],
            "trail": ["none", "15/10"],
            "exit": ["22:00", "close"],
        },
    },
    "rb_m": {
        "session": "morning",
        "axes": {
            "strike": ["ATM", "OTM1"],
            "start": ["09:15", "10:30", "12:00"],
            "range": [10, 15, 30],
            "source": ["instrument", "underlying"],
            "sl": [25, 40],
            "target": ["none", 100],
            "trail": ["none", "20/10"],
        },
    },
    "rb_e": {
        "session": "evening",
        "axes": {
            "strike": ["ATM", "OTM1"],
            "start": ["17:00", "18:30", "20:00"],
            "range": [10, 15, 30],
            "source": ["instrument", "underlying"],
            "sl": [25, 40],
            "target": ["none", 100],
            "trail": ["none", "20/10"],
        },
    },
    "tb_m": {
        "session": "morning",
        "axes": {
            "entry": ["09:15", "09:45", "10:15", "10:45", "11:15", "11:45", "12:15", "12:45"],
            "strike": ["ATM", "OTM1"],
            "legs": ["both", "ce", "pe"],
            "sl": [25, 40],
            "target": ["none", 50, 100],
        },
    },
    "tb_e": {
        "session": "evening",
        "axes": {
            "entry": [
                "17:00",
                "17:30",
                "18:00",
                "18:30",
                "19:00",
                "19:30",
                "20:00",
                "20:30",
                "21:00",
            ],  # fmt: skip
            "strike": ["ATM", "OTM1"],
            "legs": ["both", "ce", "pe"],
            "sl": [25, 40],
            "target": ["none", 50, 100],
        },
    },
}


@dataclass(frozen=True)
class Cell:
    family: str
    params: tuple[tuple[str, object], ...]

    @property
    def p(self) -> dict:
        return dict(self.params)

    @property
    def id(self) -> str:
        return self.family + "|" + "|".join(f"{k}={v}" for k, v in self.params)


def cells(family: str) -> list[Cell]:
    axes = FAMILIES[family]["axes"]
    names = list(axes)
    return [
        Cell(family, tuple(zip(names, combo, strict=True)))
        for combo in itertools.product(*(axes[n] for n in names))
    ]


def all_cells() -> list[Cell]:
    return [c for f in FAMILIES for c in cells(f)]


def neighbours(cell: Cell) -> list[Cell]:
    """Cells one step away along one axis (the plateau rule's neighbourhood)."""
    axes = FAMILIES[cell.family]["axes"]
    out = []
    p = cell.p
    for name, values in axes.items():
        i = values.index(p[name])
        for j in (i - 1, i + 1):
            if 0 <= j < len(values):
                q = dict(p)
                q[name] = values[j]
                out.append(Cell(cell.family, tuple(q.items())))
    return out


def _hm(hhmm: str, minutes: int) -> str:
    h, m = map(int, hhmm.split(":"))
    t = h * 60 + m + minutes
    return f"{t // 60:02d}:{t % 60:02d}"


def _trail(value: str) -> dict:
    if value == "none":
        return {}
    x, y = map(int, value.split("/"))
    return {"trail_sl": {"percent": [x, y]}}


def build(cell: Cell, root: str, season: str) -> LegwiseStrategy:
    """The strategy for one cell on one root; `season` picks the evening exit (summer/winter)."""
    p = cell.p
    session = FAMILIES[cell.family]["session"]
    close_exit = EVENING_EXITS[season] if session == "evening" else MORNING_EXIT

    def leg(side: str, position: str, **extra) -> dict:
        return {
            "id": side.lower(),
            "lots": 1,
            "position": position,
            "option_type": side,
            "expiry": "weekly",  # the nearest listed expiry: the expiring monthly contract
            "strike": {"strike_type": p["strike"]},
            **extra,
        }

    if cell.family in ("dir", "widesl"):
        extra: dict = {"stop_loss": {"percent": p["sl"]}}
        if cell.family == "dir" and p["reentry"] == "cost1":
            extra["reentry_on_sl"] = {"mode": "cost", "count": 1}
        if cell.family == "widesl":
            extra |= _trail(p["trail"])
        legs = [leg("CE", "sell", **extra), leg("PE", "sell", **extra)]
        entry = p["entry"]
        exit_time = close_exit if p["exit"] == "close" else p["exit"]
    elif cell.family in ("rb_m", "rb_e"):
        entry = p["start"]
        until = _hm(entry, p["range"])
        exit_time = close_exit

        def rb(side: str) -> dict:
            breakout = {
                "until": until,
                "side": "low" if (p["source"] == "underlying" and side == "PE") else "high",
                "source": p["source"],
            }
            extra = {"stop_loss": {"percent": p["sl"]}, "range_breakout": breakout}
            if p["target"] != "none":
                extra["target"] = {"percent": p["target"]}
            return leg(side, "buy", **extra | _trail(p["trail"]))

        legs = [rb("CE"), rb("PE")]
    else:  # timed buy
        entry = p["entry"]
        exit_time = close_exit
        extra = {"stop_loss": {"percent": p["sl"]}}
        if p["target"] != "none":
            extra["target"] = {"percent": p["target"]}
        sides = {"both": ("CE", "PE"), "ce": ("CE",), "pe": ("PE",)}[p["legs"]]
        legs = [leg(s, "buy", **extra) for s in sides]
    return LegwiseStrategy.model_validate(
        {
            "id": f"bl218:{root}:{cell.id}",
            "underlying": root,
            "entry_time": entry,
            "exit_time": exit_time,
            "square_off": "partial",
            "legs": legs,
            "execution": {"slippage_pct": SLIPPAGE_PCT},
        }
    )


def registered() -> dict:
    return {
        "version": VERSION,
        "roots": ROOTS,
        "slippage_pct": SLIPPAGE_PCT,
        "fit": [d.isoformat() for d in FIT],
        "test": [d.isoformat() for d in TEST],
        "weeks": {k: list(v) for k, v in WEEKS.items()},
        "morning_exit": MORNING_EXIT,
        "evening_exits": EVENING_EXITS,
        "families": FAMILIES,
    }


def grid_sha() -> str:
    blob = json.dumps(registered(), sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]
