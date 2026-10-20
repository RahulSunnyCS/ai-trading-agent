"""BL-141 Phase 3: the day's live results beside the paper ones.

The 15:40 capture (`packages/broker-login/src/live-capture.ts`) writes
`TRADING_DATA_ROOT/rotation/live/<day>.jsonl`: a `section` line per platform + broker it read and a
`strategy` line per strategy that ran, the tool's (`source: tool`, with its rotation `variant`) or
the owner's own (`discretionary`). Live ₹ is gross, as the platforms show it.

For each tool variant on a platform + broker, every copy that ran is put together:

- per lot = live ₹ of the copies ÷ their multipliers added up (two copies at 1x = 2 lots, so a copy
  the owner runs on purpose is a count, never slippage);
- paper = the engine's result for that variant and day at one lot (`rotation/results`, or the T1
  track's), after its estimated costs; the same costs are taken off live;
- **slippage ₹ per lot = live per lot − paper per lot**, signed: + live did better than paper;
- slippage % = that gap as a share of the entry premium per lot, where the fills are known.

A copy whose first fill is away from the variant's entry minute (deployed late, say) is not the
backtested trade: it is listed apart as off-slot and left out of the slippage. Discretionary lines
are summed on their own and never compared with anything.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import labels, store

PLATFORM_NAMES = {"algotest": "AlgoTest", "quantiply": "Quantiply"}
BROKER_NAMES = {"finvasia": "Shoonya", "angelone": "Angel One"}
BOOK_NAMES = {"t1": "T1", "core": "Core"}
#: minutes a first fill may sit before the entry minute (AlgoTest enters at hh:mm−1:59) or after it
EARLY_MINUTES = 2
LATE_MINUTES = 3


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


def paper_row(variant: str, day: date, root: Path | None = None) -> dict[str, float] | None:
    """{net, gross, costs} of a variant's stored result for the day, at one lot, or None."""
    path = store.result_path(variant, root)
    if not path.exists():
        return None
    with path.open() as f:
        for r in csv.DictReader(f):
            if r["day"] == day.isoformat():
                return {k: float(r[k] or 0) for k in ("net", "gross", "costs")}
    return None


def _minutes(hhmm: str) -> int | None:
    try:
        h, m = hhmm.split(":")[:2]
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def off_slot(line: dict) -> bool:
    """Whether a tool copy's first fill is away from its variant's entry minute. Unknown (no fills,
    no slot in the id) counts as on the slot; a range-breakout buy may enter any time after it."""
    fills = line.get("fills") or []
    times = [str((f.get("entry") or {}).get("at", "")) for f in fills]
    times = [t[11:16] for t in times if len(t) >= 16]
    slot = _minutes(labels.slot(line.get("variant") or ""))
    first = _minutes(min(times)) if times else None
    if slot is None or first is None:
        return False
    if first < slot - EARLY_MINUTES:
        return True
    try:
        breakout = labels.breakout_note(line["variant"]) is not None
    except Exception:  # noqa: BLE001 - an unknown strategy file: judge by time only
        breakout = False
    return not breakout and first > slot + LATE_MINUTES


def _entry_premium(lines: list[dict]) -> float | None:
    """₹ of premium at entry over the copies (price x quantity of every filled leg), or None when
    a copy's fills are unknown."""
    total = 0.0
    for line in lines:
        fills = line.get("fills")
        if not fills:
            return None
        for f in fills:
            entry = f.get("entry") or {}
            total += float(entry.get("price") or 0) * float(f.get("qty") or 0)
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
    #: entry premium in rupees per lot (price x quantity of the filled legs), when fills are known
    premium_per_lot: float | None = None
    #: a copy had no multiplier recorded (counted as 1x)
    multiplier_guessed: bool = False
    open_legs: int = 0


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
    discretionary: list[dict] = field(default_factory=list)

    @property
    def discretionary_total(self) -> float:
        return sum(float(d.get("pnl") or 0) for d in self.discretionary)

    @property
    def failed_sections(self) -> list[dict]:
        return [s for s in self.sections if not s.get("ok")]

    def groups(self) -> list[Group]:
        keyed: dict[tuple[str, str, str | None], list[Compared]] = {}
        for c in self.compared:
            keyed.setdefault((c.platform, c.broker, c.book), []).append(c)
        out = []
        for (platform, broker, book), items in sorted(keyed.items(), key=lambda kv: str(kv[0])):
            live = sum(c.live_per_lot - c.costs for c in items)
            paper = sum(c.paper or 0 for c in items)
            slip = sum(c.slippage or 0 for c in items)
            premiums = [c.premium_per_lot for c in items]
            pct = None
            if all(p for p in premiums):
                pct = slip / sum(p for p in premiums if p) * 100
            out.append(Group(platform, broker, book, live, paper, slip, pct, len(items)))
        return out


