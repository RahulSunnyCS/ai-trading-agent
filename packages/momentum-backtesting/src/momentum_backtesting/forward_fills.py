"""
BL-024 Phase 3: the real Momentum fills (Zerodha Kite) reconciled against the journal's signal.

Inputs, all read-only:
- the Kite contract notes `packages/contract-notes` stores under
  `TRADING_DATA_ROOT/contract-notes/days/<day>.jsonl` (lines with `broker: kite`, `status: note`:
  every fill with its price and time, and the note's charges). Read as files: this package never
  imports `option-backtesting`, whose `realised/` reads the same store for the Trade book;
- the lot ledger (`momentum_lot_events`, BL-142): which lot (sleeve) each share was booked to, and
  the pending lot's plan (`momentum_lot_state.planned`), for fills not booked yet;
- the Friday 14:15 orders (`momentum_orders`): what each lot was told to trade, at what price;
- the journal: the sleeve's scored row for the week (`forward_score.select`), its target portfolio.

A **real rebalance** is a lot's due week from the paper start on: the journal row's
`rebalance.on_cadence` is true. Its fills are those the ledger (or the pending plan) books to the
lot, matched to the contract-note fills symbol by symbol, oldest first (FIFO), and dated from that
Friday's 14:00 to the lot's next due week. Fills nothing books are listed as outside the lots.

Per name: what the signal said (action, target weight), what the 14:15 orders said (shares,
price), what was done (shares, average price, charges from the note, shared by trade value),
the difference, and the fill against the model's fill prices: Friday's close (ideal) and the next
session's open (achievable), in basis points, positive = paid more on a buy / got less on a sell.
The model's own charges on the same trades are the engine's itemised rates without slippage
(slippage is what the price comparison measures; the model assumes `slippage_bps`).
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from . import engine
from .forward_score import IST, select

KITE = "kite"
NOT_BOOKED = "plan (not booked yet)"


@dataclass
class Fill:
    day: str
    time: str
    symbol: str
    side: str  # buy | sell
    qty: float
    price: float
    charges: float  # this fill's share of the note's total charges

    @property
    def at(self) -> datetime:
        return datetime.fromisoformat(f"{self.day}T{self.time or '00:00:00'}").replace(tzinfo=IST)

    @property
    def value(self) -> float:
        return self.qty * self.price


def kite_fills(root: Path, start: str | None = None) -> tuple[list[Fill], list[dict]]:
    """Every Kite fill in the contract-notes store, oldest first, and one summary per note."""
    fills: list[Fill] = []
    notes: list[dict] = []
    folder = root / "contract-notes" / "days"
    if not folder.is_dir():
        return fills, notes
    for path in sorted(folder.glob("*.jsonl")):
        if start and path.stem < start:
            continue
        for line in path.read_text().splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("broker") != KITE or record.get("status") != "note":
                continue
            trades = record.get("trades") or []
            total = float((record.get("eq") or {}).get("total_charges") or 0.0)
            gross = sum(float(t.get("qty", 0)) * float(t.get("price", 0)) for t in trades)
            day = record.get("day") or path.stem
            notes.append(
                {"day": day, "account": record.get("account"), "charges": total, "value": gross}
            )
            for t in trades:
                qty, price = float(t.get("qty", 0)), float(t.get("price", 0))
                fills.append(
                    Fill(
                        day=day,
                        time=str(t.get("time") or t.get("order_time") or ""),
                        symbol=str(t.get("symbol")),
                        side=str(t.get("side")),
                        qty=qty,
                        price=price,
                        charges=total * qty * price / gross if gross else 0.0,
                    )
                )
    fills.sort(key=lambda f: (f.day, f.time))
    return fills, notes


@dataclass
class Claim:
    sleeve_id: str
    symbol: str
    delta: float
    source: str  # the ledger's kind, or NOT_BOOKED
    at: str
    note: str | None = None


def claims(events: list[dict], planned: dict[str, dict[str, float]], at: str) -> list[Claim]:
    """The ledger's events in booking order, then the pending plan (not yet booked)."""
    out = [
        Claim(e["sleeve_id"], e["symbol"], float(e["delta"]), e["kind"], e["at"], e.get("note"))
        for e in sorted(events, key=lambda e: e["at"])
    ]
    for sleeve_id, plan in (planned or {}).items():
        for symbol, delta in plan.items():
            out.append(Claim(sleeve_id, symbol, float(delta), NOT_BOOKED, at))
    return out


@dataclass
class Matched:
    sleeve_id: str | None  # None: no lot claims it
    fill: Fill
    qty: float
    source: str | None
    note: str | None = None


