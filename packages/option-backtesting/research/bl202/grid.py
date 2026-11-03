"""BL-202 grid: the registered Buy-only axes, the cells they make, and the strategy each cell is.

One family, the long range-breakout Buy (CE + PE, symmetric), as a full Cartesian product over
its Stage-1 axes at one entry slot per start band and two indices. Every cell runs at
`SLIPPAGE_PCT` adverse slippage on every fill (the owner's scoring basis, 2026-11-03): it is part
of the cell, not a runner flag. The values here are the pre-registration (backlog/BL-202 Phase 0):
`grid_sha()` is recorded in the item and the unit test holds the counts, so a later edit shows.

Stage 2's axes (exit, gap, valid-until, stop on close, one re-entry at cost, the peak trail) are
registered here too, as `STAGE2`, and applied by `build` when a cell's params carry them; Stage 1
never sets them. The day rules of Stage 3 are listed in `DAY_RULES` so the SHA covers them.

Every cell starts from the rotation file of its (index, slot) — `strategies/rotation/
<N|S>_buy_<HHMM>.yaml` — and overrides the axes symmetrically on both legs. The "template" cell
of a cohort is that file loaded AS-IS plus the slippage: the anchor; at `--slippage 0` it must
reproduce BL-104's template cell to the rupee.

Imports only the package and stdlib so a test can load this file by path. Shaped after
research/bl104/grid.py (research folders are not imported across items: CLAUDE.md).
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
    TrailPeak,
    TrailSL,
    load_legwise,
)

PACKAGE = Path(__file__).resolve().parents[2]
ROTATION = PACKAGE / "strategies" / "rotation"

GRID_VERSION = "bl202-stage1-2026-11-03"
FAMILY = "B"
INDICES = {"N": "NIFTY", "S": "SENSEX"}
#: one slot per start band: the band's first rotation slot
SLOTS = ("09:17", "10:17", "12:17", "14:17")
TEMPLATE = "template"
#: adverse slippage on every fill, % of price: the scoring basis of every cell
SLIPPAGE_PCT = 1.0
LOT_SIZING = "current"
#: the split: fit through FIT_TO, test after it (backlog/BL-202 Phase 0)
FROM = "2024-10-09"
FIT_TO = "2025-10-08"


def band(slot: str) -> str:
    """Start band, the rotation's rule (`rotation.score.family_index`): A <= 10:02,
    B <= 12:02, C <= 14:02, D after."""
    h, m = slot.split(":")
    minute = int(h) * 60 + int(m)
    return "A" if minute <= 602 else "B" if minute <= 722 else "C" if minute <= 842 else "D"


# Closest-premium levels per index (SENSEX 3x NIFTY, the rotation's own ratio).
PREMIUM: dict[str, dict[str, float]] = {
    "NIFTY": {"PLOW": 30, "PMID": 50, "PHIGH": 75, "PTOP": 100},
    "SENSEX": {"PLOW": 90, "PMID": 150, "PHIGH": 225, "PTOP": 300},
}
# Point trails are in premium rupees, so SENSEX's are scaled like its premiums.
POINT_SCALE = {"NIFTY": 1.0, "SENSEX": 3.0}

# Stage-1 axis values in their registered order. The order is also the neighbour order for the
# plateau rule: two cells are neighbours when they differ in exactly one axis by one step along
# a CHAIN of that axis (a point trail is not next to a percent trail).
AXES: dict[str, tuple[Any, ...]] = {
    "strike": ("PLOW", "PMID", "PHIGH", "PTOP"),
    "range": (5, 10, 15, 30),  # minutes watched after the start
    "source": ("instrument", "underlying"),
    "sl": (15, 20, 30, 40, 50),  # leg stop, % of entry
    "target": (None, 50, 100, 200),  # % of entry
    "trail": (None, ("pts", 1, 1), ("pts", 3, 1), ("pct", 20, 10)),
    "mtm": (1000, 2000, 3000, None),  # day stop, rupees a lot
}

CHAINS: dict[str, tuple[tuple[Any, ...], ...]] = {
    "strike": (AXES["strike"],),
    "range": (AXES["range"],),
    "source": (AXES["source"],),
    "sl": (AXES["sl"],),
    "target": (AXES["target"],),
    "trail": ((None, ("pts", 1, 1), ("pts", 3, 1)), (None, ("pct", 20, 10))),
    "mtm": (AXES["mtm"],),
}

#: Stage-2 axes (backlog/BL-202 Phase 0), crossed around each cohort's Stage-1 plateau cells.
#: `valid` and the earliest exit are minutes after the slot's start; `reentry` = once at cost;
#: `peak` = (activate %, exit % of the high), BL-164's TrailPeak.
STAGE2: dict[str, tuple[Any, ...]] = {
    "exit": ("13:00", "14:30", "15:14", "15:28"),
    "gap": (0.0, 1.0, 2.0),  # % beyond the range edge
    "valid": (None, 60, 120),
    "stop_on": ("tick", "close"),
    "reentry": (None, ("cost", 1)),
    "peak": (None, (150, 70)),
}
MIN_HOLD_MINUTES = 60  # an exit earlier than start + this is not a cell (see `excluded`)
ROTATION_EXIT = "15:14"  # the Buy rotation files' own exit: always a cell

#: Stage-3 day rules, each applied to a finalist's day series (and the template's).
DAY_RULES = (
    "every_day",
    "rank_top10",
    "rank_top25",
    "expiry_day_of_index",
    "non_expiry_day",
    "vix_le_15",
    "vix_15_18",
    "vix_gt_18",
    "gap_open_0.5pct",
    "weekday_mon",
    "weekday_tue",
    "weekday_wed",
    "weekday_thu",
    "weekday_fri",
    "never",
)


@dataclass(frozen=True)
class Cell:
    index: str  # "N" | "S"
    slot: str
    params: dict[str, Any] | None  # None = the template cell (the rotation file as-is)

    @property
    def underlying(self) -> str:
        return INDICES[self.index]

    @property
    def cohort(self) -> str:
        return f"{FAMILY}_{self.index}_{self.slot.replace(':', '')}"

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
    """How a value reads in a table: `[1,1]pts`, `[20,10]%`, `cost×1`, `none`."""
    if value is None:
        return "none"
    if axis == "trail":
        kind, x, y = value
        return f"[{x:g},{y:g}]" + ("pts" if kind == "pts" else "%")
    if axis == "reentry":
        return f"{value[0]}×{value[1]}"
    if axis == "peak":
        return f"{value[0]:g}/{value[1]:g}"
    if isinstance(value, tuple):
        return "[" + ",".join(f"{v:g}" for v in value) + "]"
    return str(value)


def token(value: Any) -> str:
    if value is None:
        return "none"
    if isinstance(value, tuple):
        return "-".join(token(v) for v in value)
    return str(value).replace(":", "").replace(".", "p")


def hhmm_plus(value: str, minutes: int) -> str:
    return (datetime.strptime(value, "%H:%M") + timedelta(minutes=minutes)).strftime("%H:%M")


def excluded(slot: str, params: dict[str, Any]) -> str | None:
    """Why a combination is left out, or None if it is a cell. Stage 1 excludes nothing. A
    Stage-2 exit earlier than start + MIN_HOLD_MINUTES is not a strategy and is left out rather
    than silently clamped (13:00 at 12:17; 13:00 and 14:30 at 14:17); the rotation's own 15:14
    and the later 15:28 are always cells, so the 14:17 cohort keeps its template exit."""
    exit_time = params.get("exit")
    earliest = min(hhmm_plus(slot, MIN_HOLD_MINUTES), ROTATION_EXIT)
    if exit_time is not None and exit_time < earliest:
        return f"exit {exit_time} earlier than start + {MIN_HOLD_MINUTES} min"
    return None


def cartesian(axes: dict[str, tuple[Any, ...]] = AXES) -> list[dict[str, Any]]:
    combos: list[dict[str, Any]] = [{}]
    for axis, values in axes.items():
        combos = [{**c, axis: v} for c in combos for v in values]
    return combos


def cells(index: str, slot: str, *, with_template: bool = True) -> list[Cell]:
    out = [Cell(index, slot, None)] if with_template else []
    out += [Cell(index, slot, p) for p in cartesian() if excluded(slot, p) is None]
    return out


def all_cells() -> list[Cell]:
    return [cell for index in INDICES for slot in SLOTS for cell in cells(index, slot)]


def template_path(index: str, slot: str) -> Path:
    return ROTATION / f"{index}_buy_{slot.replace(':', '')}.yaml"


def load_template(index: str, slot: str) -> LegwiseStrategy:
    return load_legwise(template_path(index, slot))


def execution_for(slippage: float = SLIPPAGE_PCT) -> Execution:
    return Execution(slippage_pct=slippage, lot_sizing=LOT_SIZING)


def strike_for(underlying: str, value: str) -> Strike:
    return Strike(closest_premium=PREMIUM[underlying][value])


def trail_for(value: Any, scale: float) -> TrailSL | None:
    if value is None:
        return None
    kind, x, y = value
    if kind == "pts":
        return TrailSL(points=(x * scale, y * scale))
    return TrailSL(percent=(x, y))


def build(
    cell: Cell,
    template: LegwiseStrategy | None = None,
    *,
    slippage: float = SLIPPAGE_PCT,
) -> LegwiseStrategy:
    """The validated strategy a cell describes. `template` is the cohort's rotation file (loaded
    once per cohort by the runner). `slippage` is the registered 1 % unless a Stage-3 sensitivity
    run says otherwise; the template cell carries it too."""
    base = template or load_template(cell.index, cell.slot)
    strategy = base.model_copy(deep=True)
    strategy.id = cell.label
    strategy.execution = execution_for(slippage)
    p = cell.params
    if p is None:
        return LegwiseStrategy.model_validate(strategy.model_dump())
    underlying = cell.underlying
    scale = POINT_SCALE[underlying]
    if "exit" in p:
        strategy.exit_time = p["exit"]
    until = hhmm_plus(strategy.entry_time, p["range"])
    valid = p.get("valid")
    valid_until = None if valid is None else hhmm_plus(strategy.entry_time, valid)
    if valid_until is not None and (valid_until <= until or valid_until >= strategy.exit_time):
        valid_until = None  # no window to close: the same as none, never a clamped half-cell
    reentry = p.get("reentry")
    peak = p.get("peak")
    for leg in strategy.legs:
        leg.strike = strike_for(underlying, p["strike"])
        leg.stop_loss = Amount(percent=p["sl"])
        leg.target = None if p["target"] is None else Amount(percent=p["target"])
        leg.trail_sl = trail_for(p["trail"], scale)
        leg.range_breakout = RangeBreakout(
            until=until,
            side="high",
            source=p["source"],
            gap_percent=p.get("gap", 0.0),
            valid_until=valid_until,
        )
        leg.stop_on = p.get("stop_on", "tick")
        leg.reentry_on_sl = None if reentry is None else ReEntry(mode=reentry[0], count=reentry[1])
        leg.trail_peak = (
            None if peak is None else TrailPeak(activate_percent=peak[0], exit_percent=peak[1])
        )
    strategy.overall.stop_loss_inr = p["mtm"]
    return LegwiseStrategy.model_validate(strategy.model_dump())


def registered() -> dict[str, Any]:
    """The whole pre-registration as plain data (what the SHA covers)."""
    return {
        "version": GRID_VERSION,
        "family": FAMILY,
        "slots": SLOTS,
        "indices": INDICES,
        "slippage_pct": SLIPPAGE_PCT,
        "lot_sizing": LOT_SIZING,
        "window": {
            "from": FROM,
            "fit_to": FIT_TO,
            "test": "after fit_to to the last collected day",
        },
        "premium": PREMIUM,
        "point_scale": POINT_SCALE,
        "axes": AXES,
        "chains": CHAINS,
        "stage2": STAGE2,
        "min_hold_minutes": MIN_HOLD_MINUTES,
        "rotation_exit": ROTATION_EXIT,
        "day_rules": DAY_RULES,
        "exclusion": excluded.__doc__,
        "counts": {
            "per_cohort": len(cells("N", SLOTS[0])) - 1,
            "total": sum(len(cells(i, s)) - 1 for i in INDICES for s in SLOTS),
        },
    }


def grid_sha() -> str:
    text = json.dumps(registered(), sort_keys=True, default=str)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def params_from_row(row: dict[str, str]) -> dict[str, Any] | None:
    """Inverse of the CSV columns the runner writes (one `p_<axis>` column per axis)."""
    if row.get("cell") == TEMPLATE:
        return None
    out: dict[str, Any] = {}
    for axis in AXES:
        raw = row[f"p_{axis}"]
        out[axis] = json.loads(raw) if raw else None
        if isinstance(out[axis], list):
            out[axis] = tuple(out[axis])
    if row.get("p_extra"):
        for k, v in json.loads(row["p_extra"]).items():
            out[k] = tuple(v) if isinstance(v, list) else v
    return out


def params_to_row(params: dict[str, Any] | None) -> dict[str, str]:
    out = {"cell": TEMPLATE if params is None else "grid"}
    for axis in AXES:
        value = None if params is None else params[axis]
        out[f"p_{axis}"] = "" if value is None else json.dumps(value)
    extra = {} if params is None else {k: v for k, v in params.items() if k not in AXES}
    out["p_extra"] = json.dumps(extra, sort_keys=True) if extra else ""
    return out


if __name__ == "__main__":
    reg = registered()
    print(json.dumps(reg["counts"]))
    print("grid sha", grid_sha())
