"""BL-091 Phase 1: R0, the owner's re-entry habit (E.6), replayed with the legwise engine.

One attempt = the live Widesl (`strategies/rotation/{N|S}_wide_1202.yaml`: OTM1 NIFTY / OTM2 SENSEX
strangle, 115 % leg stops trailed 15/10, exit 15:28, 1 lot per leg) with only the entry time and
`overall.stop_loss_inr` changed (owner, 2026-10-10: "I keep widesl as it is, with assume 650 as MTM
SL"). The owner runs four such strategies; one is simulated and its rupees are per strategy.

Attempt 1 enters at the minute after the episode's trigger bar (trigger on bar t -> entry at t+1,
which fills at bar t's close). After an overall stop at bar m the next attempt enters at m+1, i.e.
at the price the stop filled at. The ladder ends when an attempt is not overall-stopped, after
MAX_ATTEMPTS, or when the next entry would be at or after 15:13.
"""

from __future__ import annotations

from typing import Any

import yaml
from periods import COST_PER_ORDER, M_1513, MAX_ATTEMPTS, SIZING, STOP_INR

from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import DayData, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy
from option_backtesting.rotation.variants import STRATEGIES_DIR

_TEMPLATES: dict[str, dict] = {}

ATTEMPT_COLUMNS = [
    "attempt", "entry_min", "entry", "exit_min", "exit", "outcome", "net0", "n_orders", "net20",
    "worst_mtm", "legs_entered", "held_minutes", "ce_strike", "ce_entry_price", "ce_exit_price",
    "ce_reason", "pe_strike", "pe_entry_price", "pe_exit_price", "pe_reason", "notes",
]  # fmt: skip


def wide_strategy(underlying: str, entry: str, stop_inr: float = STOP_INR) -> LegwiseStrategy:
    if underlying not in _TEMPLATES:
        path = STRATEGIES_DIR / f"{underlying[0]}_wide_1202.yaml"
        _TEMPLATES[underlying] = yaml.safe_load(path.read_text())["strategy"]
    d = yaml.safe_load(yaml.safe_dump(_TEMPLATES[underlying]))  # a fresh copy to edit
    d["id"] = f"bl091_{underlying[0]}_wide_r0"
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


def attempt_row(k: int, entry_min: int, result: DayResult) -> dict[str, Any]:
    trades = result.trades
    exits = [t.exit_min for t in trades if t.exit_min is not None]
    exit_min = max(exits) if exits else None
    n_orders = len(trades) + len(exits)
    net0 = round(result.gross - result.costs, 2)
    row: dict[str, Any] = {
        "attempt": k,
        "entry_min": entry_min,
        "entry": minute_label(entry_min),
        "exit_min": exit_min,
        "exit": minute_label(exit_min) if exit_min is not None else "",
        "outcome": classify(result),
        "net0": net0,
        "n_orders": n_orders,
        "net20": round(net0 - COST_PER_ORDER * n_orders, 2),
        "worst_mtm": round(result.worst_mtm, 2),
        "legs_entered": len(trades),
        "held_minutes": (exit_min - entry_min) if exit_min is not None else None,
        "notes": " | ".join(result.notes),
    }
    for leg in ("ce", "pe"):
        t = next((t for t in trades if t.leg_id == leg), None)
        row[f"{leg}_strike"] = t.contract[1] if t else None
        row[f"{leg}_entry_price"] = t.entry_price if t else None
        row[f"{leg}_exit_price"] = t.exit_price if t else None
        row[f"{leg}_reason"] = t.exit_reason if t else ""
    return row


def ladder(
    data: DayData,
    underlying: str,
    trigger_min: int,
    reference,
    stop_inr: float = STOP_INR,
    max_attempts: int = MAX_ATTEMPTS,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    entry = trigger_min + 1
    for k in range(1, max_attempts + 1):
        if entry >= M_1513:
            break
        result = simulate_day(
            wide_strategy(underlying, minute_label(entry), stop_inr), data, reference, SIZING
        )
        row = attempt_row(k, entry, result)
        rows.append(row)
        if row["outcome"] != "OVERALL_SL" or row["exit_min"] is None:
            break
        entry = row["exit_min"] + 1
    return rows
