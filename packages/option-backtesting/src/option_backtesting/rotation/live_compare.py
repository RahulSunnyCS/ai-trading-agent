"""BL-141 Phase 3: the day's live results beside the paper ones.

The live capture (`packages/broker-login/src/live-capture.ts`, 15:40 and its retries, back-filled
later when missed) writes `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`: a `section` line per
platform + broker it read and a `strategy` line per strategy, the tool's (`source: tool`, with its
rotation `variant` and list `book`) or the owner's own (`discretionary`). Live ₹ is gross, as the
platforms show it.

For each tool variant, list and platform + broker, every copy that traded is put together:

- per lot = live ₹ of the copies ÷ their multipliers added up (two copies at 1x = 2 lots, so a copy
  the owner runs on purpose is a count, never slippage); the same variant picked by Core and T1
  stays two rows;
- paper = the engine's result for that variant and day at one lot (`rotation/results`, or the T1
  track's), after its estimated costs; the same costs are taken off live;
- **slippage ₹ per lot = live per lot − paper per lot**, signed: + live did better than paper;
- slippage % = that gap as a share of the premium at the first entry, per lot, where fills are
  known.

Kept out of the slippage and listed on their own: a copy that did not trade (deployed, nothing
filled), one with legs still open when read, and one whose first fill is away from the variant's
entry minute (deployed late, say: not the backtested trade). Discretionary lines are summed on
their own and never compared with anything. Money is summed in `Decimal`.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

from ..fyers.daily import data_dir
from . import labels, store

PLATFORM_NAMES = {"algotest": "AlgoTest", "quantiply": "Quantiply"}
BROKER_NAMES = {"finvasia": "Shoonya", "angelone": "Angel One"}
#: list names for the lines; a list not named here (a later rename, `ta` / `ca`) shows as its key
BOOK_NAMES = {"t1": "T1", "core": "Core"}
#: minutes a first fill may sit before the entry minute (AlgoTest enters at hh:mm−1:59) or after it
EARLY_MINUTES = 2
LATE_MINUTES = 3
IST = timezone(timedelta(hours=5, minutes=30))


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


def live_dir(root: Path | None = None) -> Path:
    return store.rotation_dir(root or data_dir()) / "live"


def live_path(day: date, root: Path | None = None) -> Path:
    return live_dir(root) / f"{day.isoformat()}.jsonl"


def read_lines(day: date, root: Path | None = None) -> list[dict] | None:
    """The day's capture lines, or None when there is no file."""
    path = live_path(day, root)
    if not path.exists():
        return None
    out: list[dict] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue  # a torn line
        if isinstance(row, dict) and row.get("kind") in ("section", "strategy"):
            out.append(row)
    return out


def paper_row(variant: str, day: date, root: Path | None = None) -> dict[str, Decimal] | None:
    """{net, gross, costs} of a variant's stored result for the day, at one lot, or None."""
    path = store.result_path(variant, root)
    if not path.exists():
        return None
    with path.open() as f:
        for r in csv.DictReader(f):
            if r["day"] == day.isoformat():
                return {k: _d(r[k]) for k in ("net", "gross", "costs")}
    return None


def ist_time(at: str) -> datetime | None:
    """A fill time as IST: AlgoTest writes IST with no zone; a time with a zone (Quantiply's UTC,
    `…Z`) is converted."""
    if not at:
        return None
    try:
        t = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.astimezone(IST) if t.tzinfo else t.replace(tzinfo=IST)


def traded(line: dict) -> bool:
    """A capture line's `traded`; lines written before it existed: an AlgoTest copy with no fills
    did not trade."""
    if "traded" in line:
        return bool(line["traded"])
    return not (line.get("pnl_source") == "legs" and line.get("fills") == [])


def _minutes(t: datetime) -> int:
    return t.hour * 60 + t.minute


def off_slot(line: dict) -> bool:
    """Whether a tool copy's first fill is away from its variant's entry minute. Unknown (no fills,
    no slot in the id) counts as on the slot; a range-breakout buy may enter any time after it."""
    times = [ist_time(str((f.get("entry") or {}).get("at", ""))) for f in line.get("fills") or []]
    times = [t for t in times if t is not None]
    tag = labels.slot(line.get("variant") or "")
    if not tag or not times:
        return False
    h, m = tag.split(":")
    slot = int(h) * 60 + int(m)
    first = _minutes(min(times))
    if first < slot - EARLY_MINUTES:
        return True
    try:
        breakout = labels.breakout_note(line["variant"]) is not None
    except Exception:  # noqa: BLE001 - an unknown strategy file: judge by time only
        breakout = False
    return not breakout and first > slot + LATE_MINUTES


