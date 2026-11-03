"""BL-200: the Momentum rebalance log, one block per lot per due week (Trade book › Momentum).

A view over what is already computed: `forward_run.compute_fills()` (BL-024 Phase 3) matches each
lot's due week to the Kite contract-note fills and gives every stock a status; the lot ledger
(BL-142) says what the lot held before. Pure: the caller reads the catalog and the files.

- **Week number:** from the paper start (that Friday is week 1), one per Friday.
- **Only real trades:** a block lists what the contract notes show was bought or sold, never
  what the strategy suggested (owner, 2026-11-03). A stock the orders asked for and that was not
  traded is only counted (`not_traded`), for the status.
- **Status:** `done` when every stock the signal or the 14:15 orders asked for was traded,
  `partly done` when some were, `waiting for notes` when none were and the notes for the first
  session after the Friday are not in yet (a lot is often bought on the Monday), `not done`
  otherwise.
- **Missed weeks:** a `not done` week says where it was folded in: the lot's next due week. Orders
  are not changed: a lot rebalances in full the next time it is due (owner, 2026-11-02).
- **Holding after:** the lot's shares from the ledger before that Friday, plus that week's fills.
- **Every trade of the week:** a block covers its Friday 14:00 to the next Friday 14:00 and also
  lists the fills no lot's orders claim (owner, 2026-11-02: the log shows whatever was bought or
  sold that week, in the strategy or not), as `outside` lines. They count in the week's bought and
  sold, never in the lot's status or holding.
- **Kite check:** the latest stored Kite snapshot (read-only, BL-142) against what the lots hold
  now (each lot's newest holding after, or its ledger when it has no block). Kite's holdings
  include trades the contract notes have not brought in yet, so a difference is either such a
  trade or a share no lot owns.

Every figure comes from the reconciliation; nothing here prices or plans.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from .forward_score import IST

DONE, PARTLY, WAITING, NOT_DONE = "done", "partly done", "waiting for notes", "not done"
#: A week no lot was due, shown because the account traded in it.
NO_LOT = "no lot due"
#: Stock statuses (`forward_fills._status`) that mean the stock was traded this week.
TRADED = {"done", "shares differ", "extra"}
#: A line for a fill no lot's orders claim.
OUTSIDE = "outside"
#: Ledger events that are not a booking of fills (`seed` and `attributed` book what Kite showed
#: after trades, which the week's fills already count): an owner's own correction.
CORRECTIONS = {"assigned", "manual"}
#: A day's contract note is in the mailbox by this hour (IST); a read before it does not cover
#: that day's trades.
NOTE_HOUR = 21
EPS = 1e-9


def week_number(week: str, paper_start: str) -> int:
    """The paper start's Friday is week 1; one per Friday after it."""
    return (date.fromisoformat(week) - date.fromisoformat(paper_start)).days // 7 + 1


def notes_through(cursor: dict[str, dict], fallback: str | None = None) -> str | None:
    """The last day whose Kite contract notes are surely read: the day before the Kite mailbox's
    last check, or that day once the check was made after `NOTE_HOUR`. `fallback` (the newest
    note) when the cursor has no Kite entry."""
    checked = [
        v.get("checked_at")
        for k, v in cursor.items()
        if "|kite/" in k and isinstance(v, dict) and v.get("checked_at")
    ]
    if not checked:
        return fallback
    when = datetime.fromisoformat(max(checked).replace("Z", "+00:00")).astimezone(IST)
    day = when.date() if when.hour >= NOTE_HOUR else when.date() - timedelta(days=1)
    through = day.isoformat()
    return max(through, fallback) if fallback else through


def _monday_after(week: str) -> str:
    """The first session after a Friday when no bar for it is stored yet: the Monday."""
    return (date.fromisoformat(week) + timedelta(days=3)).isoformat()


def _value(row: dict) -> float | None:
    parts = [
        (row.get("shares_first_day"), row.get("avg_first_day")),
        (row.get("shares_later"), row.get("avg_later")),
    ]
    total = sum(s * p for s, p in parts if s and p)
    return total or None


def _lines(rebalance: dict) -> list[dict]:
    """The lot's real trades of the week, from the notes; nothing the strategy only suggested."""
    return [
        {
            "symbol": row["symbol"],
            "side": row["side"],
            "shares": row["shares"],
            "value": _value(row),
            "status": row["status"],
        }
        for row in rebalance["rows"]
        if row["status"] in TRADED and row.get("shares")
    ]


