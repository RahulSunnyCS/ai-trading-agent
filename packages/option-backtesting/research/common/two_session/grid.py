"""BL-185 base grid: the cells simulated once, with their MTM paths recorded (exit 15:28, no
overall stop or target; those are overlays). Registered by its SHA in the backlog item."""

from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import dataclass

VERSION = "bl185-stage-a-2026-10-28"
UNDERLYINGS = ("NIFTY", "SENSEX")
INDEX_LETTER = {"NIFTY": "N", "SENSEX": "S"}
STRIKES = ("ITM3", "ITM2", "ITM1", "ATM", "OTM1", "OTM2", "OTM3", "PLOW", "PMID", "PHIGH")
PREMIUM = {
    "NIFTY": {"PLOW": 60.0, "PMID": 100.0, "PHIGH": 150.0},
    "SENSEX": {"PLOW": 200.0, "PMID": 285.0, "PHIGH": 320.0},
}
FAMILY = {"W": "wide", "D": "dir"}
AXES = {
    "W": {
        "strike": STRIKES,
        "leg_sl": (40, 60, 80, 100, 120, 150),
        "trail": (None, (15, 10), (25, 15)),
        "reentry": (None, ("cost", 1)),
    },
    "D": {
        "strike": STRIKES,
        "leg_sl": (10, 15, 20, 25, 30, 40),
        "trail": (None, (10, 5)),
        "reentry": (None, ("cost", 1), ("cost", 2)),
    },
}
#: ±1-step neighbours run along these chains (a premium level is not next to OTM3)
CHAINS = {
    "strike": (("ITM3", "ITM2", "ITM1", "ATM", "OTM1", "OTM2", "OTM3"), ("PLOW", "PMID", "PHIGH")),
}
EXIT = "15:28"


def slots(lo: str, hi: str) -> tuple[str, ...]:
    m0 = int(lo[:2]) * 60 + int(lo[2:])
    m1 = int(hi[:2]) * 60 + int(hi[2:])
    return tuple(f"{m // 60:02d}{m % 60:02d}" for m in range(m0, m1 + 1, 15))


SLOTS_AM = slots("0917", "1147")  # 11
SLOTS_PM = slots("1302", "1502")  # 9
SLOTS = SLOTS_AM + SLOTS_PM
BAND = {**{s: ("A" if int(s[:2]) * 60 + int(s[2:]) <= 602 else "B") for s in SLOTS_AM},
        **{s: ("C" if int(s[:2]) * 60 + int(s[2:]) <= 842 else "D") for s in SLOTS_PM}}  # fmt: skip


@dataclass(frozen=True)
class Cell:
    cohort: str  # W | D
    k: int  # index within the cohort
    strike: str
    leg_sl: int
    trail: tuple[int, int] | None
    reentry: tuple[str, int] | None

    @property
    def cid(self) -> str:
        return f"{self.cohort}{self.k:03d}"

    def name(self, underlying: str, slot: str) -> str:
        return f"{INDEX_LETTER[underlying]}_{FAMILY[self.cohort]}-t2s{self.k:03d}_{slot}"

    def strategy(self, underlying: str, slot: str) -> dict:
        """The legwise strategy mapping (validated by `LegwiseStrategy.model_validate`)."""
        strike = (
            {"closest_premium": PREMIUM[underlying][self.strike]}
            if self.strike in PREMIUM[underlying]
            else {"strike_type": self.strike}
        )
        leg = {
            "lots": 1, "position": "sell", "expiry": "weekly", "strike": strike,
            "stop_loss": {"percent": float(self.leg_sl)},
        }  # fmt: skip
        if self.trail:
            leg["trail_sl"] = {"percent": [float(self.trail[0]), float(self.trail[1])]}
        if self.reentry:
            leg["reentry_on_sl"] = {"mode": self.reentry[0], "count": self.reentry[1]}
        return {
            "id": self.name(underlying, slot),
            "underlying": underlying,
            "entry_time": f"{slot[:2]}:{slot[2:]}",
            "exit_time": EXIT,
            "square_off": "partial",
            "legs": [
                {"id": "ce", "option_type": "CE", **leg},
                {"id": "pe", "option_type": "PE", **leg},
            ],
            "overall": {},
            "execution": {"slippage_pct": 0.0, "cost_per_order_inr": 0.0, "lot_sizing": "current"},
        }


def cells(cohort: str) -> list[Cell]:
    ax = AXES[cohort]
    out = []
    for k, (st, sl, tr, re) in enumerate(
        itertools.product(ax["strike"], ax["leg_sl"], ax["trail"], ax["reentry"])
    ):
        out.append(Cell(cohort, k, st, sl, tr, re))
    return out


def by_cid() -> dict[str, Cell]:
    return {c.cid: c for co in AXES for c in cells(co)}


def parts() -> list[tuple[str, str, str]]:
    """(underlying, cohort, slot): one simulation part each, 360 variants."""
    return [(u, co, s) for u in UNDERLYINGS for co in AXES for s in SLOTS]


def sha() -> str:
    doc = {
        "version": VERSION,
        "premium": PREMIUM,
        "axes": {
            co: {
                k: [list(v) if isinstance(v, tuple) else v for v in vals] for k, vals in ax.items()
            }
            for co, ax in AXES.items()
        },
        "slots": SLOTS,
        "exit": EXIT,
        "cells": {co: len(cells(co)) for co in AXES},
    }
    return hashlib.sha256(json.dumps(doc, sort_keys=True, default=str).encode()).hexdigest()[:16]


if __name__ == "__main__":
    n = sum(len(cells(co)) for co in AXES)
    print(
        f"{VERSION}: cells per index {n} x {len(SLOTS)} slots = {n * len(SLOTS)} variants per index; sha {sha()}"
    )
