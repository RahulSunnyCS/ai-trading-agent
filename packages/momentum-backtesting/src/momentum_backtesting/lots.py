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


def pending(con: duckdb.DuckDBPyConnection, who: str, group_id: str) -> str | None:
    row = con.execute(
        "SELECT pending_sleeve_id FROM momentum_lot_state WHERE owner = ? AND group_id = ?",
        [who, group_id],
    ).fetchone()
    return row[0] if row else None


def set_pending(
    con: duckdb.DuckDBPyConnection, who: str, group_id: str, sleeve_id: str | None, at: str
) -> None:
    con.execute(
        "INSERT OR REPLACE INTO momentum_lot_state "
        "(owner, group_id, pending_sleeve_id, updated_at) VALUES (?, ?, ?, ?)",
        [who, group_id, sleeve_id, at],
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


def reconcile(
    held: dict[str, float],
    ledger: dict[str, dict[str, float]],
    pending_id: str | None,
    allowed: dict[str, set[str]],
) -> Reconciled:
    """Book what changed in Kite's holdings (`held`: base symbol -> shares, the strategy's names
    only) to the lot whose orders were made last (`pending_id`).

    A purchase is booked to that lot when it may hold the name (`allowed[lot]`: its target and its
    current holdings). A sale is booked to the lot that holds the name (that lot first, else the
    only holder). Everything else is `unexplained`: nothing is booked, so nothing is guessed."""
    result = Reconciled()
    symbols = sorted(set(held) | {s for lot in ledger.values() for s in lot})
    for symbol in symbols:
        booked = sum(lot.get(symbol, 0.0) for lot in ledger.values())
        delta = held.get(symbol, 0.0) - booked
        if abs(delta) < EPS:
            continue
        if delta > 0:
            if pending_id and symbol in allowed.get(pending_id, set()):
                result.events.append(
                    {
                        "sleeve_id": pending_id,
                        "symbol": symbol,
                        "delta": delta,
                        "kind": "attributed",
                    }
                )
            else:
                result.unexplained.append(
                    {
                        "symbol": symbol,
                        "delta": delta,
                        "reason": "bought, and the lot whose orders were last made cannot hold it",
                    }
                )
            continue
        need = -delta
        holders = [(sid, lot[symbol]) for sid, lot in ledger.items() if lot.get(symbol, 0) > EPS]
        holders.sort(key=lambda h: (h[0] != pending_id, h[0]))
        if len(holders) > 1 and holders[0][0] != pending_id:
            result.unexplained.append(
                {"symbol": symbol, "delta": delta, "reason": "sold, and several lots hold it"}
            )
            continue
        for sleeve_id, shares in holders[:1]:
            take = min(need, shares)
            result.events.append(
                {"sleeve_id": sleeve_id, "symbol": symbol, "delta": -take, "kind": "attributed"}
            )
            need -= take
        if need > EPS:
            result.unexplained.append(
                {"symbol": symbol, "delta": -need, "reason": "sold more than the lot holds"}
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
    return {sid: {s: q for s, q in lot.items() if q > EPS} for sid, lot in out.items()}


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
    new = [lot for lot in due if not held[lot.id][0]]
    rebalancing = [lot for lot in due if held[lot.id][0]]

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
        budget[lot.id] = left * (values[lot.id] / total_value) if total_value > 0 else 0.0

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
