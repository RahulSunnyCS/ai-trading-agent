"""Your orders (BL-051 Phase 3): the trades that bring a real portfolio to the model's target.

Pure arithmetic over holdings in shares, prices and target weights; no I/O. The rules, as the
owner set them on 2026-10-08:

- A name the model no longer holds is sold in full, and a name it newly holds is bought, whatever
  the amount. Only top-ups and trims are subject to the minimum trade (₹10,000 by default).
- Whole shares, rounded down; a trade worth less than one share is skipped and says so.
- A blocked name (an unclassified possible split: its price may be wrong) is held, never traded.
- Sells first, then buys. Estimated charges use the backtest's itemised rates (`engine`'s STT,
  stamp duty, exchange fees and the per-sell DP charge); Fyers charges no brokerage on delivery.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

from .engine import DP_CHARGE_RS, EXCHANGE_FEES_RATE, STAMP_DUTY_BUY_RATE, STT_RATE

DEFAULT_MIN_TRADE_RS = 10_000.0


@dataclass
class OrderRow:
    symbol: str
    #: SELL, TRIM, BUY, ADD, SKIP (under the minimum or under one share), HOLD (blocked), or ""
    #: (already at the target).
    action: str
    held: float
    price: float | None
    value: float
    current: float  # share of the portfolio now
    target: float  # the model's share
    quantity: int  # shares to trade (0 when nothing is traded)
    order_value: float
    charges: float
    note: str = ""


@dataclass
class OrderPlan:
    portfolio_value: float
    cash: float
    rows: list[OrderRow] = field(default_factory=list)
    sells: float = 0.0
    buys: float = 0.0
    charges: float = 0.0
    cash_after: float = 0.0
    not_traded: int = 0
    missing_prices: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "rows": [asdict(r) for r in self.rows]}


def buy_charges(value: float) -> float:
    return value * (STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE)


def sell_charges(value: float) -> float:
    return value * (STT_RATE + EXCHANGE_FEES_RATE) + (DP_CHARGE_RS if value > 0 else 0.0)


_ORDER = {"SELL": 0, "TRIM": 1, "BUY": 2, "ADD": 3, "SKIP": 4, "HOLD": 5, "": 6}

LEFTOVER_NOTE = "one share from the leftover cash"


def use_leftover(result: OrderPlan, order: list[str]) -> OrderPlan:
    """Spend what a fresh buy left over on the names it could not afford (owner, 2026-11-05).

    The names a plan skipped for being under one share (`SKIP`, a name the portfolio does not hold
    yet) are taken in `order` (the model's rank, best first); each gets ONE share while the cash
    left covers it and its charges, and the first one that does not stops the rule: a lower-ranked
    name is never bought ahead of a better one. Changes the plan in place (sells, buys, charges,
    cash after, the row's action, quantity and note) and returns it."""
    rows = {r.symbol: r for r in result.rows}
    for name in order:
        row = rows.get(name)
        if row is None or row.action != "SKIP" or row.held > 0 or not row.price:
            continue
        if not row.note.startswith("less than one share"):
            continue
        cost = row.price + buy_charges(row.price)
        if cost > result.cash_after:
            break
        row.action, row.quantity, row.note = "BUY", 1, LEFTOVER_NOTE
        row.order_value = row.price
        if result.portfolio_value > 0:  # the row's share of the lot after the buy
            row.target = max(row.target, row.price / result.portfolio_value)
        row.charges = buy_charges(row.price)
        result.buys += row.order_value
        result.charges += row.charges
        result.cash_after -= cost
    result.rows.sort(key=lambda r: (_ORDER[r.action], r.symbol))
    result.not_traded = sum(1 for r in result.rows if r.action in ("SKIP", "HOLD"))
    return result


def plan_equal_split(
    holdings: dict[str, float],
    prices: dict[str, float],
    slices: dict[str, float],
    *,
    keep: frozenset[str] | set[str],
    cash: float = 0.0,
    min_trade_rs: float = DEFAULT_MIN_TRADE_RS,
    blocked: frozenset[str] | set[str] = frozenset(),
    max_position: float | None = None,
    cap_band: float = 0.0,
) -> OrderPlan:
    """A rebalancing lot trades what the backtest trades (BL-236, owner 2026-11-19): it does not
    aim at the sleeve's end weights.

    The backtest sells what leaves its book, splits what that frees equally across the names it
    buys that week (the top category's pick at its extra weight) and lets everything else drift.
    Here: a held name not in `keep` is sold in full; a held name above `max_position + cap_band`
    of the lot is trimmed to `max_position` (the minimum trade applies to that trim only); the
    proceeds, the trims and `cash` are split over `slices` (name -> relative weight, best rank
    first; a name already held is topped up, never trimmed) in whole shares, with no minimum on a
    slice and no name pushed past `max_position`. A slice under one share is skipped (the leftover
    rule can buy it afterwards: `use_leftover`). A blocked name is held and its slice goes to the
    others. Sells first; charges as `plan`."""
    names = sorted(set(holdings) | set(slices))
    value_of = {n: holdings.get(n, 0.0) * (prices.get(n) or 0.0) for n in names}
    total = sum(value_of.values()) + cash
    result = OrderPlan(
        portfolio_value=total, cash=cash, missing_prices=[n for n in names if not prices.get(n)]
    )
    if total <= 0:
        return result
    rows = {
        n: OrderRow(
            n,
            "",
            holdings.get(n, 0.0),
            prices.get(n),
            value_of[n],
            value_of[n] / total,
            value_of[n] / total,
            0,
            0.0,
            0.0,
        )
        for n in names
    }
    result.rows = list(rows.values())
    after = dict(value_of)  # what each name is worth once the sells and trims are made
    pool = cash

    def sell(row: OrderRow, action: str, quantity: int) -> None:
        nonlocal pool
        row.action, row.quantity = action, quantity
        row.order_value = quantity * row.price
        row.charges = sell_charges(row.order_value)
        result.sells += row.order_value
        result.charges += row.charges
        pool += row.order_value - row.charges
        after[row.symbol] -= row.order_value

    for name, row in rows.items():
        if holdings.get(name, 0.0) <= 0:
            continue
        if name in blocked:
            row.action, row.note = "HOLD", "held: a possible split is not classified yet"
        elif not row.price:
            row.action, row.note = "SKIP", "no price"
        elif name not in keep:
            sell(row, "SELL", int(row.held))
        elif max_position and value_of[name] / total > max_position + cap_band:
            quantity = math.floor((value_of[name] - max_position * total) / row.price)
            if quantity <= 0:
                continue
            if quantity * row.price < min_trade_rs:
                row.action = "SKIP"
                row.note = f"over the cap, but under the ₹{min_trade_rs:,.0f} minimum"
            else:
                sell(row, "TRIM", quantity)

    eligible = [n for n in slices if n not in blocked and prices.get(n) and slices[n] > 0]
    budget = pool
    alloc: dict[str, float] = {}
    free = list(eligible)
    remaining = budget
    for _ in range(len(eligible) + 1):  # water-fill: a name at the cap stops taking money
        weight = sum(slices[n] for n in free)
        if not free or weight <= 0 or remaining <= 0:
            break
        capped = []
        for n in free:
            share = remaining * slices[n] / weight
            room = (max_position * total - after[n]) if max_position else math.inf
            if share > max(room, 0.0):
                alloc[n] = max(room, 0.0)
                capped.append(n)
        if not capped:
            for n in free:
                alloc[n] = remaining * slices[n] / weight
            break
        remaining -= sum(alloc[n] for n in capped)
        free = [n for n in free if n not in capped]

    spent = 0.0
    for name in eligible:
        row = rows[name]
        quantity = math.floor(alloc.get(name, 0.0) / row.price)
        while quantity > 0:
            cost = quantity * row.price
            if spent + cost + buy_charges(cost) <= budget + 1e-9:
                break
            quantity -= 1
        if quantity <= 0:
            row.action, row.note = "SKIP", f"less than one share (₹{row.price:,.0f})"
            continue
        row.action = "ADD" if row.held > 0 else "BUY"
        row.quantity = quantity
        row.order_value = quantity * row.price
        row.charges = buy_charges(row.order_value)
        result.buys += row.order_value
        result.charges += row.charges
        spent += row.order_value + row.charges
        after[name] += row.order_value
    for name, row in rows.items():
        row.target = after[name] / total
    result.rows.sort(key=lambda r: (_ORDER[r.action], r.symbol))
    result.cash_after = cash + result.sells - result.buys - result.charges
    result.not_traded = sum(1 for r in result.rows if r.action in ("SKIP", "HOLD"))
    return result


def plan(
    holdings: dict[str, float],
    prices: dict[str, float],
    target: dict[str, float],
    *,
    cash: float = 0.0,
    min_trade_rs: float = DEFAULT_MIN_TRADE_RS,
    blocked: frozenset[str] | set[str] = frozenset(),
) -> OrderPlan:
    """Orders that move `holdings` (shares) towards `target` (weights of the whole portfolio,
    cash being whatever they leave), valued at `prices` plus `cash` in rupees."""
    names = sorted(set(holdings) | {k for k, w in target.items() if w > 0})
    missing = [n for n in names if not prices.get(n)]
    value_of = {n: holdings.get(n, 0.0) * prices.get(n, 0.0) for n in names}
    total = sum(value_of.values()) + cash
    result = OrderPlan(portfolio_value=total, cash=cash, missing_prices=missing)
    if total <= 0:
        return result
    for name in names:
        price = prices.get(name)
        held = holdings.get(name, 0.0)
        value = value_of[name]
        weight = target.get(name, 0.0)
        row = OrderRow(name, "", held, price, value, value / total, weight, 0, 0.0, 0.0)
        result.rows.append(row)
        if name in blocked:
            row.action, row.note = "HOLD", "held: a possible split is not classified yet"
            continue
        if not price:
            row.action, row.note = "SKIP", "no price"
            continue
        gap = weight * total - value
        if weight <= 0 and held > 0:
            row.action, row.quantity = "SELL", int(held)
        elif held <= 0 and weight > 0:
            row.action, row.quantity = "BUY", math.floor(gap / price)
            if row.quantity == 0:
                row.action, row.note = "SKIP", f"less than one share (₹{price:,.0f})"
        elif abs(gap) < min_trade_rs:
            if abs(gap) >= price:  # a real but small difference: say what it would have cost
                cost = buy_charges(abs(gap)) if gap > 0 else sell_charges(abs(gap))
                row.action = "SKIP"
                row.note = f"under the ₹{min_trade_rs:,.0f} minimum; would cost ₹{cost:,.0f}"
        else:
            quantity = math.floor(abs(gap) / price)
            if quantity == 0:
                row.action, row.note = "SKIP", f"less than one share (₹{price:,.0f})"
            else:
                row.action, row.quantity = ("ADD" if gap > 0 else "TRIM"), quantity
        if row.quantity:
            row.order_value = row.quantity * price
            selling = row.action in ("SELL", "TRIM")
            row.charges = sell_charges(row.order_value) if selling else buy_charges(row.order_value)
            if selling:
                result.sells += row.order_value
            else:
                result.buys += row.order_value
            result.charges += row.charges
    result.rows.sort(key=lambda r: (_ORDER[r.action], r.symbol))
    result.cash_after = cash + result.sells - result.buys - result.charges
    result.not_traded = sum(1 for r in result.rows if r.action in ("SKIP", "HOLD"))
    return result
