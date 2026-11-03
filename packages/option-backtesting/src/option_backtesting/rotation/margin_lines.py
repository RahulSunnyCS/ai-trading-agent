"""The evening message's margin block (BL-205 Phase 3), the owner's copy only: for each broker
account that a Settings › Automation row uploads a list to, whether tomorrow's lots fit.

- **Lots**: the next session's expected picks (the same ones the message lists) as each platform's
  export trades them: the Dir ×2 rule when its export has it (`live_lots`), times the row's
  multiplier; rows on one account add up. A Buy add-on pick is bought, so it needs only its
  premium, not a lot's margin: it is named, not counted.
- **Needs**: the largest per-lot requirement of the last N days of tomorrow's type (NIFTY expiry,
  SENSEX expiry, both, non-expiry; `realised.margin.table`, Angel One's statements), times the
  lots, plus the buffer (Settings › Automation, default 10% and 6 days; owner 2026-11-04).
- **Free**: Angel One's 15:50 reading of its free margin when it was taken after today's close;
  otherwise the account's newest margin statement plus today's P&L from the 15:40 live capture.
- **50:50**: the exchange wants half the margin used in cash (funds, pledged SGBs and G-secs,
  liquid ETFs). Shoonya (Finvasia) is held to it strictly: its usable margin is at most twice its
  cash. Angel One's verdict is on the total, and a line says how far its cash is from half of what
  tomorrow needs and what the collateral interest on the gap costs a day.

Read-only. `owner_lines` never raises: a failure leaves the block out of the message, never the
message out."""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..realised import margin as rmargin
from ..realised import store as rstore
from . import automation_settings as auto
from . import live_compare, live_lots, messages

PLATFORM_NAMES = {"algotest": "AlgoTest", "quantiply": "Quantiply"}
LIST_NAMES = {"core": "Adaptive", "t1": "T1"}


@dataclass
class Account:
    broker: str
    lots: int = 0
    uses: list[str] = field(default_factory=list)
    #: Buy add-on picks: bought, so their premium only
    buys: int = 0


def tomorrow_lots(settings: dict, picks: dict[str, object]) -> dict[str, Account]:
    """{broker: Account}: the lots each account trades on the next session. `picks` maps a list
    (`core`, `t1`) to its `tomorrow.NextPicks` (or None when not known)."""
    out: dict[str, Account] = {}
    if not settings["masters"].get("uploads"):
        return out
    for platform in auto.PLATFORMS:
        for broker in auto.BROKERS:
            row = settings["rows"][f"{platform}.{broker}"]
            book = row.get("list")
            if not row.get("upload") or book not in ("core", "t1"):
                continue
            nxt = picks.get(book)
            if nxt is None or not hasattr(nxt, "core"):
                continue
            boost = auto.dir_boost_wanted(settings, platform, book)
            per_pick = live_lots.lots_for_day(list(nxt.core), nxt.dte, on=boost)
            multiplier = int(row.get("multiplier") or 1)
            lots = sum(per_pick.values()) * multiplier
            acc = out.setdefault(broker, Account(broker))
            acc.lots += lots
            if auto.addon_wanted(settings, platform, book):
                acc.buys += len(nxt.buy) * multiplier
            acc.uses.append(f"{LIST_NAMES[book]} {lots} lots ({PLATFORM_NAMES[platform]})")
    return out


def day_pnl(day: date, root: Path | None) -> dict[str, float] | None:
    """{broker: rupees} the live capture saw trade on `day`; None when not captured."""
    lines = live_compare.read_lines(day, root)
    if lines is None:
        return None
    out: dict[str, float] = {}
    for row in lines:
        if (
            row.get("kind") == "strategy"
            and live_compare.traded(row)
            and row.get("pnl") is not None
        ):
            broker = str(row.get("broker"))
            out[broker] = out.get(broker, 0.0) + float(row["pnl"])
    return out


def pnl_since(after: date, today: date, root: Path | None) -> tuple[dict[str, float], bool]:
    """({broker: rupees} the captures saw from the day after `after` to `today`, whether every
    trading day in between was captured). A statement older than yesterday's needs every day
    since it, not only today's."""
    from ..data.reference.loader import default_reference_data

    total: dict[str, float] = {}
    complete = True
    ref = default_reference_data()
    d = after
    while d < today:
        d = date.fromordinal(d.toordinal() + 1)
        if d.weekday() >= 5 or ref.is_holiday(d):
            continue
        day = day_pnl(d, root)
        if day is None:
            complete = False
            continue
        for broker, value in day.items():
            total[broker] = total.get(broker, 0.0) + value
    return total, complete


