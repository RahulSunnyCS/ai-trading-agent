"""The margin each F&O account had and needed, per trading day (BL-205 Phase 2), read-only.

Reads the brokers' daily margin statements that `packages/contract-notes` stores in
`contract-notes/margin/<day>.jsonl`, Angel One's shortfall warnings and collateral-interest
e-mails (`ledger/`), and the 15:40 live captures (`rotation/live/<day>.jsonl`) for the lots that
were open together.

- **Available** is the statement's total margin available (F); **cash** is its funds (A) plus the
  collateral that counts as cash (`cash_collateral.csv`: pledged SGBs and G-secs, liquid ETFs;
  owner 2026-11-04); the rest of the collateral is **non-cash**. The exchange's 50:50 rule asks
  for at least half the margin used in cash.
- **Peak** is the most the account needed during the day: Angel One's upfront margin (G, an
  exchange snapshot) or the largest "margin used" in its shortfall warnings that day, whichever is
  larger. Finvasia's statement gives no peak (its upfront is 0 on a day traded intraday).
- **Lots** are the most lots open at the same minute on the account's platforms (the tool's
  picks and the owner's own strategies there), from the live capture; `tool_lots` counts the
  tool's alone. A row with fills (AlgoTest) is open from its first entry to its last exit; a row
  without (Quantiply's) from the entry time in its name, or the open for the owner's own, to the
  close, so a day counted that way (`lots_from` 'schedule') can only overstate the lots open
  together and understate the per-lot figure a little. **Per lot** = peak / lots.
- **Day type**: `nifty_expiry`, `sensex_expiry`, `both_expiry` or `normal`, from the reference
  expiry calendar.

`table` keeps, per day type, the last `n` days that have a per-lot figure (Angel One's: the only
account whose statement carries a peak); Finvasia's need is inferred from it (owner's answer 2).
"""

from __future__ import annotations

import csv
import json
import re
import statistics
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from functools import cache
from pathlib import Path

from ..legwise.anatomy import dte_for
from ..rotation import live_compare
from . import store

DAY_TYPES = ("nifty_expiry", "sensex_expiry", "both_expiry", "normal")
DAY_TYPE_NAMES = {
    "nifty_expiry": "NIFTY expiry",
    "sensex_expiry": "SENSEX expiry",
    "both_expiry": "NIFTY and SENSEX expiry",
    "normal": "non-expiry",
}
#: Phase 3's defaults (owner's answers 1 and 4, 2026-11-04): Settings › Automation may change them
DEFAULT_DAYS = 6
#: the broker whose statement carries a peak requirement
PEAK_BROKER = "angelone"
#: when the capture says nothing about an exit, a leg is open until the close
CLOSE_MINUTE = 15 * 60 + 30
OPEN_MINUTE = 9 * 60 + 15
CASH_FILE = Path(__file__).with_name("cash_collateral.csv")
_ENTRY = re.compile(r"_(\d{2})(\d{2})$")


@dataclass(frozen=True)
class CashRule:
    match: str  # isin_prefix | isin | inf_name
    value: str


@cache
def cash_rules(path: Path = CASH_FILE) -> tuple[CashRule, ...]:
    with path.open() as f:
        return tuple(CashRule(r["match"], r["value"].strip().upper()) for r in csv.DictReader(f))


def is_cash(holding: dict, rules: tuple[CashRule, ...] | None = None) -> bool:
    """Whether a pledged scrip counts toward the cash half of the 50:50 rule."""
    isin = str(holding.get("isin") or "").upper()
    name = str(holding.get("name") or "").upper()
    for rule in rules if rules is not None else cash_rules():
        if rule.match == "isin_prefix" and isin.startswith(rule.value):
            return True
        if rule.match == "isin" and isin == rule.value:
            return True
        if rule.match == "inf_name" and isin.startswith("INF") and rule.value in name:
            return True
    return False


def _dec(value) -> Decimal:
    return Decimal(str(value or 0))


def split_collateral(line: dict, rules: tuple[CashRule, ...] | None = None) -> dict:
    """{'cash', 'non_cash', 'cash_holdings'} of one statement line, rupees (floats at the edge)."""
    total = line.get("total") or {}
    cash_held = [h for h in line.get("holdings") or [] if is_cash(h, rules)]
    other = [h for h in line.get("holdings") or [] if not is_cash(h, rules)]
    cash = _dec(total.get("funds")) + sum((_dec(h.get("value")) for h in cash_held), Decimal(0))
    non_cash = sum((_dec(h.get("value")) for h in other), Decimal(0))
    return {
        "cash": float(cash),
        "non_cash": float(non_cash),
        "cash_holdings": [h.get("name") for h in cash_held],
    }


