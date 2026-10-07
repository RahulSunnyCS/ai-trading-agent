"""
AlgoTest's backtest trade log, and a day-by-day comparison with the leg-wise engine
(BL-009 Phase 1: prove the engine's intrabar rules against AlgoTest's own results).

The export ("Download Report" on an AlgoTest backtest) is a CSV with one parent row per day
(`Index` "12": day, VIX, day P/L) followed by one row per leg ("12.1", "12.2": entry/exit date
and time, CE/PE, strike, Buy/Sell, quantity, prices, P/L). Times carry a leading space and
seconds (" 09:17:00"); the file starts with a byte-order mark.

**Minute stamps.** A fill at a scheduled time (entry, exit time) is stamped with that time on
both sides. A stop exit or a re-entry is stamped by AlgoTest at the END of the minute that
triggered it,
the engine at its start, so AlgoTest's stop minutes are expected to be the engine's + 1 — the
comparison accepts 0..2 for those and reports the distribution, so the convention stays a
measured fact rather than an assumption.

**Exit reasons.** AlgoTest's log has none; they are inferred: the strategy's exit time →
EXIT_TIME; two or more legs out at the same earlier minute → OVERALL_SL; a lone earlier exit →
STOP (a leg SL or the combined stop — indistinguishable from the log). The engine's SL and
OVERALL_SL both count as STOP when AlgoTest's is ambiguous.
"""

from __future__ import annotations

import csv
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .engine import DayResult, Trade
from .market import minute_index, minute_label
from .schema import LegwiseStrategy

#: One price tick: a gap up to this is equal.
TICK = 0.05
#: Accepted (AlgoTest minus engine) for a stop exit's minute: end-of-minute stamping is +1.
STOP_MINUTE_DELTAS = (0, 1, 2)
#: Day classes, most serious first.
CLASSES = ("missing", "strike", "reason", "minute", "price", "match")


@dataclass(frozen=True)
class AlgoLeg:
    option_type: str
    strike: float
    position: str  # "buy" | "sell"
    qty: int
    entry_min: int
    exit_min: int
    entry_price: float
    exit_price: float
    pnl: float


@dataclass
class AlgoDay:
    day: date
    vix: float | None
    pnl: float
    legs: list[AlgoLeg] = field(default_factory=list)


def _minute(text: str) -> int:
    return minute_index(text.strip()[:5])


