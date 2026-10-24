"""One long ATM straddle (buy CE + buy PE), entered at a chosen minute, run through the legwise engine.

Built from the structure of `strategies/rotation/N_dir_1202.yaml` (ATM weekly legs, 1 lot each) with the
legs flipped to `buy`, a percentage stop on each leg, a trailing stop in points and no re-entry or overall
stop. Defaults are BL-124's: leg stop 25 %, trail [3, 2] points (every 3 points of favourable move moves
the stop 2), exit 15:14 (the Buy family's exit). Rupees per straddle (both legs). `lot_sizing: current`,
sizing date 2026-10-12, cost 20 rupees an order (entry and exit of each leg are one order each).
"""

from __future__ import annotations

from datetime import date
from typing import Any

import yaml

from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import DayData, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy
from option_backtesting.rotation.variants import STRATEGIES_DIR

SIZING = date(2026, 10, 12)
COST_PER_ORDER = 20.0

_TEMPLATE: dict[str, Any] = {}


def long_straddle_strategy(
    entry: str,
    exit_time: str = "15:14",
    sl_percent: float = 25.0,
    trail_points: tuple[float, float] = (3.0, 2.0),
) -> LegwiseStrategy:
    if not _TEMPLATE:
        path = STRATEGIES_DIR / "N_dir_1202.yaml"
        _TEMPLATE.update(yaml.safe_load(path.read_text())["strategy"])
    d = yaml.safe_load(yaml.safe_dump(dict(_TEMPLATE)))
    d["id"] = "research_long_straddle"
    d["entry_time"] = entry
    d["exit_time"] = exit_time
    for leg in d["legs"]:
        leg["position"] = "buy"
        leg["stop_loss"] = {"percent": sl_percent}
        leg["trail_sl"] = {"points": [trail_points[0], trail_points[1]]}
        leg.pop("reentry_on_sl", None)
    d["overall"] = {}
    return LegwiseStrategy.model_validate(d)


def classify(result: DayResult) -> str:
    """How many legs were stopped: NO_ENTRY, HELD (none), ONE_SL, BOTH_SL."""
    if not result.trades:
        return "NO_ENTRY"
    stopped = sum(1 for t in result.trades if t.exit_reason == "SL")
    return {0: "HELD", 1: "ONE_SL"}.get(stopped, "BOTH_SL")


def run_long(data: DayData, entry_min: int, ref) -> dict[str, Any]:
    res = simulate_day(long_straddle_strategy(minute_label(entry_min)), data, ref, SIZING)
    exits = [t.exit_min for t in res.trades if t.exit_min is not None]
    n_orders = len(res.trades) + len(exits)
    net0 = round(res.gross - res.costs, 2)
    return {
        "entry_min": entry_min,
        "outcome": classify(res),
        "reasons": "|".join(sorted(t.exit_reason for t in res.trades)),
        "gross": round(res.gross, 2),
        "net0": net0,
        "n_orders": n_orders,
        "net20": round(net0 - COST_PER_ORDER * n_orders, 2),
        "worst_mtm": round(res.worst_mtm, 2),
        "legs": len(res.trades),
        "exit_min": max(exits) if exits else None,
    }
