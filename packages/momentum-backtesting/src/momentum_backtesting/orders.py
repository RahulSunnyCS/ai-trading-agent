"""Your orders (BL-051 Phase 3): the trades that bring a real portfolio to the model's target.

Pure arithmetic over holdings in shares, prices and target weights; no I/O. The rules, as the
owner set them on 2026-10-08:

- A name the model no longer holds is sold in full, and a name it newly holds is bought, whatever
  the amount. Only top-ups and trims are subject to the minimum trade (Rs 10,000 by default).
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
                row.action, row.note = "SKIP", f"less than one share (Rs {price:,.0f})"
        elif abs(gap) < min_trade_rs:
            if abs(gap) >= price:  # a real but small difference: say what it would have cost
                cost = buy_charges(abs(gap)) if gap > 0 else sell_charges(abs(gap))
                row.action = "SKIP"
                row.note = f"under the Rs {min_trade_rs:,.0f} minimum; would cost Rs {cost:,.0f}"
        else:
            quantity = math.floor(abs(gap) / price)
            if quantity == 0:
                row.action, row.note = "SKIP", f"less than one share (Rs {price:,.0f})"
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