def _first_entry_premium(lines: list[dict]) -> Decimal | None:
    """₹ of premium at each copy's first entry (price x quantity of the legs filled in the first
    entry minute; re-entries later are left out), or None when a copy's fills are unknown."""
    total = Decimal(0)
    for line in lines:
        fills = [
            (ist_time(str((f.get("entry") or {}).get("at", ""))), f)
            for f in line.get("fills") or []
        ]
        fills = [(t, f) for t, f in fills if t is not None]
        if not fills:
            return None
        first = min(t for t, _ in fills).replace(second=0, microsecond=0)
        for t, f in fills:
            if t.replace(second=0, microsecond=0) == first:
                total += _d((f.get("entry") or {}).get("price")) * _d(f.get("qty"))
    return total


@dataclass
class Compared:
    platform: str
    broker: str
    book: str | None
    variant: str
    copies: int
    lots: float
    live: float
    live_per_lot: float
    paper: float | None
    costs: float
    slippage: float | None
    slippage_pct: float | None
    #: premium at the first entry, ₹ per lot, when fills are known
    premium_per_lot: float | None = None
    #: a copy had no multiplier recorded (counted as 1x)
    multiplier_guessed: bool = False


@dataclass
class Group:
    """One platform + broker + list: the per-lot sums of its compared variants."""

    platform: str
    broker: str
    book: str | None
    live: float
    paper: float
    slippage: float
    slippage_pct: float | None
    variants: int


@dataclass
class DayComparison:
    day: date
    #: False when the capture has no file for the day
    captured: bool
    sections: list[dict] = field(default_factory=list)
    compared: list[Compared] = field(default_factory=list)
    #: tool variants with no paper result for the day
    no_paper: list[Compared] = field(default_factory=list)
    off_slot: list[dict] = field(default_factory=list)
    #: tool copies with legs still open when read: their P&L is incomplete
    open_legs: list[dict] = field(default_factory=list)
    #: tool copies deployed or enabled that never filled
    not_traded: list[dict] = field(default_factory=list)
    #: lines the capture marked the tool's whose name it could not read as `<list> · <variant>`
    unrecognised: list[dict] = field(default_factory=list)
    discretionary: list[dict] = field(default_factory=list)

    @property
    def discretionary_total(self) -> float:
        return float(sum((_d(d.get("pnl")) for d in self.discretionary if traded(d)), Decimal(0)))

    @property
    def failed_sections(self) -> list[dict]:
        return [s for s in self.sections if not s.get("ok")]

    def groups(self) -> list[Group]:
        keyed: dict[tuple[str, str, str], list[Compared]] = {}
        for c in self.compared:
            keyed.setdefault((c.platform, c.broker, c.book or ""), []).append(c)
        out = []
        for (platform, broker, book), items in sorted(keyed.items()):
            live = sum((_d(c.live_per_lot) - _d(c.costs) for c in items), Decimal(0))
            paper = sum((_d(c.paper) for c in items), Decimal(0))
            slip = sum((_d(c.slippage) for c in items), Decimal(0))
            premiums = [c.premium_per_lot for c in items]
            pct = None
            if all(p for p in premiums):
                pct = float(slip / sum((_d(p) for p in premiums), Decimal(0)) * 100)
            out.append(
                Group(
                    platform,
                    broker,
                    book or None,
                    float(live),
                    float(paper),
                    float(slip),
                    pct,
                    len(items),
                )
            )
        return out


def _paper_for(
    variant: str, day: date, root: Path | None, memo: dict[str, dict[str, dict]] | None
) -> dict[str, Decimal] | None:
    """`paper_row`, reading each variant's result file once when a `memo` is shared across days."""
    if memo is None:
        return paper_row(variant, day, root)
    if variant not in memo:
        rows: dict[str, dict] = {}
        path = store.result_path(variant, root)
        if path.exists():
            with path.open() as f:
                rows = {
                    r["day"]: {k: _d(r[k]) for k in ("net", "gross", "costs")}
                    for r in csv.DictReader(f)
                }
        memo[variant] = rows
    return memo[variant].get(day.isoformat())