def compare(day: date, root: Path | None = None) -> DayComparison:
    lines = read_lines(day, root)
    if lines is None:
        return DayComparison(day, captured=False)
    result = DayComparison(day, captured=True)
    result.sections = [r for r in lines if r["kind"] == "section"]
    tool: dict[tuple[str, str, str], list[dict]] = {}
    for r in lines:
        if r["kind"] != "strategy":
            continue
        if r.get("source") != "tool" or not r.get("variant"):
            result.discretionary.append(r)
        elif off_slot(r):
            result.off_slot.append(r)
        else:
            tool.setdefault((r["platform"], str(r["broker"]), r["variant"]), []).append(r)
    for (platform, broker, variant), copies in sorted(tool.items()):
        multipliers = [c.get("multiplier") for c in copies]
        lots = float(sum(m if isinstance(m, (int, float)) and m > 0 else 1 for m in multipliers))
        live = sum(float(c.get("pnl") or 0) for c in copies)
        per_lot = live / lots if lots else 0.0
        paper = paper_row(variant, day, root)
        costs = paper["costs"] if paper else 0.0
        premium = _entry_premium(copies)
        premium_per_lot = premium / lots if premium and lots else None
        slip = (per_lot - costs) - paper["net"] if paper else None
        pct = slip / premium_per_lot * 100 if slip is not None and premium_per_lot else None
        item = Compared(
            platform=platform,
            broker=broker,
            book=copies[0].get("book"),
            variant=variant,
            copies=len(copies),
            lots=lots,
            live=live,
            live_per_lot=per_lot,
            paper=paper["net"] if paper else None,
            costs=costs,
            slippage=slip,
            slippage_pct=pct,
            premium_per_lot=premium_per_lot,
            multiplier_guessed=any(not isinstance(m, (int, float)) for m in multipliers),
            open_legs=sum(int(c.get("open_legs") or 0) for c in copies),
        )
        (result.compared if paper else result.no_paper).append(item)
    return result


# -- text ---------------------------------------------------------------------------------------


def where(platform: str, broker: str) -> str:
    name = PLATFORM_NAMES.get(platform, platform)
    if platform == "algotest" and broker == "all":
        return name
    return f"{name} · {BROKER_NAMES.get(broker, broker)}"


def _pct(value: float | None) -> str:
    if value is None:
        return ""
    sign = "+" if value > 0.05 else "−" if value < -0.05 else ""
    return f" ({sign}{abs(value):.1f}%)"


def message_lines(c: DayComparison, rupees) -> list[str]:
    """The few lines the owner's 16:00 result message carries (never the group's copy).
    `rupees` formats a signed amount (`messages.rupees`)."""
    head = "💹 Live vs paper · per lot"
    if not c.captured:
        return ["💹 Live · not captured"]
    out = [head]
    for g in c.groups():
        label = f"{where(g.platform, g.broker)} {BOOK_NAMES.get(g.book or '', '')}".rstrip()
        out.append(
            f"{label}  {rupees(g.live)} vs {rupees(g.paper)} · slip {rupees(g.slippage)}"
            f"{_pct(g.slippage_pct)}"
        )
    for s in c.failed_sections:
        out.append(f"{where(s['platform'], str(s['broker']))}  live not captured")
    for n in c.no_paper:
        out.append(f"{where(n.platform, n.broker)} {n.variant}  no paper result")
    for o in c.off_slot:
        out.append(f"⏱ Off-slot {o.get('variant')}  {rupees(float(o.get('pnl') or 0))}")
    if c.discretionary:
        out.append(f"✋ Discretionary  {rupees(c.discretionary_total)} ({len(c.discretionary)})")
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
            if x.open_legs:
                note += f" ({x.open_legs} legs open when read)"
            lines.append(
                f"{where(x.platform, x.broker)} {x.variant}: {x.copies} cop"
                f"{'y' if x.copies == 1 else 'ies'}, {x.lots:g} lot{'' if x.lots == 1 else 's'}, "
                f"live/lot "
                f"{rupees(x.live_per_lot)} − costs {x.costs:.0f} vs paper {paper} · slip {slip}"
                f"{_pct(x.slippage_pct)}{note}"
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
        "discretionary": c.discretionary,
        "discretionary_total": c.discretionary_total,
    }


def owner_lines(day: date, root: Path | None = None, echo=print) -> list[str] | None:
    """The live block of the owner's 16:00 message, or None before the capture has ever run (no
    `rotation/live/` folder), so nothing changes until the 15:40 job exists. A failure here never
    stops the result message: it says so in one line."""
    from .messages import rupees

    if not live_dir(root).exists():
        return None
    try:
        return message_lines(compare(day, root), rupees)
    except Exception as error:  # noqa: BLE001 - the result message must still go
        echo(f"live vs paper skipped: {type(error).__name__}: {error}")
        return ["💹 Live · could not be read"]
