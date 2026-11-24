"""BL-236 Phase 1: a due lot's orders under today's rule and under the backtest's equal split.

Read-only. It decides the sleeve's pending week in-process (`api._broad_sentinel_run(ahead=True)`:
the engine's own decision for the Friday after the newest stored week), takes the model's own
trades that week as the recipe (what it sold, what it bought and topped up, as fractions of the
sleeve), and scales them to the lot: sell every name the lot holds that the model's rules would
exit (exit rank, owner 2026-11-19), split the proceeds plus the lot's cash budget over the model's
buys in the model's proportions (the engine's equal split with its top-category weight and caps
already applied), whole shares, no minimum on a slice. It prints beside the tentative plan the
scheduler saved (`data/tentative_orders.json`).

Writes nothing under `data/`, the catalog or Kite. Uses the stored 20 Nov tentative prices.

    uv run python scripts/bl236_equal_split.py [--sleeve ID] [--json out.json]

The saved sleeve config is read from the running API (`GET /api/saved-strategies/<id>`), so the
catalog is opened only by the ranking's short read-only reads.
"""

# ruff: noqa: E501, T201, SIM115, PTH123
from __future__ import annotations

import argparse
import json
import math
import urllib.request

import pandas as pd

from momentum_backtesting import api, this_week
from momentum_backtesting.api import BacktestRequest

API = "http://127.0.0.1:8765"
LOT1 = "3057fa8f2cb44b3bb42d24304c6a34ee"


def get(path: str) -> dict:
    with urllib.request.urlopen(API + path, timeout=60) as r:  # noqa: S310 - loopback
        return json.load(r)


def model_week(req: BacktestRequest) -> tuple[pd.Timestamp, pd.DataFrame, dict, dict]:
    """The pending week's trades and ranks. `value` of a BUY / ADD is the engine's own equal-split
    slice (top category x`broad_top_sector_weight`), in the sleeve's index units."""
    outcome, week = api._broad_sentinel_run(req, ahead=True)
    result = outcome.result
    trades = result.trades
    acted = trades[trades["week"] == week] if len(trades) else trades
    rows = [
        {
            "asset": t.asset,
            "action": str(t.action),
            "reason": str(t.reason),
            "value": float(t.value),
        }
        for t in acted.itertuples()
        if t.asset not in (api.CASH, api.IDLE)
    ]
    ranks = {k: float(v) for k, v in result.ranks.loc[week].items() if pd.notna(v)}
    end = {k: float(v) for k, v in result.weights.loc[week].items() if v > 1e-9}
    return week, pd.DataFrame(rows), ranks, end


def gap(lot: dict[str, float], model: dict[str, float]) -> float:
    """Tracking gap: half the sum of absolute weight differences (0 = same book, 1 = disjoint)."""
    names = set(lot) | set(model)
    return 0.5 * sum(abs(lot.get(n, 0.0) - model.get(n, 0.0)) for n in names)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sleeve", default=LOT1)
    ap.add_argument("--json")
    args = ap.parse_args()

    saved = get(f"/api/saved-strategies/{args.sleeve}")
    req = BacktestRequest.model_validate(saved["config"])
    with open(this_week.state_dir() / "tentative_orders.json") as fh:
        tent = json.load(fh)
    lot = next(item for item in tent["lots"] if item["id"] == args.sleeve)
    holds = lot["holds"]
    plan_rows = lot["plan"]["rows"]
    prices = {r["symbol"]: r["price"] for r in plan_rows}
    cash = float(lot["budget"])

    week, trades, ranks, end = model_week(req)
    print(f"model week {week:%Y-%m-%d}: {len(trades)} trades")
    print(trades.to_string(index=False))

    sells = {r.asset for r in trades.itertuples() if r.action == "SELL"}
    # The engine's buffer rule: a held name stays while the model keeps it (in its book after the
    # week's trades), whatever the lot's own weight; no model row = the exit rule sells it.
    keep = {
        n
        for n in holds
        if n not in sells and (n in end or ranks.get(n, 1e9) <= req.broad_category_exit_rank)
    }
    lot_sell = {n: q for n, q in holds.items() if n not in keep}
    proceeds = sum(q * prices[n] for n, q in lot_sell.items())
    slices = trades[trades["action"].isin(["BUY", "ADD"])].set_index("asset")["value"]
    print(
        f"\nkept {sorted(keep)}; sold {sorted(lot_sell)} = Rs{proceeds:,.0f}; free cash Rs{cash:,.0f}"
    )

    def split(budget: float) -> tuple[list[dict], float]:
        out, left = [], budget
        for name, v in slices.sort_values(ascending=False).items():
            price = prices.get(name)
            want = budget * v / slices.sum()
            qty = math.floor(want / price) if price else 0
            out.append(
                {
                    "asset": name,
                    "price": price,
                    "want": round(want),
                    "qty": qty,
                    "value": round(qty * (price or 0)),
                    "rank": ranks.get(name),
                }
            )
            left -= qty * (price or 0)
        return out, left

    def after(orders: list[dict], sold: dict[str, float], extra_cash: float) -> dict[str, float]:
        book = {n: q * prices[n] for n, q in holds.items() if n not in sold}
        for o in orders:
            book[o["asset"]] = book.get(o["asset"], 0.0) + o["value"]
        total = sum(book.values()) + extra_cash
        return {n: v / total for n, v in book.items()}

    result = {}
    for label, budget in (("proceeds only", proceeds), ("proceeds + free cash", proceeds + cash)):
        orders, left = split(budget)
        spent = sum(o["value"] for o in orders)
        gp = gap(
            after(
                orders,
                lot_sell,
                left
                + (0 if label == "proceeds only" else 0)
                + (cash if label == "proceeds only" else 0),
            ),
            end,
        )
        print(
            f"\nEQUAL SPLIT, {label}: budget Rs{budget:,.0f}, buys Rs{spent:,.0f}, left Rs{left:,.0f}, tracking gap {gp:.1%}"
        )
        for o in orders:
            print("  ", o)
        result[label] = {"orders": orders, "left": left, "gap": gp}

    # today's plan after its own trades, same gap measure
    book = {n: q * prices[n] for n, q in holds.items()}
    for r in plan_rows:
        sign = {"SELL": -1, "TRIM": -1, "BUY": 1}.get(r["action"])
        if sign:
            book[r["symbol"]] = book.get(r["symbol"], 0.0) + sign * r["order_value"]
    book = {n: v for n, v in book.items() if v > 1e-6}
    total = sum(book.values()) + lot["plan"]["cash_after"]
    cur = {n: v / total for n, v in book.items()}
    print(
        f"\nTODAY'S PLAN: sells Rs{lot['plan']['sells']:,.0f}, buys Rs{lot['plan']['buys']:,.0f}, tracking gap {gap(cur, end):.1%}"
    )
    for r in plan_rows:
        if r["action"] in ("SELL", "TRIM", "BUY"):
            print("  ", r["action"], r["symbol"], r["quantity"], round(r["order_value"]))
    print(
        f"\nlot now vs model end book: gap {gap({n: q * prices[n] / sum(q2 * prices[n2] for n2, q2 in holds.items()) for n, q in holds.items()}, end):.1%} (before any trade, cash ignored)"
    )
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(result, fh, indent=1, default=str)


if __name__ == "__main__":
    main()