def compare(
    day: date, root: Path | None = None, memo: dict[str, dict[str, dict]] | None = None
) -> DayComparison:
    lines = read_lines(day, root)
    if lines is None:
        return DayComparison(day, captured=False)
    result = DayComparison(day, captured=True)
    result.sections = [r for r in lines if r["kind"] == "section"]
    tool: dict[tuple[str, str, str, str], list[dict]] = {}
    for r in lines:
        if r["kind"] != "strategy":
            continue
        if r.get("source") != "tool":
            if traded(r):
                result.discretionary.append(r)
        elif not r.get("variant"):
            result.unrecognised.append(r)  # the tool's money, never in the discretionary total
        elif not traded(r):
            result.not_traded.append(r)
        elif int(r.get("open_legs") or 0):
            result.open_legs.append(r)
        elif off_slot(r):
            result.off_slot.append(r)
        else:
            key = (r["platform"], str(r["broker"]), str(r.get("book") or ""), r["variant"])
            tool.setdefault(key, []).append(r)
    for (platform, broker, book, variant), copies in sorted(tool.items()):
        multipliers = [c.get("multiplier") for c in copies]
        lots = sum(
            (_d(m) if isinstance(m, (int, float)) and m > 0 else Decimal(1) for m in multipliers),
            Decimal(0),
        )
        live = sum((_d(c.get("pnl")) for c in copies), Decimal(0))
        per_lot = live / lots
        paper = _paper_for(variant, day, root, memo)
        costs = paper["costs"] if paper else Decimal(0)
        premium = _first_entry_premium(copies)
        premium_per_lot = premium / lots if premium else None
        slip = (per_lot - costs) - paper["net"] if paper else None
        pct = slip / premium_per_lot * 100 if slip is not None and premium_per_lot else None
        item = Compared(
            platform=platform,
            broker=broker,
            book=book or None,
            variant=variant,
            copies=len(copies),
            lots=float(lots),
            live=float(live),
            live_per_lot=float(per_lot),
            paper=float(paper["net"]) if paper else None,
            costs=float(costs),
            slippage=float(slip) if slip is not None else None,
            slippage_pct=float(pct) if pct is not None else None,
            premium_per_lot=float(premium_per_lot) if premium_per_lot else None,
            multiplier_guessed=any(
                c.get("multiplier_assumed") or not isinstance(c.get("multiplier"), (int, float))
                for c in copies
            ),
        )
        (result.compared if paper else result.no_paper).append(item)
    return result


# -- range: the Rotation page's "Live vs paper" card ----------------------------------------------

#: entry-time bands for slippage by shape (minutes from midnight, upper bound exclusive)
BANDS = (("09:15–09:30", 9 * 60 + 30), ("09:30–12:00", 12 * 60), ("12:00 on", 24 * 60))
MAX_RANGE_DAYS = 400


def captured_days(root: Path | None = None) -> list[date]:
    """Every day with a capture file, oldest first."""
    folder = live_dir(root)
    if not folder.exists():
        return []
    out = []
    for path in folder.glob("*.jsonl"):
        try:
            out.append(date.fromisoformat(path.stem))
        except ValueError:
            continue
    return sorted(out)


def shape_of(variant: str) -> tuple[str, str]:
    """(position, entry band) of a variant id: `sell` / `buy` and the band its slot falls in, or
    `—` when the id carries no slot."""
    position = "buy" if labels.buy_strategy(variant) else "sell"
    tag = labels.slot(variant)
    if not tag:
        return position, "—"
    h, m = tag.split(":")
    minutes = int(h) * 60 + int(m)
    return position, next(name for name, upper in BANDS if minutes < upper)


def _day_json(c: DayComparison) -> dict:
    return {
        "day": c.day.isoformat(),
        "captured": c.captured,
        "failed_sections": [
            {"platform": s["platform"], "broker": s["broker"], "error": s.get("error")}
            for s in c.failed_sections
        ],
        "groups": [g.__dict__ for g in c.groups()],
        "compared": [x.__dict__ for x in c.compared],
        "no_paper": [x.variant for x in c.no_paper],
        "off_slot": [str(r.get("variant")) for r in c.off_slot],
        "open_legs": [str(r.get("variant")) for r in c.open_legs],
        "not_traded": [str(r.get("variant") or r.get("name")) for r in c.not_traded],
        "unrecognised": [str(r.get("name")) for r in c.unrecognised],
        "discretionary_count": len(c.discretionary),
        "discretionary_total": c.discretionary_total,
    }