def _latest_statement(rows: list[dict], broker: str, today: date) -> dict | None:
    """The account's newest statement row on or before `today` (the trading account's when the
    broker has several: the one Phase 2 found trading, else the largest)."""
    mine = [r for r in rows if r["broker"] == broker and r["day"] <= today.isoformat()]
    if not mine:
        return None
    newest = max(r["day"] for r in mine)
    same = [r for r in mine if r["day"] == newest]
    traded = [r for r in mine if r["lots"]]
    if traded:
        account = traded[-1]["account"]
        pick = [r for r in same if r["account"] == account]
        if pick:
            return pick[0]
    return max(same, key=lambda r: r["available"])


def _angel_reading(book: rstore.Book, nxt: date, today: date) -> float | None:
    """Angel One's free margin as the 15:50 job read it after today's close (recorded as the next
    session's capital), or None."""
    manual = book.manual.get(nxt) or {}
    value = (manual.get("capital") or {}).get("angelone")
    read_at = ((manual.get("capital_read_at") or {}).get("angelone") or {}).get("after_close_of")
    return float(value) if value is not None and read_at == today.isoformat() else None


@dataclass
class Verdict:
    broker: str
    lots: int
    buys: int
    uses: list[str]
    per_lot: float | None
    per_lot_note: str
    needs: float | None
    free: float | None
    free_note: str
    cash: float | None
    usable: float | None
    fits: bool | None
    spare: float | None
    lots_that_fit: int | None
    cash_short: float | None = None
    interest_day: float | None = None


def assess(
    today: date,
    nxt: date,
    accounts: dict[str, Account],
    root: Path,
    buffer_pct: int,
    days: int,
) -> tuple[str, list[Verdict], dict | None]:
    """(tomorrow's type, one verdict per account, the interest rate) for the block."""
    rows = rmargin.days(root, None, today)
    table = rmargin.table(rows, days)
    kind = rmargin.day_type(nxt)
    book = rstore.load_cached(root)
    rate = rmargin.interest_rate(book, today)
    out = []
    for broker, acc in accounts.items():
        t = table[kind]
        if t["max"]:
            per_lot = t["max"]
            note = (
                f"the most on the last {t['count']} {_type_name(kind)} days"
                if t["count"] > 1
                else f"the one {_type_name(kind)} day so far"
            )
        else:
            others = [v["max"] for v in table.values() if v["max"]]
            per_lot = max(others) if others else None
            note = f"no {_type_name(kind)} day yet: the most of any day type"
        needs = per_lot * acc.lots * (1 + buffer_pct / 100) if per_lot else None
        stmt = _latest_statement(rows, broker, today)
        free, free_note, cash = None, "no margin statement yet", None
        if stmt:
            moved, complete = pnl_since(date.fromisoformat(stmt["day"]), today, root)
            change = moved.get(broker, 0.0)
            cash = stmt["cash"] + change
            free = stmt["available"] + change
            free_note = f"{_short(stmt['day'])} statement"
            if stmt["day"] < today.isoformat():
                yesterday_only = _previous_session(today) <= date.fromisoformat(stmt["day"])
                since = "today" if yesterday_only else f"since {_short(stmt['day'])}"
                free_note += f", {since} {messages.rupees(change)}"
                if not complete:
                    free_note += " (a day's P&L not captured)"
        reading = _angel_reading(book, nxt, today) if broker == "angelone" else None
        if reading is not None:
            free, free_note = reading, "15:50 reading"
        usable = None
        if free is not None:
            usable = (
                rmargin.usable(free, cash) if broker == "finvasia" and cash is not None else free
            )
        fits = spare = fit_lots = None
        if needs is not None and usable is not None:
            fits = usable >= needs
            spare = usable - needs
            fit_lots = math.floor(usable / (per_lot * (1 + buffer_pct / 100)))
        verdict = Verdict(
            broker,
            acc.lots,
            acc.buys,
            acc.uses,
            per_lot,
            note,
            needs,
            free,
            free_note,
            cash,
            usable,
            fits,
            spare,
            fit_lots,
        )
        if broker == "angelone" and needs is not None and cash is not None:
            verdict.cash_short = max(0.0, needs / 2 - cash)
            if rate:
                verdict.interest_day = verdict.cash_short * rate["rate"]
        out.append(verdict)
    return kind, out, rate


def _previous_session(day: date) -> date:
    from ..data.reference.loader import default_reference_data

    ref = default_reference_data()
    d = date.fromordinal(day.toordinal() - 1)
    while d.weekday() >= 5 or ref.is_holiday(d):
        d = date.fromordinal(d.toordinal() - 1)
    return d


