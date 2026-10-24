"""One live Widesl, entered at a chosen minute with a chosen overall stop, run through the legwise engine.

Copied from `research/bl091/r0.py` (BL-091) on 2026-10-18 for BL-123 (research code is not imported
across item folders). The strategy is `strategies/rotation/{N|S}_wide_1202.yaml` (OTM1 NIFTY / OTM2
SENSEX strangle, 115 % leg stops trailed 15/10, exit 15:28, 1 lot per leg) with only the entry time and
`overall.stop_loss_inr` changed. Rupees are per strategy. `lot_sizing: current`, sizing date 2026-10-12.

The engine prices from forward-filled closes (including the vendor's zero-volume carried bars); that is
the convention behind every stored result and is not changed here.
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
COST_PER_ORDER = 20.0  # second net column; stored results run at 0

_TEMPLATES: dict[str, dict] = {}


def template_stop(underlying: str) -> float | None:
    """The live file's own overall stop (for checks against stored results)."""
    return _template(underlying)["overall"].get("stop_loss_inr")


def _template(underlying: str) -> dict:
    if underlying not in _TEMPLATES:
        path = STRATEGIES_DIR / f"{underlying[0]}_wide_1202.yaml"
        _TEMPLATES[underlying] = yaml.safe_load(path.read_text())["strategy"]
    return _TEMPLATES[underlying]


def wide_strategy(underlying: str, entry: str, stop_inr: float | None) -> LegwiseStrategy:
    d = yaml.safe_load(yaml.safe_dump(_template(underlying)))  # a fresh copy to edit
    d["id"] = f"research_{underlying[0]}_wide"
    d["entry_time"] = entry
    d["overall"]["stop_loss_inr"] = stop_inr
    return LegwiseStrategy.model_validate(d)


def classify(result: DayResult) -> str:
    if not result.trades:
        return "NO_ENTRY"
    reasons = {t.exit_reason for t in result.trades}
    if "OVERALL_SL" in reasons:
        return "OVERALL_SL"
    if "EXIT_TIME" in reasons:
        return "HELD"
    return "LEG_SL_FLAT"


def run_wide(
    data: DayData, underlying: str, entry_min: int, stop_inr: float | None, ref
) -> dict[str, Any]:
    """One Widesl entered at minute index `entry_min`; the numbers a read-out needs."""
    res = simulate_day(
        wide_strategy(underlying, minute_label(entry_min), stop_inr), data, ref, SIZING
    )
    exits = [t.exit_min for t in res.trades if t.exit_min is not None]
    n_orders = len(res.trades) + len(exits)
    net0 = round(res.gross - res.costs, 2)
    return {
        "entry_min": entry_min,
        "outcome": classify(res),
        "gross": round(res.gross, 2),
        "net0": net0,
        "n_orders": n_orders,
        "net20": round(net0 - COST_PER_ORDER * n_orders, 2),
        "worst_mtm": round(res.worst_mtm, 2),
        "legs": len(res.trades),
        "exit_min": max(exits) if exits else None,
    }