def compare_range(
    start: date | None = None, end: date | None = None, root: Path | None = None
) -> dict:
    """Every captured day in [start, end] (default: all), each compared, plus running totals per
    platform + broker + list and slippage by shape. Read-only; the maths is `compare`'s.

    A group's running line adds up its per-lot live (after costs), paper and slippage day by day,
    over the days the group traded. Slippage by shape adds a variant's per-lot slippage over every
    day it was compared, so it counts variant-days: Quantiply has no fills, so no percentage."""
    available = captured_days(root)
    days = available
    if start is not None:
        days = [d for d in days if d >= start]
    if end is not None:
        days = [d for d in days if d <= end]
    if len(days) > MAX_RANGE_DAYS:
        days = days[-MAX_RANGE_DAYS:]
    memo: dict[str, dict[str, dict]] = {}  # each variant's result file is read once
    results = [compare(d, root, memo) for d in days]

    running: dict[tuple[str, str, str], dict] = {}
    shapes: dict[tuple[str, str, str], dict] = {}
    discretionary = Decimal(0)
    discretionary_points = []
    for c in results:
        for g in c.groups():
            key = (g.platform, g.broker, g.book or "")
            r = running.setdefault(
                key,
                {
                    "platform": g.platform,
                    "broker": g.broker,
                    "book": g.book,
                    "live": Decimal(0),
                    "paper": Decimal(0),
                    "slippage": Decimal(0),
                    "days": 0,
                    "points": [],
                },
            )
            r["live"] += _d(g.live)
            r["paper"] += _d(g.paper)
            r["slippage"] += _d(g.slippage)
            r["days"] += 1
            r["points"].append(
                {
                    "day": c.day.isoformat(),
                    "live": float(r["live"]),
                    "paper": float(r["paper"]),
                    "slippage": float(r["slippage"]),
                }
            )
        for x in c.compared:
            if x.slippage is None:
                continue
            position, band = shape_of(x.variant)
            s = shapes.setdefault(
                (x.platform, position, band),
                {
                    "platform": x.platform,
                    "position": position,
                    "band": band,
                    "n": 0,
                    "slippage": Decimal(0),
                    "premium": Decimal(0),
                    "pct_n": 0,
                },
            )
            s["n"] += 1
            s["slippage"] += _d(x.slippage)
            if x.slippage_pct is not None and x.premium_per_lot:
                s["premium"] += _d(x.premium_per_lot)
                s["pct_n"] += 1
        if c.captured:
            discretionary += _d(c.discretionary_total)
            discretionary_points.append({"day": c.day.isoformat(), "value": float(discretionary)})

    shape_rows = []
    for key in sorted(shapes):
        s = shapes[key]
        pct = None
        if s["pct_n"] == s["n"] and s["premium"]:
            pct = float(s["slippage"] / s["premium"] * 100)
        shape_rows.append(
            {
                "platform": s["platform"],
                "position": s["position"],
                "band": s["band"],
                "variant_days": s["n"],
                "slippage": float(s["slippage"]),
                "mean_slippage": float(s["slippage"] / s["n"]),
                "slippage_pct": pct,
            }
        )
    return {
        "from": days[0].isoformat() if days else None,
        "to": days[-1].isoformat() if days else None,
        "captured_days": [d.isoformat() for d in available],
        "days": [_day_json(c) for c in results],
        "running": [
            {
                **{k: v for k, v in r.items() if k not in ("live", "paper", "slippage")},
                "live": float(r["live"]),
                "paper": float(r["paper"]),
                "slippage": float(r["slippage"]),
            }
            for _, r in sorted(running.items())
        ],
        "shapes": shape_rows,
        "discretionary": {"total": float(discretionary), "points": discretionary_points},
    }


# -- text ---------------------------------------------------------------------------------------


def where(platform: str, broker: str) -> str:
    name = PLATFORM_NAMES.get(platform, platform)
    if platform == "algotest" and broker == "all":
        return name
    return f"{name} · {BROKER_NAMES.get(broker, broker)}"


def book_name(book: str | None) -> str:
    return BOOK_NAMES.get(book or "", (book or "").upper())


def _pct(value: float | None) -> str:
    if value is None:
        return ""
    sign = "+" if value > 0.05 else "−" if value < -0.05 else ""
    return f" ({sign}{abs(value):.1f}%)"


def _names(rows: list[dict]) -> str:
    return ", ".join(sorted({str(r.get("variant") or r.get("name")) for r in rows}))