def _short(day: str) -> str:
    """'2026-11-02' -> '2 Nov'."""
    d = date.fromisoformat(day)
    return f"{d.day} {d:%b}"


def _type_name(kind: str) -> str:
    return rmargin.DAY_TYPE_NAMES[kind]


def render(
    nxt: date, kind: str, verdicts: list[Verdict], rate: dict | None, buffer_pct: int
) -> list[str]:
    lakhs = messages.lakhs
    lines = [f"🏦 Margin for {nxt:%a} {nxt.day} {nxt:%b} ({_type_name(kind)})"]
    for v in verdicts:
        name = auto.BROKER_NAMES.get(v.broker, v.broker)
        buys = f" · {v.buys} Buy add-on (premium only)" if v.buys else ""
        lines.append(f"{name} · {' + '.join(v.uses)}{buys}")
        if v.needs is None:
            lines.append("  no per-lot figure yet (no Angel One statement with lots captured)")
        else:
            lines.append(
                f"  needs ≈ {lakhs(v.needs)}: {v.lots} × {lakhs(v.per_lot)} a lot "
                f"({v.per_lot_note}) +{buffer_pct}%"
            )
        if v.free is None:
            lines.append(f"  free: {v.free_note}")
            continue
        free = f"  free {lakhs(v.free)} ({v.free_note})"
        if v.broker == "finvasia" and v.cash is not None:
            free += f" · cash {lakhs(max(v.cash, 0))}, so {lakhs(v.usable)} usable under 50:50"
        lines.append(free)
        if v.fits is True:
            lines.append(f"  ✅ fits, {lakhs(v.spare)} spare")
        elif v.fits is False:
            lines.append(f"  ⚠️ short {lakhs(-v.spare)} · {max(v.lots_that_fit, 0)} lots fit")
        if v.cash_short is not None:
            wanted = v.needs / 2
            if v.cash_short <= 0:
                lines.append(f"  cash {lakhs(v.cash)} covers half of it (50:50) ✅")
            else:
                per_day = messages.rupees(v.interest_day or 0).lstrip("+")
                cost = f" to clear about {per_day} a day of interest" if v.interest_day else ""
                lines.append(
                    f"  cash {lakhs(max(v.cash, 0))} of the {lakhs(wanted)} 50:50 wants: "
                    f"add {lakhs(v.cash_short)}{cost}"
                )
    if rate and rate.get("month_total"):
        lines.append(
            f"Collateral interest this month {messages.rupees(rate['month_total']).lstrip('+')}"
        )
    lines.append("Your own strategies on these accounts come on top of these needs.")
    return lines


def compact(lines: list[str]) -> list[str]:
    """The block in one line per account, for a message that would pass Telegram's limit whole:
    the heading, each account's name with its verdict, and the closing note."""
    out = [lines[0]]
    name = None
    for line in lines[1:-1]:
        if not line.startswith("  "):
            name = line.split(" · ")[0]
        elif name and ("✅ fits" in line or "⚠️ short" in line):
            out.append(f"{name}: {line.strip()}")
    return out + [lines[-1]]


def owner_lines(
    today: date,
    picks: dict[str, object],
    root: Path | None = None,
    echo: Callable[[str], None] = print,
    settings: dict | None = None,
) -> list[str] | None:
    """The block for the owner's evening message, or None (nothing uploads, no picks, or a
    failure, which is logged and never stops the message)."""
    try:
        from ..fyers.daily import data_dir

        root = root or data_dir()
        if settings is None:
            settings, _ = auto.read()
        nxt = next((p.day for p in picks.values() if hasattr(p, "day")), None)
        if nxt is None:
            return None
        if auto.paused_for(settings, nxt.isoformat()):
            return [
                f"🏦 Margin for {nxt:%a} {nxt.day} {nxt:%b}: uploads are paused, nothing to check"
            ]
        accounts = tomorrow_lots(settings, picks)
        if not accounts or not rmargin.load_statements(root):
            return None  # nothing uploads, or no margin statement has been read yet
        cfg = auto.margin(settings)
        kind, verdicts, rate = assess(today, nxt, accounts, root, cfg["bufferPct"], cfg["days"])
        return render(nxt, kind, verdicts, rate, cfg["bufferPct"])
    except Exception as error:  # noqa: BLE001 - the block must never hold the message back
        echo(f"margin block skipped: {type(error).__name__}: {error}")
        return None