def usable(available: float, cash: float) -> float:
    """What the margin available supports under a strict 50:50 rule: at most twice the cash."""
    return max(0.0, min(available, 2 * cash))


def day_type(day: date) -> str:
    """The day's type from the reference expiry calendar (0 days to expiry = an expiry day)."""
    nifty = dte_for("NIFTY", day) == 0
    sensex = dte_for("SENSEX", day) == 0
    if nifty and sensex:
        return "both_expiry"
    if nifty:
        return "nifty_expiry"
    return "sensex_expiry" if sensex else "normal"


def load_statements(root: Path) -> dict[date, list[dict]]:
    """Every stored statement line, by trade date. A damaged line is skipped."""
    out: dict[date, list[dict]] = {}
    for path in sorted((store.store_dir(root) / "margin").glob("*.jsonl")):
        try:
            day = date.fromisoformat(path.stem)
        except ValueError:
            continue
        rows = []
        for text in path.read_text(encoding="utf-8").splitlines():
            if not text.strip():
                continue
            try:
                rows.append(json.loads(text))
            except json.JSONDecodeError:
                continue
        out[day] = rows
    return out


def _minute(at: str | None) -> int | None:
    t = live_compare.ist_time(at or "")
    return None if t is None else t.hour * 60 + t.minute


def _span(row: dict) -> tuple[int, int, bool]:
    """(first minute, last minute, from fills) a capture row was open."""
    fills = row.get("fills") or []
    entries = [
        m for m in (_minute((f.get("entry") or {}).get("at")) for f in fills) if m is not None
    ]
    if entries:
        exits = [_minute((f.get("exit") or {}).get("at")) for f in fills]
        ends = [m for m in exits if m is not None]
        end = max(ends) if ends and len(ends) == len(exits) else CLOSE_MINUTE
        return min(entries), end, True
    named = _ENTRY.search(str(row.get("variant") or ""))
    start = int(named[1]) * 60 + int(named[2]) if named else OPEN_MINUTE
    return start, CLOSE_MINUTE, False


def lots_open(day: date, root: Path | None = None) -> dict[str, dict] | None:
    """{broker: {'lots', 'tool_lots', 'lots_from'}}: the most lots open at the same minute on each
    broker's platforms that day, from the live capture; None when the day was not captured.
    `lots_from` is 'fills' when every row had fill times, else 'schedule'."""
    lines = live_compare.read_lines(day, root)
    if lines is None:
        return None
    spans: dict[str, list[tuple[int, int, int, bool]]] = {}
    exact: dict[str, bool] = {}
    for row in lines:
        if row.get("kind") != "strategy" or not live_compare.traded(row):
            continue
        start, end, from_fills = _span(row)
        broker = str(row.get("broker"))
        lots = int(row.get("multiplier") or 1)
        tool = row.get("source") == "tool"
        spans.setdefault(broker, []).append((start, end, lots, tool))
        exact[broker] = exact.get(broker, True) and from_fills
    out = {}
    for broker, items in spans.items():
        points = sorted({s for s, _, _, _ in items})

        def peak(only_tool: bool, items=items, points=points) -> int:
            best = 0
            for p in points:
                open_now = sum(n for s, e, n, t in items if s <= p <= e and (t or not only_tool))
                best = max(best, open_now)
            return best

        out[broker] = {
            "lots": peak(False),
            "tool_lots": peak(True),
            "lots_from": "fills" if exact[broker] else "schedule",
        }
    return out


def _ledger_by_day(book: store.Book, kind: str) -> dict[date, list[dict]]:
    return {d: [e for e in events if e.get("kind") == kind] for d, events in book.ledger.items()}


