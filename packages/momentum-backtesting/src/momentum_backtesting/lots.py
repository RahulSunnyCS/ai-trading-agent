"""The lot ledger and per-lot orders (BL-142 Phases 2-3).

The owner follows a favourite group that has one sleeve per Friday (BL-087) with one real lot per
sleeve: about Rs 50,000 a week into the next sleeve, each rebalanced on its own calendar. Kite
shows one combined holding per stock, so this module keeps which shares belong to which lot.

- **The ledger** (`momentum_lot_events`, append-only) books shares to a lot. `reconcile` compares
  what Kite holds with what the ledger has booked and books each difference to the lot whose
  orders were made last (the owner trades on Monday what Friday's orders said), but only for a
  name that lot may hold (its target, or what it already holds). Any other difference is returned
  as *unexplained* and booked to nothing; the owner assigns it (`mbt lots assign`). A guess here
  would put shares in the wrong lot, and the wrong lot is then sold at its next rebalance.
- **The orders** (`plan_lots`): every lot is planned on its own, from its own shares and its own
  sleeve's target. Only a due lot trades. Any other lot sells only the names its sleeve marks SELL
  this week (a forced exit): never a difference from the model, because the owner's real holdings
  differ from the model on purpose (a swap for a name a gate blocked, whole shares).
  A lot that holds nothing yet is a *new lot*: it is funded with the weekly lot size (or all the
  free cash when that is more) and the plan says what to add to Kite. A rebalancing lot gets its
  own shares plus the free cash left over.

Pure arithmetic and storage; no network. Callers pass a connection from `db_read` and keep it
short (the package's catalog rule).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import duckdb

from . import orders
from .orders import OrderPlan, OrderRow

EPS = 1e-6


# ---------------------------------------------------------------------------------------- storage


def positions(
    con: duckdb.DuckDBPyConnection, who: str, group_id: str
) -> dict[str, dict[str, float]]:
    """`{sleeve_id: {symbol: shares}}`, the sum of every lot's events; empty holdings dropped."""
    rows = con.execute(
        "SELECT sleeve_id, symbol, sum(delta) FROM momentum_lot_events "
        "WHERE owner = ? AND group_id = ? GROUP BY sleeve_id, symbol",
        [who, group_id],
    ).fetchall()
    out: dict[str, dict[str, float]] = {}
    for sleeve_id, symbol, shares in rows:
        if shares > EPS:
            out.setdefault(sleeve_id, {})[symbol] = float(shares)
    return out


def has_ledger(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM momentum_lot_events WHERE owner = ? AND group_id = ?",
            [who, group_id],
        ).fetchone()[0]
    )


def append(
    con: duckdb.DuckDBPyConnection,
    who: str,
    group_id: str,
    events: list[dict[str, Any]],
    at: str,
) -> None:
    """Add events (`sleeve_id`, `symbol`, `delta`, `kind`, optional `note`), all at `at`."""
    for event in events:
        con.execute(
            "INSERT INTO momentum_lot_events "
            "(owner, group_id, sleeve_id, symbol, delta, booked_at, kind, note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                who,
                group_id,
                event["sleeve_id"],
                event["symbol"],
                float(event["delta"]),
                at,
                event["kind"],
                event.get("note"),
            ],
        )


