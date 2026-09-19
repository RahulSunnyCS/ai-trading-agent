"""
Per-fill and per-session record-keeping.

A `Fill` carries a `lots` multiplier rather than being replicated N times per
lot — this matches how the reference (`golden_15_sessions.py`) sums
cost/lot-days/peak-loss per *fill event*, not per individual lot: e.g. the
2-lot base entry is one event with `lots=2`, and `cost = len(ev) * 2 * COST`
counts events, while `lot_days`/mtm formulas explicitly multiply each event's
contribution by its own lot count.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Fill:
    price: float
    bar: int  # 0 for the entry fill — the bar-index convention lot-days/peak-loss math uses
    lots: int
    tag: str  # "entry" | a ladder id | "fallback"


@dataclass
class SessionLedger:
    fills: list[Fill] = field(default_factory=list)

    def add(self, fill: Fill) -> None:
        self.fills.append(fill)

    def total_lots(self) -> int:
        return sum(f.lots for f in self.fills)

    def has_fired(self, tag: str) -> bool:
        return any(f.tag == tag for f in self.fills)

    def earliest_bar_for_tags(self, tags: frozenset[str]) -> int | None:
        bars = [f.bar for f in self.fills if f.tag in tags]
        return min(bars) if bars else None
