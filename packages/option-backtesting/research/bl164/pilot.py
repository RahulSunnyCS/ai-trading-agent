"""BL-164 Phase 2 pilot: one month of the learning period, looked at by hand before the full run.

For every session it re-derives the chain's decisions in plain Python (gap, opening range, bands,
stand-down reason, Williams levels) and checks them against the rule grammar's stamps, then
simulates each H3 event's trade with the legwise engine and lists strike, fills and exit. It
records nothing in the rule tester's ledger and writes no simulation cache:

    uv run python research/bl164/pilot.py [--from 2024-10-09 --to 2024-11-08]

Output: out/pilot/days.csv (one row per session), out/pilot/trades.csv (one row per event).
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
from specs import specs  # noqa: E402

OR_END = 30  # 09:45
BAND_FROM, BAND_TO = 31, 165  # 09:46 .. 12:00
W_TO = 314  # 14:29
P1515 = 360  # 15:15


def _first(mask: np.ndarray, lo: int, hi: int) -> int | None:
    hits = np.flatnonzero(mask[lo : hi + 1])
    return lo + int(hits[0]) if len(hits) else None


def by_hand(fr, i: int) -> dict:
    """The published rules for session i, written out without the grammar."""
    o, h, lo_, c = fr.O[i], fr.H[i], fr.L[i], fr.C[i]
    p = fr.C[i - 1, P1515]
    gap = (o[0] - p) / p
    out: dict = {"gap_pct": round(gap * 100, 3), "p1515": round(p, 2)}
    if gap == 0 or np.isnan(gap):
        return {**out, "reason": "no_gap", "h1": None, "h2": None}
    or_hi, or_lo = c[: OR_END + 1].max(), c[: OR_END + 1].min()
    w = or_hi - or_lo
    band_up, band_down = or_hi + 0.1 * w, or_lo - 0.1 * w
    up = _first(c > band_up, BAND_FROM, BAND_TO)
    down = _first(c < band_down, BAND_FROM, BAND_TO)
    touch = _first((lo_ <= p) & (h >= p), 0, 374)
    own, opp = (up, down) if gap > 0 else (down, up)
    out.update(or_hi=or_hi, or_lo=or_lo, band_up=round(band_up, 2), band_down=round(band_down, 2))
    if opp is not None and (own is None or opp < own):
        reason, stand = "opposite_first", opp
    elif own is not None and touch is not None and touch < own:
        reason, stand = "filled", own
    elif own is not None:
        return {**out, "reason": "h1", "h1": own, "h2": None, "side": "up" if gap > 0 else "down"}
    else:
        return {**out, "reason": "no_break", "h1": None, "h2": None}
    prev_c = fr.C[i - 1]
    r = prev_c.max() - prev_c.min()
    w_up, w_down = o[0] + 0.5 * r, o[0] - 0.5 * r
    out.update(stand_down=stand, w_up=round(w_up, 2), w_down=round(w_down, 2))
    ag = abs(gap)
    if 0.002 <= ag < 0.005:
        return {**out, "reason": f"{reason}, mid gap", "h1": None, "h2": None}
    beyond = (c > w_up) | (c < w_down)
    h2 = _first(beyond, stand + 1, W_TO)
    side = None if h2 is None else ("up" if c[h2] > w_up else "down")
    return {**out, "reason": reason, "h1": None, "h2": h2, "side": side}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="lo", default="2024-10-09")
    ap.add_argument("--to", dest="hi", default="2024-11-08")
    args = ap.parse_args()
    lo, hi = date.fromisoformat(args.lo), date.fromisoformat(args.hi)
    if not (date(2024, 10, 9) <= lo <= hi <= date(2026, 10, 8)):
        raise SystemExit("the pilot stays inside the learning period (2024-10-09 to 2026-10-08)")

    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from trading_data.db import data_root

    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import backtest_days, load_day, minute_index
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.ruletest import charges
    from option_backtesting.ruletest import expr as E
    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest.spec import from_dict
    from option_backtesting.ruletest.study import find_events

    root = data_root()
    rules = {b["id"].split("_")[1]: from_dict(b) for b in specs()}
    fr = F.load_frame(root, "NIFTY", hi)
    usable = {d.isoformat() for d in backtest_days(root, "NIFTY", lo, hi)[0]}
    grammar = {k: {e["day"]: e for e in find_events(r, fr, lo, hi)[0]} for k, r in rules.items()}

    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    out = HERE / "out" / "pilot"
    out.mkdir(parents=True, exist_ok=True)
    day_rows, trade_rows, mismatches = [], [], []
    for i, day in enumerate(fr.days):
        if not (lo.isoformat() <= day <= hi.isoformat()):
            continue
        hand = by_hand(fr, i)
        g1, g2, g3 = (grammar[k].get(day) for k in ("h1", "h2", "h3"))
        stamp = lambda e: None if e is None else e["stamp"]  # noqa: E731
        if stamp(g1) != hand["h1"] or stamp(g2) != hand["h2"]:
            mismatches.append((day, hand["h1"], stamp(g1), hand["h2"], stamp(g2)))
        if stamp(g3) != (hand["h1"] if hand["h1"] is not None else hand["h2"]):
            mismatches.append((day, "h3", stamp(g3)))
        row = {
            "day": day,
            "usable": day in usable,
            **{k: v for k, v in hand.items() if k not in ("h1", "h2")},
            "h1": None if hand["h1"] is None else E.stamp_to_clock(hand["h1"]),
            "h2": None if hand["h2"] is None else E.stamp_to_clock(hand["h2"]),
        }
        if "stand_down" in row:
            row["stand_down"] = E.stamp_to_clock(row["stand_down"])
        day_rows.append(row)
        if g3 is None or day not in usable:
            continue
        data = load_day(root, "NIFTY", date.fromisoformat(day))
        entry = g3["entry"]
        spot = data.spot.price_at(minute_index(entry))
        result = simulate_day(rules["h3"].strategy_for(entry, g3["side"]), data, reference, sizing)
        orders, buy, sell = charges.trade_values(result.trades)
        for t in result.trades:
            trade_rows.append(
                {
                    "day": day,
                    "bot": "H1" if g1 is not None else "H2",
                    "side": g3["side"],
                    "signal": E.stamp_to_clock(g3["stamp"]),
                    "entry": entry,
                    "spot": spot,
                    "contract": f"{t.contract[1]:g}{t.contract[2]} {t.contract[0]}",
                    "itm_points": round(spot - t.contract[1] if t.contract[2] == "CE"
                                        else t.contract[1] - spot, 1),
                    "entry_price": t.entry_price,
                    "exit_at": E.stamp_to_clock(t.exit_min) if t.exit_min is not None else "",
                    "exit_price": t.exit_price,
                    "reason": t.exit_reason,
                    "gross": round(t.pnl, 2),
                    "orders": orders,
                    "notes": "; ".join(result.notes),
                }
            )  # fmt: skip
        if not result.trades:
            trade_rows.append({"day": day, "notes": "; ".join(result.notes) or "no trade"})

    for name, rows in (("days.csv", day_rows), ("trades.csv", trade_rows)):
        keys = list(dict.fromkeys(k for r in rows for k in r))
        with (out / name).open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            writer.writerows(rows)
    reasons: dict[str, int] = {}
    for r in day_rows:
        reasons[r["reason"]] = reasons.get(r["reason"], 0) + 1
    print(f"{len(day_rows)} sessions {lo}..{hi}; reasons {reasons}")
    print(f"events: H1 {len(grammar['h1'])}, H2 {len(grammar['h2'])}, H3 {len(grammar['h3'])}")
    print(f"grammar vs by-hand mismatches: {len(mismatches)} {mismatches[:5]}")
    print(f"wrote {out}/days.csv and trades.csv")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