def attribute(fills: list[Fill], booked: list[Claim]) -> tuple[list[Matched], list[Claim]]:
    """FIFO per symbol and side: each claim (a lot's booked change of shares) takes the oldest
    unmatched fills of that symbol in its direction. Returns every fill, split where a claim ends,
    and the claims (or parts) no fill was found for."""
    pending: dict[tuple[str, str], list[list]] = defaultdict(list)
    for fill in fills:
        pending[(fill.symbol, fill.side)].append([fill, fill.qty])
    matched: list[Matched] = []
    unmet: list[Claim] = []
    for claim in booked:
        side = "buy" if claim.delta > 0 else "sell"
        need = abs(claim.delta)
        queue = pending[(claim.symbol, side)]
        while need > 1e-9 and queue:
            fill, left = queue[0]
            take = min(left, need)
            matched.append(Matched(claim.sleeve_id, fill, take, claim.source, claim.note))
            need -= take
            queue[0][1] = left - take
            if queue[0][1] <= 1e-9:
                queue.pop(0)
        if need > 1e-9:
            unmet.append(
                Claim(
                    claim.sleeve_id,
                    claim.symbol,
                    need if claim.delta > 0 else -need,
                    claim.source,
                    claim.at,
                    claim.note,
                )
            )
    for queue in pending.values():
        for fill, left in queue:
            if left > 1e-9:
                matched.append(Matched(None, fill, left, None))
    matched.sort(key=lambda m: (m.fill.day, m.fill.time, m.fill.symbol))
    return matched, unmet


def _model_charges(side: str, value: float) -> float:
    """The engine's itemised charges on a real trade, without its slippage (measured instead)."""
    if side == "buy":
        return value * (engine.STT_RATE + engine.STAMP_DUTY_BUY_RATE + engine.EXCHANGE_FEES_RATE)
    return value * (engine.STT_RATE + engine.EXCHANGE_FEES_RATE) + engine.DP_CHARGE_RS


def _bps(fill: float | None, reference: float | None, side: str) -> float | None:
    if fill is None or reference is None or reference <= 0:
        return None
    move = (fill - reference) / reference * 10000
    return move if side == "buy" else -move


def _base(name: str) -> str:
    return name.split("#", 1)[0]


def reconcile(
    *,
    journal_rows: list[dict],
    lot_sleeves: dict[str, str],
    events: list[dict],
    planned: dict[str, dict[str, float]],
    planned_at: str,
    orders: list[dict],
    fills: list[Fill],
    notes: list[dict],
    raw_prices: dict[tuple[str, str], tuple[float | None, float | None]],
    next_session: dict[str, str],
    paper_start: str | None,
    lot_size: float,
) -> dict:
    """The real rebalances of the lots in `lot_sleeves` ({sleeve_id: label}).

    `raw_prices[(symbol, day)]` is that day's (open, close) as traded (not adjusted);
    `next_session[week]` the first session after the Friday `week`; `orders` the stored
    `momentum_orders` payloads (`holdings_store.orders_for`)."""
    matched, unmet = attribute(fills, claims(events, planned, planned_at))
    selected = select([r for r in journal_rows if r["config_id"] in lot_sleeves])
    due: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for (config_id, run_kind, week), slot in selected.items():
        row = slot["scored"]
        if run_kind != "final" or row is None or (paper_start and week < paper_start):
            continue
        signal = json.loads(row["signal"]) if isinstance(row["signal"], str) else row["signal"]
        if (signal.get("rebalance") or {}).get("on_cadence"):
            due[config_id].append((week, {"row": row, "signal": signal}))
    for config_id in due:
        due[config_id].sort(key=lambda w: w[0])

    def window_week(sleeve_id: str, fill: Fill) -> str | None:
        weeks = [w for w, _ in due.get(sleeve_id, [])]
        when = fill.at
        chosen = None
        for week in weeks:
            start = datetime.fromisoformat(f"{week}T14:00:00").replace(tzinfo=IST)
            if when >= start:
                chosen = week
        return chosen

    by_rebalance: dict[tuple[str, str], list[Matched]] = defaultdict(list)
    outside: list[Matched] = []
    for m in matched:
        week = window_week(m.sleeve_id, m.fill) if m.sleeve_id else None
        if week is None:
            outside.append(m)
        else:
            by_rebalance[(m.sleeve_id, week)].append(m)

    rebalances = []
    for sleeve_id, weeks in due.items():
        for week, found in weeks:
            rebalances.append(
                _one_rebalance(
                    sleeve_id,
                    lot_sleeves[sleeve_id],
                    week,
                    found,
                    by_rebalance.get((sleeve_id, week), []),
                    [o for o in orders if o.get("week") == week],
                    raw_prices,
                    next_session.get(week),
                    lot_size,
                    first_week=week == paper_start,
                    new_lot=week == paper_start
                    or not any(
                        e["sleeve_id"] == sleeve_id and e["at"] < f"{week}T14:00" for e in events
                    ),
                )
            )
    rebalances.sort(key=lambda r: (r["week"], r["lot"]))
    return {
        "rebalances": rebalances,
        "outside_lots": [
            {
                "day": m.fill.day,
                "time": m.fill.time,
                "symbol": m.fill.symbol,
                "side": m.fill.side,
                "qty": m.qty,
                "price": m.fill.price,
                "lot": lot_sleeves.get(m.sleeve_id) if m.sleeve_id else None,
            }
            for m in outside
        ],
        "unmatched_claims": [
            {
                "lot": lot_sleeves.get(c.sleeve_id, c.sleeve_id),
                "symbol": c.symbol,
                "shares": c.delta,
                "source": c.source,
            }
            for c in unmet
        ],
        "notes": notes,
    }


