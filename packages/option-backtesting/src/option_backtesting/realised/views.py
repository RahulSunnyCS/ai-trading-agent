"""The Trade book's answers, as plain JSON: one function per view, shared by `obt realised`
and the `/legwise/contract-notes/*` routes so the page and the command never disagree."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from . import context, ratios, sources, store, trips


def summary(root: Path, *, start=None, end=None, account=None) -> dict:
    book = store.load(root)
    rows = ratios.daily(book, account=account, start=start, end=end)
    accounts = []
    for acc in book.accounts():
        acc_rows = ratios.daily(book, account=acc, start=start, end=end)
        s = ratios.summary(acc_rows)
        accounts.append(
            {
                "account": acc,
                **{
                    k: s[k]
                    for k in (
                        "net",
                        "charges",
                        "capital",
                        "profit_pct",
                        "charge_profit_pct",
                        "sessions",
                    )
                },
            }
        )
    last = rows[-1] if rows else None
    return {
        "summary": ratios.summary(rows),
        "ratios": None
        if last is None
        else {
            k: getattr(last, k)
            for k in (
                "avg_profit_50",
                "avg_profit_100",
                "avg_charges_100",
                "charge_profit_pct",
                "avg_capital_100",
                "profit_capital_bps",
            )
        }
        | {"day": last.day.isoformat()},
        "fiscal_years": ratios.fiscal_years(rows),
        "accounts": accounts,
        "coverage": trips.coverage(book, start=start, end=end),
        "open_days": [r.day.isoformat() for r in rows if r.open],
        "last_note_day": max(
            (
                d.isoformat()
                for d in book.days
                if any(ln.get("status") == "note" for ln in book.fno_lines(d))
            ),
            default=None,
        ),
        "problems": book.problems,
    }


def days(root: Path, *, start=None, end=None, account=None) -> dict:
    book = store.load(root)
    rows = ratios.daily(book, account=account, start=start, end=end)
    return {
        "days": [r.as_dict() | {"events": context.events(r.day)} for r in rows],
        "problems": book.problems,
    }


def months(root: Path, *, start=None, end=None, account=None) -> dict:
    book = store.load(root)
    return {"months": ratios.months(ratios.daily(book, account=account, start=start, end=end))}


def trip_rows(root: Path, *, start=None, end=None, account=None, extremes=False) -> dict:
    book = store.load(root)
    out = []
    ts = trips.trips(book, account=account, start=start, end=end)
    for t, src in zip(ts, sources.label(root, ts), strict=True):
        row = t.as_dict() | src
        if extremes:
            row |= context.trip_extremes(root, t)
        out.append(row)
    by_source: dict[str, dict] = {}
    nets: dict[str, Decimal] = {}
    for t, row in zip(ts, out, strict=True):
        s = by_source.setdefault(row["source"], {"trips": 0, "net": 0.0, "won": 0})
        if t.net is None:
            continue
        s["trips"] += 1
        nets[row["source"]] = nets.get(row["source"], Decimal(0)) + t.net
        s["net"] = float(nets[row["source"]])
        s["won"] += t.net > 0
    return {
        "trips": out,
        "by_source": by_source,
        "turnover": trips.turnover(ts),
        "coverage": trips.coverage(book, start=start, end=end),
        "trades_from": {b: d.isoformat() for b, d in trips.TRADES_FROM.items()},
        # The years whose turnover leaves out a broker's trades before its `trades_from`.
        "turnover_partial": trips.partial_years(),
    }


def day_detail(root: Path, day: date) -> dict:
    book = store.load(root)
    lines = book.lines.get(day, [])
    rows = [r for r in ratios.daily(book, end=day) if r.day == day]
    ts = trips.day_trips(book, day)
    day_trips = [
        t.as_dict() | src | context.trip_extremes(root, t)
        for t, src in zip(ts, sources.label(root, ts), strict=True)
    ]
    return {
        "day": day.isoformat(),
        "row": rows[0].as_dict() if rows else None,
        "lines": [
            {k: v for k, v in ln.items() if k not in ("trades",)}
            | {"trades": len(ln.get("trades") or [])}
            for ln in lines
        ],
        "trips": day_trips,
        "ledger": book.ledger.get(day, []),
        "manual": book.manual.get(day),
        "context": context.day_context(root, day),
    }


def money(root: Path, *, start=None, end=None) -> dict:
    book = store.load(root)
    events = [
        e
        for d in sorted(book.ledger)
        if (start is None or d >= start) and (end is None or d <= end)
        for e in book.ledger[d]
    ]
    totals: dict[str, Decimal] = {}
    for e in events:
        if e.get("amount") is not None:
            totals[e["kind"]] = totals.get(e["kind"], Decimal(0)) + Decimal(str(e["amount"]))
    return {"events": events, "totals": {k: float(v) for k, v in totals.items()}}


def momentum(root: Path, *, start=None, end=None) -> dict:
    """The Zerodha (`kite`) notes: Momentum's real buys and sells."""
    book = store.load(root)
    out = []
    for d in book.days:
        if (start and d < start) or (end and d > end):
            continue
        for ln in book.lines[d]:
            if ln.get("broker") == "kite" and ln.get("status") == "note":
                out.append(
                    {
                        "day": d.isoformat(),
                        "account": ln.get("account"),
                        "eq": ln.get("eq"),
                        "trades": ln.get("trades") or [],
                    }
                )
    return {"notes": out}