def message_lines(c: DayComparison, rupees) -> list[str]:
    """The few lines the owner's 16:00 result message carries (never the group's copy).
    `rupees` formats a signed amount (`messages.rupees`). The list lines are per lot; the off-slot
    and discretionary amounts are the whole position, as traded."""
    if not c.captured:
        return ["💹 Live · not captured"]
    out = ["💹 Live vs paper"]
    for g in c.groups():
        label = f"{where(g.platform, g.broker)} {book_name(g.book)}".rstrip()
        out.append(
            f"{label}  {rupees(g.live)} vs {rupees(g.paper)} a lot · slip {rupees(g.slippage)}"
            f"{_pct(g.slippage_pct)}"
        )
    for s in c.failed_sections:
        out.append(f"{where(s['platform'], str(s['broker']))}  live not captured")
    for n in c.no_paper:
        out.append(f"{where(n.platform, n.broker)} {n.variant}  no paper result")
    if c.open_legs:
        out.append(f"⚠️ Legs still open, left out: {_names(c.open_legs)}")
    if c.not_traded:
        out.append(f"⛔ Did not trade: {_names(c.not_traded)}")
    if c.unrecognised:
        total = sum((_d(r.get("pnl")) for r in c.unrecognised if traded(r)), Decimal(0))
        out.append(
            f"❓ Unrecognised tool copy: {_names(c.unrecognised)}  {rupees(float(total))} in all"
        )
    guessed = sorted({x.variant for x in [*c.compared, *c.no_paper] if x.multiplier_guessed})
    if guessed:
        out.append(f"1x assumed (multiplier not shown by the platform): {', '.join(guessed)}")
    for o in c.off_slot:
        out.append(f"⏱ Off-slot {o.get('variant')}  {rupees(float(o.get('pnl') or 0))} in all")
    if c.discretionary:
        out.append(
            f"✋ Discretionary  {rupees(c.discretionary_total)} in all ({len(c.discretionary)})"
        )
    if len(out) == 1:
        out.append("no tool strategy ran")
    return out


def render(c: DayComparison, rupees) -> str:
    """`obt rotation live-compare`: the message lines, then every compared variant."""
    lines = [f"{c.day} live vs paper", *message_lines(c, rupees)]
    if c.compared or c.no_paper:
        lines.append("")
        for x in [*c.compared, *c.no_paper]:
            paper = "—" if x.paper is None else rupees(x.paper)
            slip = "—" if x.slippage is None else rupees(x.slippage)
            note = " (multiplier not recorded: 1x)" if x.multiplier_guessed else ""
            lines.append(
                f"{where(x.platform, x.broker)} {book_name(x.book)} {x.variant}: {x.copies} cop"
                f"{'y' if x.copies == 1 else 'ies'}, {x.lots:g} lot{'' if x.lots == 1 else 's'}, "
                f"live/lot {rupees(x.live_per_lot)} − costs {x.costs:.0f} vs paper {paper} · "
                f"slip {slip}{_pct(x.slippage_pct)}{note}"
            )
    for d in c.discretionary:
        lines.append(
            f"discretionary {where(d['platform'], str(d['broker']))} {d.get('name')}: "
            f"{rupees(float(d.get('pnl') or 0))}"
        )
    return "\n".join(lines)


def to_json(c: DayComparison) -> dict:
    return {
        "day": c.day.isoformat(),
        "captured": c.captured,
        "sections": c.sections,
        "groups": [g.__dict__ for g in c.groups()],
        "compared": [x.__dict__ for x in c.compared],
        "no_paper": [x.__dict__ for x in c.no_paper],
        "off_slot": c.off_slot,
        "open_legs": c.open_legs,
        "not_traded": c.not_traded,
        "unrecognised": c.unrecognised,
        "discretionary": c.discretionary,
        "discretionary_total": c.discretionary_total,
    }


def owner_lines(day: date, root: Path | None = None, echo=print) -> list[str] | None:
    """The live block of the owner's 16:00 message, or None before the capture has ever run (no
    `rotation/live/` folder), so nothing changes until the 15:40 job exists. A failure here never
    stops the result message: it says so in one line. The message is a snapshot: a capture that
    lands after it (a retry, a back-fill) is in `obt rotation live-compare`, not in a resend."""
    from .messages import rupees

    if not live_dir(root).exists():
        return None
    try:
        return message_lines(compare(day, root), rupees)
    except Exception as error:  # noqa: BLE001 - the result message must still go
        echo(f"live vs paper skipped: {type(error).__name__}: {error}")
        return ["💹 Live · could not be read"]
