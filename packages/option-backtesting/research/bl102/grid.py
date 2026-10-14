"""BL-102 Stage-1 grid: the registered axes, the cells they make, and the strategy each cell is.

Three families, each a full Cartesian product over its axes (the owner's "every parameter"),
at seven entry slots per index. The values here are the pre-registration: `grid_sha()` is
recorded in the backlog item's Phase 0 and the unit test holds the counts, so a later edit shows.

    W  short strangle / straddle with wide stops (the Widesl family, ATM included as a strike)
    D  tight-stop straddle (the Dir family; ATM and ITM1 are its rotation files)
    B  long range-breakout (the Buy family)

Every cell starts from the rotation file of its (index, family, slot) — `strategies/rotation/
<N|S>_<wide|dir|buy>_<HHMM>.yaml` — and overrides the axes symmetrically on both legs. The
"template" cell of a cohort is that file loaded AS-IS (SENSEX Widesl keeps CE 114 / PE 115), the
regression anchor against the BL-096/097/098 results.

Imports only the package and stdlib so a test can load this file by path.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from option_backtesting.legwise.schema import (
    Amount,
    Execution,
    LegwiseStrategy,
    RangeBreakout,
    ReEntry,
    Strike,
    TrailSL,
    load_legwise,
)

PACKAGE = Path(__file__).resolve().parents[2]
ROTATION = PACKAGE / "strategies" / "rotation"

GRID_VERSION = "bl102-stage1-2026-10-14"
FAMILIES = ("W", "D", "B")
FAMILY_FILE = {"W": "wide", "D": "dir", "B": "buy"}
FAMILY_NAME = {"W": "Widesl", "D": "Dir", "B": "Buy"}
INDICES = {"N": "NIFTY", "S": "SENSEX"}
SLOTS = ("09:17", "09:32", "09:47", "10:17", "11:32", "13:02", "14:32")
TEMPLATE = "template"


def band(slot: str) -> str:
    """Start band, the rotation's rule (`rotation.score.family_index`): A <= 10:02,
    B <= 12:02, C <= 14:02, D after."""
    h, m = slot.split(":")
    minute = int(h) * 60 + int(m)
    return "A" if minute <= 602 else "B" if minute <= 722 else "C" if minute <= 842 else "D"


# Closest-premium levels, per family and index (SENSEX ~3x NIFTY, the rotation's own ratio).
PREMIUM: dict[str, dict[str, dict[str, float]]] = {
    "W": {"NIFTY": {"PLOW": 60, "PHIGH": 100}, "SENSEX": {"PLOW": 200, "PHIGH": 320}},
    "B": {
        "NIFTY": {"PLOW": 30, "PMID": 50, "PHIGH": 75},
        "SENSEX": {"PLOW": 90, "PMID": 150, "PHIGH": 225},
    },
}
# Point trails are in premium rupees, so SENSEX's are scaled like its premiums.
POINT_SCALE = {"NIFTY": 1.0, "SENSEX": 3.0}

# Axis values in their registered order. The order is also the neighbour order for the
# plateau rule (score.py): two cells are neighbours when they differ in exactly one axis by one
# step along a CHAIN of that axis. Chains keep nonsense neighbours apart (OTM3 is not next to a
# premium level; RE ASAP is not next to RE COST x2).
AXES: dict[str, dict[str, tuple[Any, ...]]] = {
    "W": {
        "strike": ("ATM", "OTM1", "OTM2", "OTM3", "PLOW", "PHIGH"),
        "sl": (40, 60, 80, 100, 120, 150),
        "trail": (None, (15, 10), (25, 15)),
        "mtm": (None, 2000, 3000, 4000),
        "exit": ("15:10", "15:28"),
        "reentry": (None, ("cost", 1, None)),
    },
    "D": {
        "strike": ("ITM2", "ITM1", "ATM", "OTM1"),
        "sl": (10, 15, 20, 25, 30, 40),
        "mtm": (None, 2000, 3000, 4000),
        "reentry": (
            None,
            ("cost", 1, None),
            ("cost", 1, "13:00"),
            ("cost", 2, None),
            ("cost", 2, "13:00"),
            ("asap", 1, None),
            ("asap", 1, "13:00"),
        ),
        "trail": (None, (10, 5)),
    },
    "B": {
        "strike": ("ATM", "OTM1", "PLOW", "PMID", "PHIGH"),
        "range": (10, 15, 30),
        "source": ("instrument", "underlying"),
        "sl": (20, 30, 40),
        "target": (None, 50, 100),
        "trail": (None, (1, 1), (3, 1)),
        "mtm": (1000, 2000),
    },
}

CHAINS: dict[str, dict[str, tuple[tuple[Any, ...], ...]]] = {
    "W": {
        "strike": (("ATM", "OTM1", "OTM2", "OTM3"), ("PLOW", "PHIGH")),
        "sl": (AXES["W"]["sl"],),
        "trail": (AXES["W"]["trail"],),
        "mtm": (AXES["W"]["mtm"],),
        "exit": (AXES["W"]["exit"],),
        "reentry": (AXES["W"]["reentry"],),
    },
    "D": {
        "strike": (AXES["D"]["strike"],),
        "sl": (AXES["D"]["sl"],),
        "mtm": (AXES["D"]["mtm"],),
        "reentry": (
            (None, ("cost", 1, None), ("cost", 2, None)),
            (("cost", 1, None), ("cost", 1, "13:00")),
            (("cost", 2, None), ("cost", 2, "13:00")),
            (None, ("asap", 1, None)),
            (("asap", 1, None), ("asap", 1, "13:00")),
        ),
        "trail": (AXES["D"]["trail"],),
    },
    "B": {
        "strike": (("ATM", "OTM1"), ("PLOW", "PMID", "PHIGH")),
        "range": (AXES["B"]["range"],),
        "source": (AXES["B"]["source"],),
        "sl": (AXES["B"]["sl"],),
        "target": (AXES["B"]["target"],),
        "trail": (AXES["B"]["trail"],),
        "mtm": (AXES["B"]["mtm"],),
    },
}


@dataclass(frozen=True)
class Cell:
    family: str
    index: str  # "N" | "S"
    slot: str
    params: dict[str, Any] | None  # None = the template cell (the rotation file as-is)

    @property
    def underlying(self) -> str:
        return INDICES[self.index]

    @property
    def cohort(self) -> str:
        return f"{self.family}_{self.index}_{self.slot.replace(':', '')}"

    @property
    def label(self) -> str:
        if self.params is None:
            return f"{self.cohort}_{TEMPLATE}"
        return f"{self.cohort}_" + "_".join(
            f"{axis}{token(value)}" for axis, value in self.params.items()
        )

    @property
    def is_template(self) -> bool:
        return self.params is None


def pretty(axis: str, value: Any) -> str:
    """How a value reads in a table: `cost×1@13:00`, `[15,10]`, `none`."""
    if value is None:
        return "none"
    if axis == "reentry":
        mode, count, cutoff = value
        return f"{mode}×{count}" + (f"@{cutoff}" if cutoff else "")
    if isinstance(value, tuple):
        return "[" + ",".join(f"{v:g}" for v in value) + "]"
    return str(value)


def token(value: Any) -> str:
    if value is None:
        return "none"
    if isinstance(value, tuple):
        return "-".join(token(v) for v in value)
    return str(value).replace(":", "")


def excluded(family: str, slot: str, params: dict[str, Any]) -> str | None:
    """Why a Cartesian combination is left out of the grid, or None if it is a cell.

    D re-entry cutoffs at or before the entry slot: the engine cannot re-enter once the cutoff is
    before the entry, so the cell is byte-for-byte the no-re-entry cell — a duplicate trial."""
    if family == "D":
        reentry = params["reentry"]
        if reentry is not None and reentry[2] is not None and reentry[2] <= slot:
            return "cutoff before entry: duplicate of the no-re-entry cell"
    return None


def cartesian(family: str) -> list[dict[str, Any]]:
    axes = AXES[family]
    combos: list[dict[str, Any]] = [{}]
    for axis, values in axes.items():
        combos = [{**c, axis: v} for c in combos for v in values]
    return combos


def cells(family: str, index: str, slot: str, *, with_template: bool = True) -> list[Cell]:
    out = [Cell(family, index, slot, None)] if with_template else []
    out += [
        Cell(family, index, slot, params)
        for params in cartesian(family)
        if excluded(family, slot, params) is None
    ]
    return out


def all_cells(families: tuple[str, ...] = FAMILIES) -> list[Cell]:
    return [
        cell
        for family in families
        for index in INDICES
        for slot in SLOTS
        for cell in cells(family, index, slot)
    ]


def template_path(family: str, index: str, slot: str) -> Path:
    return ROTATION / f"{index}_{FAMILY_FILE[family]}_{slot.replace(':', '')}.yaml"


def load_template(family: str, index: str, slot: str) -> LegwiseStrategy:
    return load_legwise(template_path(family, index, slot))


def hhmm_plus(value: str, minutes: int) -> str:
    return (datetime.strptime(value, "%H:%M") + timedelta(minutes=minutes)).strftime("%H:%M")


def valid_until_for(until: str, exit_time: str, minutes: int | None) -> str | None:
    """Buy `valid_until` = range end + minutes, clamped to the exit (Phase 2); None when there is
    nothing to clamp to (the clamp would equal the range end, i.e. no window at all)."""
    if minutes is None:
        return None
    value = min(hhmm_plus(until, minutes), exit_time)
    return value if value > until else None


def strike_for(family: str, underlying: str, value: str) -> Strike:
    if value in PREMIUM.get(family, {}).get(underlying, {}):
        return Strike(closest_premium=PREMIUM[family][underlying][value])
    return Strike(strike_type=value)


def build(
    cell: Cell,
    template: LegwiseStrategy | None = None,
    *,
    execution: Execution | None = None,
) -> LegwiseStrategy:
    """The validated strategy a cell describes. `template` is the cohort's rotation file (loaded
    once per cohort by the runner); `execution` overrides slippage / lot sizing for Stage 3."""
    base = template or load_template(cell.family, cell.index, cell.slot)
    strategy = base.model_copy(deep=True)
    strategy.id = cell.label
    if execution is not None:
        strategy.execution = execution
    p = cell.params
    if p is None:
        return LegwiseStrategy.model_validate(strategy.model_dump())
    underlying = cell.underlying
    scale = POINT_SCALE[underlying]
    # Stage-2 extras (off-grid controls, backlog/BL-102 Phase 2): exit for D and B,
    # square_off, Buy gap_percent and valid_until (minutes after the range end).
    if "exit" in p:
        strategy.exit_time = p["exit"]
    if "square_off" in p:
        strategy.square_off = p["square_off"]
    if cell.family in ("W", "D"):
        reentry = p["reentry"]
        strategy.no_reentry_after = None
        for leg in strategy.legs:
            leg.strike = strike_for(cell.family, underlying, p["strike"])
            leg.stop_loss = Amount(percent=p["sl"])
            leg.trail_sl = None if p["trail"] is None else TrailSL(percent=p["trail"])
            leg.reentry_on_sl = (
                None if reentry is None else ReEntry(mode=reentry[0], count=reentry[1])
            )
        if reentry is not None and reentry[2] is not None:
            strategy.no_reentry_after = reentry[2]
        strategy.overall.stop_loss_inr = p["mtm"]
    elif cell.family == "B":
        until = hhmm_plus(strategy.entry_time, p["range"])
        for leg in strategy.legs:
            leg.strike = strike_for("B", underlying, p["strike"])
            leg.stop_loss = Amount(percent=p["sl"])
            leg.target = None if p["target"] is None else Amount(percent=p["target"])
            leg.trail_sl = (
                None
                if p["trail"] is None
                else TrailSL(points=(p["trail"][0] * scale, p["trail"][1] * scale))
            )
            leg.range_breakout = RangeBreakout(
                until=until,
                side="high",
                source=p["source"],
                gap_percent=p.get("gap", 0.0),
                valid_until=valid_until_for(until, strategy.exit_time, p.get("valid")),
            )
        strategy.overall.stop_loss_inr = p["mtm"]
    else:
        raise ValueError(f"unknown family {cell.family!r}")
    return LegwiseStrategy.model_validate(strategy.model_dump())


def registered() -> dict[str, Any]:
    """The whole pre-registration as plain data (what the SHA covers)."""
    return {
        "version": GRID_VERSION,
        "slots": SLOTS,
        "indices": INDICES,
        "premium": PREMIUM,
        "point_scale": POINT_SCALE,
        "axes": AXES,
        "chains": CHAINS,
        "exclusion": excluded.__doc__,
        "counts": {
            f: sum(len(cells(f, i, s)) - 1 for i in INDICES for s in SLOTS) for f in FAMILIES
        },
    }


def grid_sha() -> str:
    text = json.dumps(registered(), sort_keys=True, default=str)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def params_from_row(family: str, row: dict[str, str]) -> dict[str, Any] | None:
    """Inverse of the CSV columns the runner writes (one `p_<axis>` column per axis)."""
    if row.get("cell") == TEMPLATE:
        return None
    out: dict[str, Any] = {}
    for axis in AXES[family]:
        raw = row[f"p_{axis}"]
        out[axis] = json.loads(raw) if raw else None
        if isinstance(out[axis], list):
            out[axis] = tuple(out[axis])
    if row.get("p_extra"):
        out.update(json.loads(row["p_extra"]))
    return out


def params_to_row(family: str, params: dict[str, Any] | None) -> dict[str, str]:
    out = {"cell": TEMPLATE if params is None else "grid"}
    for axis in AXES[family]:
        value = None if params is None else params[axis]
        out[f"p_{axis}"] = "" if value is None else json.dumps(value)
    extra = {} if params is None else {k: v for k, v in params.items() if k not in AXES[family]}
    out["p_extra"] = json.dumps(extra, sort_keys=True) if extra else ""
    return out


if __name__ == "__main__":
    reg = registered()
    print(json.dumps(reg["counts"]), "total", sum(reg["counts"].values()))
    print("grid sha", grid_sha())