def _friday_of(day: str, time: str | None) -> str:
    """The Friday whose week (its 14:00 to the next Friday's 14:00) holds this moment."""
    when = date.fromisoformat(day)
    back = (when.weekday() - 4) % 7  # days since the last Friday (0 on a Friday)
    friday = when - timedelta(days=back)
    if back == 0 and (time or "00:00") < "14:00":
        friday -= timedelta(weeks=1)
    return friday.isoformat()


def _outside_lines(fills: list[dict]) -> list[dict]:
    """The week's fills no lot claims, netted per stock and side (a buy and a later sell of the
    same stock stay two lines, so a round trip inside the week still shows)."""
    by: dict[tuple[str, str], dict] = {}
    for f in fills:
        line = by.setdefault(
            (f["symbol"], f["side"]),
            {
                "symbol": f["symbol"],
                "side": f["side"],
                "shares": 0.0,
                "value": 0.0,
                "status": OUTSIDE,
            },
        )
        line["shares"] += float(f["qty"])
        line["value"] += float(f["qty"]) * float(f["price"])
    return sorted(by.values(), key=lambda x: (x["symbol"], x["side"]))


def _add_outside(blocks: list[dict], fills: list[dict], paper_start: str) -> None:
    """Put each fill no lot claims into the block of its week; a week with no block gets one
    with no lot (nothing was due, but the account traded)."""
    by_week: dict[str, list[dict]] = defaultdict(list)
    for f in fills:
        week = _friday_of(f["day"], f.get("time"))
        if week >= paper_start:
            by_week[week].append(f)
    for week, week_fills in by_week.items():
        lines = _outside_lines(week_fills)
        block = next(
            (b for b in sorted(blocks, key=lambda b: b["lot"] or "") if b["week"] == week), None
        )
        if block is None:
            block = {
                "week": week,
                "week_no": week_number(week, paper_start),
                "lot": None,
                "sleeve_id": None,
                "new_lot": False,
                "status": NO_LOT,
                "notes_final": True,
                "first_trade_day": min(f["day"] for f in week_fills),
                "orders_at": None,
                "lines": [],
                "not_traded": 0,
                "bought": 0.0,
                "sold": 0.0,
                "charges": None,
                "holding_after": [],
                "folded_into": None,
            }
            blocks.append(block)
        block["lines"].extend(lines)
        block["bought"] += sum(x["value"] for x in lines if x["side"] == "buy")
        block["sold"] += sum(x["value"] for x in lines if x["side"] == "sell")


def _status(rows: list[dict], final: bool) -> str:
    """Done only when the fills cover every order: a stock traded in other shares than the
    orders said leaves the week partly done (owner, 2026-11-02). Outside fills never count."""
    traded = sum(1 for row in rows if row["status"] in TRADED and row.get("shares"))
    short = sum(1 for row in rows if row["status"] in ("missed", "shares differ"))
    if traded and not short:
        return DONE
    if traded:
        return PARTLY
    return NOT_DONE if final else WAITING


def _holding(events: list[dict], sleeve_id: str, week: str, lines: list[dict]) -> list[dict]:
    """The lot's shares booked before that Friday's 14:00, plus the week's fills."""
    shares: dict[str, float] = defaultdict(float)
    for event in events:
        if event["sleeve_id"] == sleeve_id and str(event["at"]) < f"{week}T14:00":
            shares[event["symbol"]] += float(event["delta"])
    for line in lines:
        if line["status"] in TRADED and line["shares"]:
            shares[line["symbol"]] += line["shares"] if line["side"] == "buy" else -line["shares"]
    return [{"symbol": s, "shares": n} for s, n in sorted(shares.items()) if n > EPS]


def _lots_now(blocks: list[dict], events: list[dict]) -> dict[str, float]:
    """What a group's lots hold now: each lot's newest holding after, plus the owner's own
    corrections booked since (`mbt lots assign`); a lot with no block, its ledger shares."""
    newest: dict[str, dict] = {}
    for block in sorted(blocks, key=lambda b: b["week"]):
        newest[block["sleeve_id"]] = block
    held: dict[str, float] = defaultdict(float)
    for block in newest.values():
        for h in block["holding_after"]:
            held[h["symbol"]] += h["shares"]
    for event in events:
        block = newest.get(event["sleeve_id"])
        if block is None or (
            event.get("kind") in CORRECTIONS and str(event["at"]) >= f"{block['week']}T14:00"
        ):
            held[event["symbol"]] += float(event["delta"])
    return held