def load_algotest_csv(path: Path) -> list[AlgoDay]:
    """Every day of an AlgoTest trade-log export, legs in file order."""
    days: list[AlgoDay] = []
    with path.open(newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            index = row["Index"].strip()
            if "." not in index:
                days.append(
                    AlgoDay(
                        day=date.fromisoformat(row["Entry Date"].strip()),
                        vix=float(row["Vix"]) if row["Vix"].strip() else None,
                        pnl=float(row["P/L"]),
                    )
                )
                continue
            if not days:
                raise ValueError(f"{path}: leg row {index} before any day row")
            days[-1].legs.append(
                AlgoLeg(
                    option_type=row["Type"].strip(),
                    strike=float(row["Strike"]),
                    position=row["B/S"].strip().lower(),
                    qty=int(float(row["Qty"])),
                    entry_min=_minute(row["Entry Time"]),
                    exit_min=_minute(row["Exit Time"]),
                    entry_price=float(row["Entry Price"]),
                    exit_price=float(row["Exit Price"]),
                    pnl=float(row["P/L"]),
                )
            )
    return days


def algotest_reasons(day: AlgoDay, exit_min: int) -> list[str]:
    """Inferred exit reason per leg (see the module docstring)."""
    out = []
    for leg in day.legs:
        if leg.exit_min >= exit_min:
            out.append("EXIT_TIME")
        elif sum(1 for other in day.legs if other.exit_min == leg.exit_min) >= 2:
            out.append("OVERALL_SL")
        else:
            out.append("STOP")
    return out


def _coarse(ours: str, theirs: str, left_with_others: bool = False) -> bool:
    """Same exit reason, allowing for what the log cannot show: a lone early exit (STOP) may
    be either stop, and legs that left in the same minute are OVERALL_SL in the log (inferred)
    though in the engine one or all of them may have hit their own SL in that minute."""
    if theirs == "STOP":
        return ours in ("SL", "OVERALL_SL")
    if theirs == "OVERALL_SL" and ours == "SL" and left_with_others:
        return True
    return ours == theirs


@dataclass
class LegDiff:
    option_type: str
    position: str
    strike: tuple[float, float]  # (algotest, engine)
    reason: tuple[str, str]
    entry_min: tuple[int, int]
    exit_min: tuple[int, int | None]
    entry_price: tuple[float, float]
    exit_price: tuple[float, float | None]
    qty: tuple[int, int]

    @property
    def exit_delta(self) -> int | None:
        return None if self.exit_min[1] is None else self.exit_min[0] - self.exit_min[1]

    @property
    def price_gap(self) -> float:
        gaps = [abs(self.entry_price[0] - self.entry_price[1])]
        if self.exit_price[1] is not None:
            gaps.append(abs(self.exit_price[0] - self.exit_price[1]))
        return max(gaps)


@dataclass
class DayDiff:
    day: date
    cls: str
    algotest_pnl: float | None
    engine_pnl: float | None
    legs: list[LegDiff] = field(default_factory=list)
    note: str = ""


def _pair(theirs: list[AlgoLeg], ours: list[Trade]) -> list[tuple[AlgoLeg, Trade | None]]:
    """AlgoTest legs to engine trades by (option_type, position), in order."""
    pool: dict[tuple[str, str], list[Trade]] = {}
    for t in ours:
        pool.setdefault((t.contract[2], t.position), []).append(t)
    pairs: list[tuple[AlgoLeg, Trade | None]] = []
    for leg in theirs:
        queue = pool.get((leg.option_type, leg.position), [])
        pairs.append((leg, queue.pop(0) if queue else None))
    return pairs


def compare_day(
    theirs: AlgoDay, ours: DayResult | None, strategy: LegwiseStrategy, skipped: str = ""
) -> DayDiff:
    exit_min = minute_index(strategy.exit_time)
    entry_min = minute_index(strategy.entry_time)
    if ours is None:
        return DayDiff(theirs.day, "missing", theirs.pnl, None, note=skipped or "not run")
    pairs = _pair(theirs.legs, ours.trades)
    extra = len(ours.trades) - sum(1 for _, t in pairs if t is not None)
    reasons = algotest_reasons(theirs, exit_min)
    exits = Counter(t.exit_min for t in ours.trades if t.exit_min is not None)
    legs: list[LegDiff] = []
    notes: list[str] = []
    worst = "match"
    for (leg, trade), reason in zip(pairs, reasons, strict=True):
        if trade is None:  # keep comparing the other legs
            notes.append(f"engine has no {leg.position} {leg.option_type} trade")
            worst = "missing"
            continue
        diff = LegDiff(
            option_type=leg.option_type,
            position=leg.position,
            strike=(leg.strike, trade.contract[1]),
            reason=(reason, trade.exit_reason),
            entry_min=(leg.entry_min, trade.entry_min),
            exit_min=(leg.exit_min, trade.exit_min),
            entry_price=(leg.entry_price, trade.entry_price),
            exit_price=(leg.exit_price, trade.exit_price),
            qty=(leg.qty, trade.qty),
        )
        legs.append(diff)
        if diff.strike[0] != diff.strike[1]:
            cls = "strike"
        elif not _coarse(trade.exit_reason, reason, exits[trade.exit_min] >= 2):
            cls = "reason"
        elif not _entry_ok(diff, entry_min) or not _minute_ok(diff, reason):
            cls = "minute"
        elif diff.price_gap > TICK + 1e-9:
            cls = "price"
        else:
            cls = "match"
        if CLASSES.index(cls) < CLASSES.index(worst):
            worst = cls
    if extra:
        notes.append(f"engine has {extra} more trade(s)")
        if CLASSES.index("reason") < CLASSES.index(worst):
            worst = "reason"
    return DayDiff(theirs.day, worst, theirs.pnl, ours.gross, legs, "; ".join(notes))


def _entry_ok(diff: LegDiff, scheduled: int) -> bool:
    """The scheduled entry is stamped alike; a re-entry (RE COST / RE ASAP) is an event, which
    AlgoTest stamps at the end of the triggering minute, like a stop exit."""
    theirs, ours = diff.entry_min
    if theirs == scheduled:
        return ours == scheduled
    return theirs - ours in STOP_MINUTE_DELTAS


def _minute_ok(diff: LegDiff, reason: str) -> bool:
    delta = diff.exit_delta
    if delta is None:
        return False
    return delta == 0 if reason == "EXIT_TIME" else delta in STOP_MINUTE_DELTAS


def compare(
    theirs: list[AlgoDay],
    ours: list[DayResult],
    strategy: LegwiseStrategy,
    skipped: dict[date, str] | None = None,
) -> list[DayDiff]:
    by_day = {r.day: r for r in ours}
    skipped = skipped or {}
    return [compare_day(d, by_day.get(d.day), strategy, skipped.get(d.day, "")) for d in theirs]


def report(diffs: list[DayDiff], strategy: LegwiseStrategy) -> str:
    """A Markdown summary: classes, minute deltas, price gaps, P&L, and every non-match day."""
    counts = Counter(d.cls for d in diffs)
    both = [d for d in diffs if d.cls != "missing"]
    legs = [leg for d in both for leg in d.legs]
    stop_deltas = Counter(leg.exit_delta for leg in legs if leg.reason[0] != "EXIT_TIME")
    gaps = [leg.price_gap for leg in legs]
    qty_diff = sum(1 for leg in legs if leg.qty[0] != leg.qty[1])
    lines = [
        f"# AlgoTest vs engine — {strategy.id}",
        "",
        f"{len(diffs)} AlgoTest days, {diffs[0].day if diffs else '-'} .. "
        f"{diffs[-1].day if diffs else '-'}",
        "",
        "| Class | Days |",
        "|---|---|",
        *(f"| {c} | {counts.get(c, 0)} |" for c in CLASSES),
        "",
        "Stop-exit minute, AlgoTest minus engine: "
        + ", ".join(
            f"{'none' if k is None else f'{k:+d}'}: {v}"
            for k, v in sorted(stop_deltas.items(), key=lambda x: (x[0] is None, x[0] or 0))
        ),
        "",
        f"Price gap per leg (max of entry/exit): mean {sum(gaps) / len(gaps):.2f}, "
        f"max {max(gaps):.2f}, within a tick {sum(1 for g in gaps if g <= TICK + 1e-9)}/{len(gaps)}"
        if gaps
        else "No legs compared.",
        "",
        f"Quantity differs on {qty_diff} leg(s).",
        "",
        f"P&L over days both ran: AlgoTest {sum(d.algotest_pnl or 0 for d in both):,.2f}, "
        f"engine {sum(d.engine_pnl or 0 for d in both):,.2f}",
        "",
        "## Days that differ",
        "",
        "| Day | Class | Leg | Strike A/E | Reason A/E | Exit A/E | Entry px A/E "
        "| Exit px A/E | Note |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for d in diffs:
        if d.cls == "match":
            continue
        if not d.legs:
            lines.append(f"| {d.day} | {d.cls} | | | | | | | {d.note} |")
        for leg in d.legs:
            ex_ours = minute_label(leg.exit_min[1]) if leg.exit_min[1] is not None else "-"
            lines.append(
                f"| {d.day} | {d.cls} | {leg.position} {leg.option_type} "
                f"| {leg.strike[0]:g}/{leg.strike[1]:g} | {leg.reason[0]}/{leg.reason[1]} "
                f"| {minute_label(leg.exit_min[0])}/{ex_ours} "
                f"| {leg.entry_price[0]:.2f}/{leg.entry_price[1]:.2f} "
                f"| {leg.exit_price[0]:.2f}/{(leg.exit_price[1] or 0):.2f} | {d.note} |"
            )
    return "\n".join(lines) + "\n"