def clear(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> None:
    con.execute("DELETE FROM momentum_lot_events WHERE owner = ? AND group_id = ?", [who, group_id])
    con.execute("DELETE FROM momentum_lot_state WHERE owner = ? AND group_id = ?", [who, group_id])


def funded(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> set[str]:
    """Lots that have ever held a share: a due lot is *new* only if it is not in here (one that
    sold out, or went to cash, is rebalanced, never funded as if it were the first week)."""
    rows = con.execute(
        "SELECT DISTINCT sleeve_id FROM momentum_lot_events WHERE owner = ? AND group_id = ?",
        [who, group_id],
    ).fetchall()
    return {r[0] for r in rows}


def pending_state(
    con: duckdb.DuckDBPyConnection, who: str, group_id: str
) -> tuple[str | None, dict[str, dict[str, float]]]:
    """The lot whose orders were made last, and what each lot was told to trade then
    (`{sleeve_id: {symbol: signed shares}}`)."""
    row = con.execute(
        "SELECT pending_sleeve_id, planned FROM momentum_lot_state "
        "WHERE owner = ? AND group_id = ?",
        [who, group_id],
    ).fetchone()
    if not row:
        return None, {}
    return row[0], json.loads(row[1]) if row[1] else {}


def pending(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> str | None:
    return pending_state(con, who, group_id)[0]


def set_pending(
    con: duckdb.DuckDBPyConnection,
    who: str,
    group_id: str,
    sleeve_id: str | None,
    at: str,
    planned: dict[str, dict[str, float]] | None = None,
) -> None:
    con.execute(
        "INSERT OR REPLACE INTO momentum_lot_state "
        "(owner, group_id, pending_sleeve_id, planned, updated_at) VALUES (?, ?, ?, ?, ?)",
        [who, group_id, sleeve_id, json.dumps(planned or {}), at],
    )


def history(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT booked_at, sleeve_id, symbol, delta, kind, note FROM momentum_lot_events "
        "WHERE owner = ? AND group_id = ? ORDER BY booked_at, sleeve_id, symbol",
        [who, group_id],
    ).fetchall()
    return [
        {"at": a, "sleeve_id": s, "symbol": y, "delta": d, "kind": k, "note": n}
        for a, s, y, d, k, n in rows
    ]


# ------------------------------------------------------------------------------------ reconcile


@dataclass
class Reconciled:
    events: list[dict[str, Any]] = field(default_factory=list)
    unexplained: list[dict[str, Any]] = field(default_factory=list)


def _note_beyond(planned: dict[str, dict[str, float]] | None) -> str | None:
    return "beyond the planned orders" if planned else None


def reconcile(
    held: dict[str, float],
    ledger: dict[str, dict[str, float]],
    pending_id: str | None,
    allowed: dict[str, set[str]],
    planned: dict[str, dict[str, float]] | None = None,
    ignore: set[str] | frozenset[str] = frozenset(),
) -> Reconciled:
    """Book what changed in Kite's holdings (`held`: base symbol -> shares, the strategy's names
    only) to the lots.

    The last orders said what each lot should trade (`planned`: lot -> symbol -> signed shares).
    A change is booked against those quantities first: a purchase to the lots that were told to buy
    that stock, a sale to the lots told to sell it (so a forced exit in one lot is never booked to
    another). What is left is the owner's own trade: a purchase goes to the lot whose orders were
    made last (`pending_id`) when it may hold the name (`allowed[lot]`: its target and its current
    holdings), a sale to the lot that holds the name (that lot first, else the only holder). Any
    other difference is `unexplained`: nothing is booked, so nothing is guessed.

    `ignore`: symbols Kite still holds that are not in `held` (outside the strategy today, or
    excluded). The ledger cannot tell a sale from a name dropping out of the data, so these are
    never booked as sold."""
    result = Reconciled()
    plan = planned or {}
    note = _note_beyond(plan)
    symbols = sorted(set(held) | {s for lot in ledger.values() for s in lot})
    for symbol in symbols:
        if symbol in ignore and symbol not in held:
            continue
        booked = sum(lot.get(symbol, 0.0) for lot in ledger.values())
        delta = held.get(symbol, 0.0) - booked
        if abs(delta) < EPS:
            continue
        involved = [sid for sid, p in plan.items() if abs(p.get(symbol, 0.0)) > EPS]
        # One order a stock: the orders asked for the lots' trades netted (lot 2 buys 73 while lot
        # 1 sells 20: BUY 53). When Kite moved by exactly that, every lot did what it was told.
        if len(involved) > 1 and abs(delta - sum(plan[sid][symbol] for sid in involved)) < EPS:
            full = [
                (sid, plan[sid][symbol])
                for sid in involved
                if plan[sid][symbol] > 0
                or ledger.get(sid, {}).get(symbol, 0.0) + plan[sid][symbol] > -EPS
            ]
            if len(full) == len(involved):
                for sid, qty in full:
                    result.events.append(
                        {"sleeve_id": sid, "symbol": symbol, "delta": qty, "kind": "attributed"}
                    )
                continue
        order = sorted(set(plan) | set(ledger), key=lambda sid: (sid != pending_id, sid))
        if delta > 0:
            left = delta
            for sid in order:
                want = plan.get(sid, {}).get(symbol, 0.0)
                if want > EPS and left > EPS:
                    take = min(left, want)
                    result.events.append(
                        {"sleeve_id": sid, "symbol": symbol, "delta": take, "kind": "attributed"}
                    )
                    left -= take
            if left > EPS:
                if pending_id and symbol in allowed.get(pending_id, set()):
                    event = {
                        "sleeve_id": pending_id,
                        "symbol": symbol,
                        "delta": left,
                        "kind": "attributed",
                    }
                    if note:
                        event["note"] = note
                    result.events.append(event)
                else:
                    result.unexplained.append(
                        {
                            "symbol": symbol,
                            "delta": left,
                            "reason": "bought, and the pending lot cannot hold it",
                        }
                    )
            continue
        left = -delta
        for sid in order:
            want = -plan.get(sid, {}).get(symbol, 0.0)
            have = ledger.get(sid, {}).get(symbol, 0.0)
            if want > EPS and have > EPS and left > EPS:
                take = min(left, want, have)
                result.events.append(
                    {"sleeve_id": sid, "symbol": symbol, "delta": -take, "kind": "attributed"}
                )
                left -= take
        if left < EPS:
            continue
        remaining = {sid: lot[symbol] for sid, lot in ledger.items() if lot.get(symbol, 0) > EPS}
        for event in result.events:  # shares already booked as sold above are no longer held
            if event["symbol"] == symbol and event["delta"] < 0:
                remaining[event["sleeve_id"]] = (
                    remaining.get(event["sleeve_id"], 0.0) + event["delta"]
                )
        holders = sorted(
            ((sid, q) for sid, q in remaining.items() if q > EPS),
            key=lambda h: (h[0] != pending_id, h[0]),
        )
        if len(holders) > 1 and holders[0][0] != pending_id:
            result.unexplained.append(
                {"symbol": symbol, "delta": -left, "reason": "sold, and several lots hold it"}
            )
            continue
        for sleeve_id, shares in holders[:1]:
            take = min(left, shares)
            event = {"sleeve_id": sleeve_id, "symbol": symbol, "delta": -take, "kind": "attributed"}
            if note:
                event["note"] = note
            result.events.append(event)
            left -= take
        if left > EPS:
            result.unexplained.append(
                {"symbol": symbol, "delta": -left, "reason": "sold more than the lot holds"}
            )
    return result


def apply(
    ledger: dict[str, dict[str, float]], events: list[dict[str, Any]]
) -> dict[str, dict[str, float]]:
    """`ledger` with `events` added (a new dict; empty holdings dropped)."""
    out = {sid: dict(lot) for sid, lot in ledger.items()}
    for event in events:
        lot = out.setdefault(event["sleeve_id"], {})
        lot[event["symbol"]] = lot.get(event["symbol"], 0.0) + float(event["delta"])
    trimmed = {sid: {s: q for s, q in lot.items() if q > EPS} for sid, lot in out.items()}
    return {sid: lot for sid, lot in trimmed.items() if lot}


# --------------------------------------------------------------------------------------- planning


@dataclass
class Lot:
    """One lot as the planner sees it."""

    id: str  # the sleeve's saved-run id
    label: str  # "Lot 2"
    name: str  # the sleeve's name as the page shows it
    due: bool  # this sleeve rebalances this Friday
    next_due: str | None  # its next rebalance Friday after this one (or this one if not yet)
    positions: dict[str, float]  # base symbol -> shares, from the ledger
    target: dict[str, float]  # strategy name -> weight of the lot, cash and idle left out
    exits: frozenset[str] = frozenset()  # names the sleeve marks SELL this week (forced exits)
    #: has the lot ever held a share? None = unknown: then "holds nothing" means new (tests).
    has_history: bool | None = None


def plan_lots(
    lots: list[Lot],
    *,
    name_of: dict[str, str],
    prices: dict[str, float],
    free_cash: float,
    lot_size: float,
    min_trade_rs: float,
    blocked: set[str] | frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Orders for every lot. Returns `{"lots": [...], "deposit_needed", "free_cash", "plan"}`:
    one entry per lot (its own `plan`, or None when it does nothing this week), and `plan` the
    sum of them in `OrderPlan.to_dict` shape with a `lot` label on each row."""

    def held_names(lot: Lot) -> tuple[dict[str, float], list[str]]:
        mapped: dict[str, float] = {}
        outside: list[str] = []
        for symbol, shares in lot.positions.items():
            name = name_of.get(symbol)
            if name is None:
                outside.append(symbol)
            else:
                mapped[name] = mapped.get(name, 0.0) + shares
        return mapped, sorted(outside)

    held = {lot.id: held_names(lot) for lot in lots}
    due = [lot for lot in lots if lot.due]

    def is_new(lot: Lot) -> bool:
        if lot.has_history is not None:
            return not lot.has_history
        return not held[lot.id][0]

    new = [lot for lot in due if is_new(lot)]
    rebalancing = [lot for lot in due if not is_new(lot)]

    # Free cash goes first to a new lot (at least the weekly lot size, or all of it when it is
    # more and nothing else is due), then to the lots that rebalance, by the value they hold.
    budget: dict[str, float] = {}
    pool = max(0.0, free_cash)
    for lot in new:
        alone = len(new) == 1 and not rebalancing
        budget[lot.id] = max(lot_size, pool) if alone else lot_size
    spent = sum(budget.values())
    deposit_needed = max(0.0, spent - pool)
    left = max(0.0, pool - spent)
    values = {
        lot.id: sum(shares * prices.get(name, 0.0) for name, shares in held[lot.id][0].items())
        for lot in rebalancing
    }
    total_value = sum(values.values())
    for lot in rebalancing:
        # by the value each holds; a lot that holds nothing now (it sold out) shares evenly
        share = values[lot.id] / total_value if total_value > 0 else 1 / len(rebalancing)
        budget[lot.id] = left * share

    results: list[dict[str, Any]] = []
    for lot in lots:
        mapped, outside = held[lot.id]
        blocked_names = {n for n in set(mapped) | set(lot.target) if n in blocked}
        plan: OrderPlan | None = None
        status = "not due"
        if lot.due:
            status = "new" if lot in new else "rebalance"
            plan = orders.plan(
                mapped,
                prices,
                lot.target,
                cash=budget[lot.id],
                min_trade_rs=min_trade_rs,
                blocked=blocked_names,
            )
        elif any(name in mapped for name in lot.exits):
            # Sell the whole of what the sleeve marks SELL, whatever else it holds.
            leaving = {name: shares for name, shares in mapped.items() if name in lot.exits}
            plan = orders.plan(
                leaving, prices, {}, cash=0.0, min_trade_rs=min_trade_rs, blocked=blocked_names
            )
            status = "exit"
        results.append(
            {
                "id": lot.id,
                "label": lot.label,
                "name": lot.name,
                "status": status,
                "next": lot.next_due,
                "budget": round(budget.get(lot.id, 0.0), 2) if lot.due else None,
                "holds": {n: s for n, s in sorted(mapped.items())},
                "outside": outside,
                "plan": plan.to_dict() if plan else None,
            }
        )

    rows: list[dict[str, Any]] = []
    # The cash the orders spend is the free cash plus what the owner adds for a new lot.
    total = OrderPlan(0.0, max(0.0, free_cash) + deposit_needed)
    for result in results:
        plan_dict = result["plan"]
        if not plan_dict:
            continue
        rows += [{**row, "lot": result["label"]} for row in plan_dict["rows"]]
        total.portfolio_value += plan_dict["portfolio_value"]
        total.sells += plan_dict["sells"]
        total.buys += plan_dict["buys"]
        total.charges += plan_dict["charges"]
        total.not_traded += plan_dict["not_traded"]
        total.missing_prices += [
            m for m in plan_dict["missing_prices"] if m not in total.missing_prices
        ]
    total.cash_after = total.cash + total.sells - total.buys - total.charges
    aggregate = total.to_dict()
    aggregate["rows"] = sorted(
        rows, key=lambda r: (orders._ORDER[r["action"]], r["symbol"], r["lot"])
    )
    return {
        "lots": results,
        "deposit_needed": round(deposit_needed, 2),
        "free_cash": round(max(0.0, free_cash), 2),
        "plan": aggregate,
    }


def net_by_symbol(plan: dict[str, Any]) -> dict[str, int]:
    """Shares to buy (+) or sell (-) per stock across all lots, for the one order a stock gets."""
    net: dict[str, int] = {}
    for row in plan["rows"]:
        if not row["quantity"]:
            continue
        sign = -1 if row["action"] in ("SELL", "TRIM") else 1
        net[row["symbol"]] = net.get(row["symbol"], 0) + sign * row["quantity"]
    return {k: v for k, v in net.items() if v}


__all__ = [
    "Lot",
    "OrderRow",
    "Reconciled",
    "append",
    "apply",
    "clear",
    "has_ledger",
    "history",
    "net_by_symbol",
    "pending",
    "plan_lots",
    "positions",
    "reconcile",
    "set_pending",
]
