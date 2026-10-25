"""BL-166 pilot: one learning-period month, by hand. Swings, structure, events and exits are
recomputed in plain Python from the 1-minute bars and must equal the grammar's on every session;
each event's trade is listed (strike, fills, exit). Nothing goes in the ledger.

    uv run python research/bl166/pilot.py [--from 2024-10-09 --to 2024-11-08]
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from specs import RULE  # noqa: E402

M, N = 5, 2
START, STOP, CAP = 25, 285, 360  # 09:40, 14:00, 15:15


def swings(bars: np.ndarray, high: bool) -> list[tuple[int, float]]:
    out = []
    for k in range(N, len(bars) - N):
        v, others = bars[k], list(bars[k - N : k]) + list(bars[k + 1 : k + N + 1])
        if all((v > o) if high else (v < o) for o in others):
            out.append(((k + N + 1) * M - 1, float(v)))
    return out


def at(sw: list[tuple[int, float]], j: int, back: int) -> float | None:
    known = [v for s, v in sw if s <= j]
    return known[-1 - back] if len(known) > back else None


def by_hand(h: np.ndarray, lo: np.ndarray, c: np.ndarray) -> tuple[int | None, str | None, int]:
    hb = h[: 75 * M].reshape(75, M).max(1)
    lb = lo[: 75 * M].reshape(75, M).min(1)
    sh, sl = swings(hb, True), swings(lb, False)
    for j in range(START, STOP + 1):
        h0, h1, l0, l1 = at(sh, j, 0), at(sh, j, 1), at(sl, j, 0), at(sl, j, 1)
        if None in (h0, h1, l0, l1):
            continue
        side = None
        if h0 > h1 and l0 > l1 and c[j] > h0:
            side = "up"
        elif h0 < h1 and l0 < l1 and c[j] < l0:
            side = "down"
        if side:
            exit_at = CAP
            for k in range(j + 1, CAP):
                ref = at(sl, k, 0) if side == "up" else at(sh, k, 0)
                if ref is not None and ((c[k] < ref) if side == "up" else (c[k] > ref)):
                    exit_at = k + 1
                    break
            return j, side, exit_at
    return None, None, CAP


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="lo", default="2024-10-09")
    ap.add_argument("--to", dest="hi", default="2024-11-08")
    args = ap.parse_args()
    lo, hi = date.fromisoformat(args.lo), date.fromisoformat(args.hi)
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from trading_data.db import data_root

    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.ruletest import expr as E
    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest.spec import from_dict
    from option_backtesting.ruletest.study import exit_minutes, find_events

    root = data_root()
    rule = from_dict(RULE)
    fr = F.load_frame(root, "NIFTY", hi)
    events = {e["day"]: e for e in find_events(rule, fr, lo, hi)[0]}
    exits = exit_minutes(rule, fr, {(e["day"], e["entry"], e["side"]) for e in events.values()})
    reference, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    mismatches, rows, n = [], [], 0
    for i, day in enumerate(fr.days):
        if not (lo.isoformat() <= day <= hi.isoformat()):
            continue
        n += 1
        j, side, exit_at = by_hand(fr.H[i], fr.L[i], fr.C[i])
        g = events.get(day)
        if (g is None) != (j is None) or (g and (g["stamp"], g["side"]) != (j, side)):
            mismatches.append((day, j, side, g and (g["stamp"], g["side"])))
            continue
        if g is None:
            continue
        gx = exits[(day, g["entry"], g["side"])]
        if gx != E.stamp_to_clock(min(exit_at, CAP)):
            mismatches.append((day, "exit", E.stamp_to_clock(exit_at), gx))
        data = load_day(root, "NIFTY", date.fromisoformat(day))
        res = simulate_day(
            rule.strategy_for(g["entry"], g["side"], None, gx), data, reference, sizing
        )
        for t in res.trades:
            rows.append({"day": day, "side": side, "signal": E.stamp_to_clock(j), "entry": g["entry"],
                         "contract": f"{t.contract[1]:g}{t.contract[2]}", "entry_price": t.entry_price,
                         "exit_at": E.stamp_to_clock(t.exit_min), "exit_price": t.exit_price,
                         "reason": t.exit_reason, "gross": round(t.pnl, 2)})  # fmt: skip
    out = HERE / "out" / "pilot"
    out.mkdir(parents=True, exist_ok=True)
    if rows:
        with (out / "trades.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    print(f"{n} sessions, {len(events)} events; grammar vs by hand mismatches: {len(mismatches)}")
    for m in mismatches[:8]:
        print("  ", m)
    for r in rows:
        print("  ", r)
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