def interest_rate(book: store.Book, upto: date | None = None) -> dict | None:
    """The newest collateral-interest e-mail's daily rate (amount / shortfall), with the month's
    interest so far: {'day', 'rate', 'amount', 'shortfall', 'month_total'}; None without one."""
    events = [
        (d, e)
        for d, es in sorted(_ledger_by_day(book, "collateral_interest").items())
        for e in es
        if (upto is None or d <= upto) and e.get("amount") and e.get("shortfall")
    ]
    if not events:
        return None
    day, last = events[-1]
    month = sum(
        (_dec(e["amount"]) for d, e in events if (d.year, d.month) == (day.year, day.month)),
        Decimal(0),
    )
    return {
        "day": day.isoformat(),
        "rate": float(_dec(last["amount"]) / _dec(last["shortfall"])),
        "amount": float(last["amount"]),
        "shortfall": float(last["shortfall"]),
        "month_total": float(month),
    }


def days(root: Path, start: date | None = None, end: date | None = None) -> list[dict]:
    """One row per stored statement (day and account), oldest first."""
    statements = load_statements(root)
    book = store.load_cached(root)
    warnings = _ledger_by_day(book, "margin_warning")
    rows = []
    for day in sorted(statements):
        if (start and day < start) or (end and day > end):
            continue
        captured = lots_open(day, root)
        for line in statements[day]:
            broker, account = line.get("broker"), line.get("account")
            total = line.get("total") or {}
            peaks = [
                float(w["margin_used"])
                for w in warnings.get(day, [])
                if w.get("broker") == broker
                and w.get("account") in (account, None)
                and w.get("margin_used") is not None
            ]
            upfront = float(total.get("upfront") or 0)
            warning_peak = max(peaks) if peaks else None
            has_peak = broker == PEAK_BROKER
            peak = max(upfront, warning_peak or 0) if has_peak else None
            mine = (
                (captured or {}).get(broker) if _trades_here(book, day, broker, account) else None
            )
            lots = mine["lots"] if mine else None
            collateral = split_collateral(line)
            available = float(total.get("available") or 0)
            rows.append(
                {
                    "day": day.isoformat(),
                    "account": f"{broker}/{account}",
                    "broker": broker,
                    "type": day_type(day),
                    "available": available,
                    "funds": float(total.get("funds") or 0),
                    "cash": collateral["cash"],
                    "non_cash": collateral["non_cash"],
                    "cash_holdings": collateral["cash_holdings"],
                    "usable": usable(available, collateral["cash"]),
                    "upfront": upfront,
                    "warning_peak": warning_peak,
                    "peak": peak,
                    "lots": lots,
                    "tool_lots": mine["tool_lots"] if mine else None,
                    "lots_from": mine["lots_from"] if mine else None,
                    "per_lot": round(peak / lots, 2) if peak and lots else None,
                    "cash_short": max(0.0, peak / 2 - collateral["cash"]) if peak else None,
                }
            )
    return rows


def _trades_here(book: store.Book, day: date, broker: str, account: str) -> bool:
    """Whether the capture's lots for `broker` are this account's: the account with the broker's
    contract note that day, or the broker's only account in the store."""
    noted = [
        ln["account"]
        for ln in book.fno_lines(day)
        if ln.get("broker") == broker and ln.get("status") == "note"
    ]
    if noted:
        return account in noted
    known = [a for a in book.accounts((broker,))]
    return len(known) <= 1


def table(rows: list[dict], n: int = DEFAULT_DAYS, broker: str = PEAK_BROKER) -> dict:
    """Per day type, the last `n` days with a per-lot figure for `broker`: {'days': [{day,
    per_lot, peak, lots}], 'max', 'median', 'count'}; a type with none has an empty list."""
    out = {}
    for kind in DAY_TYPES:
        seen = [r for r in rows if r["broker"] == broker and r["type"] == kind and r["per_lot"]]
        last = seen[-n:] if n > 0 else seen
        figures = [r["per_lot"] for r in last]
        out[kind] = {
            "days": [
                {"day": r["day"], "per_lot": r["per_lot"], "peak": r["peak"], "lots": r["lots"]}
                for r in last
            ],
            "max": max(figures) if figures else None,
            "median": statistics.median(figures) if figures else None,
            "count": len(figures),
        }
    return out


def report(
    root: Path, start: date | None = None, end: date | None = None, n: int = DEFAULT_DAYS
) -> dict:
    """What `obt realised margin` and GET /legwise/contract-notes/margin show."""
    rows = days(root, start, end)
    book = store.load_cached(root)
    return {
        "days": rows,
        "table": table(days(root, None, end), n),
        "interest": interest_rate(book, end),
        "as_of": datetime.now().isoformat(timespec="seconds"),
    }