def _plan_for(orders: list[dict], sleeve_id: str) -> tuple[dict[str, dict], dict | None]:
    """The newest orders' rows for this lot ({symbol: row}) and that lot's entry."""
    for order in reversed(orders):
        for lot in order.get("lots") or []:
            if lot.get("id") == sleeve_id and lot.get("plan"):
                rows = {r["symbol"]: r for r in lot["plan"].get("rows", [])}
                return rows, {**lot, "created_at": order.get("created_at")}
    return {}, None


def _one_rebalance(
    sleeve_id: str,
    label: str,
    week: str,
    found: dict,
    fills: list[Matched],
    orders: list[dict],
    raw_prices: dict,
    session: str | None,
    lot_size: float,
    *,
    first_week: bool,
    new_lot: bool,
) -> dict:
    """One lot's rebalance. A new lot (nothing booked to it before this Friday, or the paper
    start) is bought from cash: every name in the target is a buy and nothing is sold, whatever
    the model portfolio held before. The fills on the first day the lot traded are the rebalance
    itself and are measured against the model's fill prices; fills later in the window are
    top-ups (the ledger books them "beyond the planned orders") and are counted, not measured."""
    signal = found["signal"]
    target = {k: float(v) for k, v in (signal.get("target_weights") or {}).items() if v}
    by_base = {_base(n): n for n in target}
    actions = {_base(r.get("asset")): r for r in signal.get("rows", []) if r.get("action")}
    plan, lot = _plan_for(orders, sleeve_id)
    budget = float(lot["budget"]) if lot and lot.get("budget") else lot_size
    first_day = min((m.fill.day for m in fills), default=None)

    def empty() -> dict:
        return {
            "now": defaultdict(float),
            "later": defaultdict(float),
            "charges": 0.0,
            "sources": set(),
            "notes": set(),
            "days": set(),
        }

    real: dict[str, dict] = defaultdict(empty)
    for m in fills:
        r = real[m.fill.symbol]
        part = r["now"] if m.fill.day == first_day else r["later"]
        signed = m.qty if m.fill.side == "buy" else -m.qty
        part["shares"] += signed
        part["value"] += signed * m.fill.price
        r["charges"] += m.fill.charges * m.qty / m.fill.qty if m.fill.qty else 0.0
        r["sources"].add(m.source)
        r["days"].add(m.fill.day)
        if m.note and m.fill.symbol in m.note:
            r["notes"].add(m.note)

    names = list(dict.fromkeys([*by_base, *plan, *real]))
    if not new_lot:
        names += [n for n, row in actions.items() if row.get("action") == "SELL" and n not in names]
    rows = []
    totals = {
        "bought": 0.0,
        "sold": 0.0,
        "real_charges": 0.0,
        "model_charges": 0.0,
        # None until a first-day fill has that reference price: "not measured", never zero.
        "slippage_close_rs": None,
        "slippage_open_rs": None,
        "slippage_plan_rs": None,
    }
    for name in names:
        weight = target.get(by_base.get(name, name))
        action = (actions.get(name) or {}).get("action")
        if new_lot:
            action = "BUY" if weight else None
        _, close = raw_prices.get((name, week), (None, None))
        open_ = raw_prices.get((name, session), (None, None))[0] if session else None
        r = real.get(name)
        now_shares = r["now"]["shares"] if r else 0.0
        later_shares = r["later"]["shares"] if r else 0.0
        shares = now_shares + later_shares
        side = "sell" if (shares < 0 or (not shares and action == "SELL")) else "buy"
        avg_now = abs(r["now"]["value"] / now_shares) if r and now_shares else None
        avg_later = abs(r["later"]["value"] / later_shares) if r and later_shares else None
        planned = plan.get(name)
        plan_qty = float(planned["quantity"]) if planned else None
        plan_price = float(planned["price"]) if planned else None
        model_qty = int(weight * budget // close) if weight and close else None
        if r:
            bought = sum(v for v in (r["now"]["value"], r["later"]["value"]) if v > 0)
            sold = -sum(v for v in (r["now"]["value"], r["later"]["value"]) if v < 0)
            totals["bought"] += bought
            totals["sold"] += sold
            totals["real_charges"] += r["charges"]
            model_charges = _model_charges("buy", bought) if bought else 0.0
            model_charges += _model_charges("sell", sold) if sold else 0.0
            totals["model_charges"] += model_charges
        else:
            model_charges = None
        if avg_now is not None:
            sign = 1 if now_shares > 0 else -1
            for key, ref in (
                ("slippage_close_rs", close),
                ("slippage_open_rs", open_),
                ("slippage_plan_rs", plan_price),
            ):
                if ref:
                    totals[key] = (totals[key] or 0.0) + sign * (avg_now - ref) * abs(now_shares)
        reference_qty = plan_qty if plan_qty is not None else model_qty
        rows.append(
            {
                "symbol": name,
                "signal_action": action,
                "target_weight": weight,
                "model_shares": model_qty,
                "plan_shares": plan_qty,
                "plan_price": plan_price,
                "side": side,
                "shares": abs(shares) if r else None,
                "shares_first_day": abs(now_shares) if r and now_shares else None,
                "avg_first_day": avg_now,
                "shares_later": abs(later_shares) if r and later_shares else None,
                "avg_later": avg_later,
                # Against the 14:15 orders when there were any, else the model's whole shares.
                "difference": (abs(shares) if r else 0.0) - reference_qty
                if reference_qty is not None
                else None,
                "friday_close": close,
                "next_open": open_,
                "vs_close_bps": _bps(avg_now, close, side),
                "vs_open_bps": _bps(avg_now, open_, side),
                "vs_plan_bps": _bps(avg_now, plan_price, side),
                "charges": r["charges"] if r else None,
                "model_charges": model_charges,
                "booked": sorted(s for s in r["sources"] if s) if r else [],
                "days": sorted(r["days"]) if r else [],
                "note": "; ".join(sorted(r["notes"])) if r and r["notes"] else None,
                "status": _status(action, weight, plan_qty, abs(shares) if r else None),
            }
        )
    # What the 14:15 orders meant the lot to hold: the names they target (a sold name has no
    # target, so a sale never reads as a disagreement).
    plan_names = {name for name, row in plan.items() if (row.get("target") or 0) > 0}
    settings = found["row"].get("settings") or "{}"
    settings = json.loads(settings) if isinstance(settings, str) else settings
    slippage = settings.get("slippage_bps")
    return {
        "slippage_bps": float(slippage) if slippage is not None else None,
        "lot": label,
        "sleeve_id": sleeve_id,
        "week": week,
        "next_session": session,
        "first_week": first_week,
        "new_lot": new_lot,
        "first_trade_day": first_day,
        "entry_id": found["row"]["entry_id"],
        "recorded_at": found["row"]["recorded_at"],
        "budget": budget,
        "budget_from": "the 14:15 orders" if lot and lot.get("budget") else "the lot size",
        "orders_at": lot.get("created_at") if lot else None,
        # Names the 14:15 orders and the journal's final signal disagree on (the orders decide on
        # live prices before the close; the final on the close, recorded after it).
        "plan_differs": sorted(plan_names ^ set(by_base)) if plan else [],
        "rows": rows,
        "totals": totals,
        "booked_pending": any(NOT_BOOKED in row["booked"] for row in rows),
    }


def _status(
    action: str | None, weight: float | None, plan_qty: float | None, qty: float | None
) -> str:
    """done / shares differ (against the 14:15 orders) / missed (the signal or the orders traded
    it, nothing was done) / extra (done, but neither asked for it) / held (no trade asked)."""
    asked = bool(plan_qty) or action in ("BUY", "SELL", "ADD", "TRIM")
    if not qty:
        return "missed" if asked else "held"
    if not asked and not weight:
        return "extra"
    if plan_qty is not None and abs(qty - plan_qty) > 1e-9:
        return "shares differ"
    return "done"


def next_sessions(weeks: list[str], days: list[str]) -> dict[str, str]:
    """{Friday: the first trading day after it} from the days that have bars."""
    ordered = sorted(set(days))
    out = {}
    for week in weeks:
        later = [d for d in ordered if d > week]
        if later and (pd.Timestamp(later[0]) - pd.Timestamp(week)) <= timedelta(days=7):
            out[week] = later[0]
    return out