def kite_check(kite: dict | None, held: dict[str, float]) -> dict | None:
    """The Kite snapshot (`{synced_at, holdings: {symbol: shares}, cash}`) against the lots."""
    if not kite:
        return None
    holdings = kite.get("holdings") or {}
    differences = [
        {"symbol": s, "kite": holdings.get(s, 0.0), "lots": held.get(s, 0.0)}
        for s in sorted(set(holdings) | {s for s, n in held.items() if n > EPS})
        if abs(holdings.get(s, 0.0) - held.get(s, 0.0)) > 1e-6
    ]
    return {
        "synced_at": kite.get("synced_at"),
        "cash": kite.get("cash"),
        "matches": not differences,
        "differences": differences,
    }


def build(
    groups: list[dict],
    events: dict[str, list[dict]],
    *,
    paper_start: str | None,
    notes_through: str | None,
    lots_per_group: dict[str, int],
    kite: dict | None = None,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """`groups`: `compute_fills()["groups"]`; `events`: the ledger per group id
    (`lots.history`); `lots_per_group`: how many lots each group has (one per Friday of its
    cadence). Blocks newest first, within `start`..`end` (Fridays, inclusive)."""
    out: dict[str, Any] = {
        "paper_start": paper_start,
        "notes_through": notes_through,
        "groups": [],
        "kite_check": None,
    }
    if not paper_start:
        return out
    held_now: dict[str, float] = defaultdict(float)
    for group in groups:
        every = max(1, lots_per_group.get(group["group_id"], 1))
        rebalances = group.get("rebalances", [])
        due: dict[str, list[str]] = defaultdict(list)
        for r in rebalances:
            due[r["sleeve_id"]].append(r["week"])
        blocks = []
        for r in rebalances:
            week = r["week"]
            lines = _lines(r)
            session = r.get("next_session") or _monday_after(week)
            final = bool(notes_through) and notes_through >= session
            status = _status(r["rows"], final)
            folded = None
            if status == NOT_DONE:
                later = sorted(w for w in due[r["sleeve_id"]] if w > week)
                target = (
                    later[0]
                    if later
                    else (date.fromisoformat(week) + timedelta(weeks=every)).isoformat()
                )
                folded = {
                    "week": target,
                    "week_no": week_number(target, paper_start),
                    "scheduled": not later,
                }
            blocks.append(
                {
                    "week": week,
                    "week_no": week_number(week, paper_start),
                    "lot": r["lot"],
                    "sleeve_id": r["sleeve_id"],
                    "new_lot": r.get("new_lot", False),
                    "status": status,
                    "notes_final": final,
                    "first_trade_day": r.get("first_trade_day"),
                    "orders_at": r.get("orders_at"),
                    "lines": lines,
                    "not_traded": sum(1 for row in r["rows"] if row["status"] == "missed"),
                    "bought": sum(x["value"] or 0 for x in lines if x["side"] == "buy"),
                    "sold": sum(x["value"] or 0 for x in lines if x["side"] == "sell"),
                    "charges": (r.get("totals") or {}).get("real_charges"),
                    "holding_after": _holding(
                        events.get(group["group_id"], []), r["sleeve_id"], week, lines
                    ),
                    "folded_into": folded,
                }
            )
        for symbol, shares in _lots_now(blocks, events.get(group["group_id"], [])).items():
            held_now[symbol] += shares
        _add_outside(blocks, group.get("outside_lots") or [], paper_start)
        blocks = [
            b for b in blocks if (not start or b["week"] >= start) and (not end or b["week"] <= end)
        ]
        blocks.sort(key=lambda b: (b["week"], b["lot"] or ""), reverse=True)
        out["groups"].append(
            {
                "group_id": group["group_id"],
                "name": group.get("name"),
                "lots": every,
                "blocks": blocks,
                "outside_lots": len(group.get("outside_lots") or []),
            }
        )
    out["kite_check"] = kite_check(kite, held_now)
    return out
