"""BL-237 follow-up (descriptive, after the verdict): buy a long straddle (ATM) or a long strangle (OTM1, OTM2) every session at
15:30, sell at 09:17 next day, NIFTY and SENSEX (owner, 2026-11-20).

Not part of the registered rule. Same prices, lots, costs and slippage as sim.py (1 lot, 4 orders at 20 x 1.18, 0.5% adverse
slippage on every fill). Per index, every session D whose next trading day E has bars; the straddle is the nearest listed
expiry STRICTLY AFTER D (a weekly that expires on D itself is gone by 15:30, so that night rolls to the next one).

    uv run python research/bl237/long_only.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from trading_data import db, quality

from option_backtesting.data.providers.base import Right
from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.data.resolver import resolve_strike
from option_backtesting.legwise import market

STRUCTURES = ("ATM", "OTM1", "OTM2")  # ATM = straddle; OTMn = strangle n steps out on each side

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyse as an  # noqa: E402
import sim  # noqa: E402


def run(root: Path, ref: ReferenceData):
    days_cache = sim.Days(root)
    out, skipped = [], 0
    for u in sim.INDEXES:
        avail = set(market.available_days(root, u))
        bad = quality.excluded_days(root, "option", u) or {}
        lot = ref.lot_size(u, sim.SIZING)
        for d in sorted(x for x in avail if x >= sim.START):
            e = sim.next_trading_day(ref, d)
            if e not in avail or d in bad or e in bad:
                skipped += 1
                continue
            din, dout = days_cache.get(u, d), days_cache.get(u, e)
            later = [x for x in din.listed if x > d]
            if not later:
                skipped += 1
                continue
            exp = later[0]
            spot = din.spot.price_at(sim.ENTRY_MIN) if din.spot is not None else None
            if spot is None:
                skipped += 1
                continue
            spot_out = dout.spot.price_at(sim.EXIT_MIN) if dout.spot is not None else None
            for rule in STRUCTURES:
                keys = [
                    (
                        exp,
                        float(resolve_strike(u, rule, side, spot, as_of=d, reference=ref).strike),
                        s_,
                    )
                    for side, s_ in ((Right.CE, "CE"), (Right.PE, "PE"))
                ]
                legs, ok = [], True
                for key in keys:
                    p_in, _ = din.price_at(key, sim.ENTRY_MIN)
                    p_out, _ = dout.price_at(key, sim.EXIT_MIN)
                    if p_in is None or p_out is None:
                        ok = False
                        break
                    legs.append((p_in, p_out))
                if not ok:
                    skipped += 1
                    continue
                gross = sum((po - pi) * lot for pi, po in legs)
                slipped = sum((po * (1 - sim.SLIP) - pi * (1 + sim.SLIP)) * lot for pi, po in legs)
                out.append(
                    {
                        "u": u,
                        "rule": rule,
                        "day": d,
                        "window": "fit" if d <= sim.FIT_END else "test",
                        "net": slipped - 4 * sim.COST_PER_ORDER,
                        "gross": gross,
                        "gap": abs((spot_out - spot) / spot * 100) if spot_out else float("nan"),
                        "to_exp": (exp - e).days,
                        "weekday": d.weekday(),
                        "premium": sum(pi for pi, _ in legs) * lot,
                    }
                )
    return out, skipped


def show(label: str, rows: list[dict], key: str = "net"):
    v = np.array([r[key] for r in rows])
    if not len(v):
        return
    lo, hi = an.boot(v)
    print(
        f"  {label:<26} n={len(v):>3} mean {v.mean():>7.0f}  90% [{lo:>6.0f},{hi:>6.0f}]  win {100 * (v > 0).mean():>3.0f}%  "
        f"worst {v.min():>7.0f}  best {v.max():>7.0f}  maxDD {an.max_dd(v):>8.0f}  total {v.sum():>9.0f}"
    )


def main():
    root, ref = db.data_root(), ReferenceData()
    rows, skipped = run(root, ref)
    print(f"{len(rows)} structure-nights, {skipped} skipped")
    for rule in STRUCTURES:
        rr = [r for r in rows if r["rule"] == rule]
        name = "ATM straddle" if rule == "ATM" else f"{rule} strangle"
        print(
            f"\n##### {name}: {len(rr)} nights, mean premium Rs {np.mean([r['premium'] for r in rr]):.0f}"
        )
        for key, title in (
            ("net", "NET (0.5% slippage, 4 orders)"),
            ("gross", "GROSS (no slippage, no brokerage)"),
        ):
            print(f" {title}")
            for w in ("fit", "test", "all"):
                for u in ("NIFTY", "SENSEX"):
                    show(
                        f"{w} {u}",
                        [r for r in rr if (w == "all" or r["window"] == w) and r["u"] == u],
                        key,
                    )
        print(" NET by |overnight gap|, both indexes, all nights")
        for lo, hi, n in (
            (0, 0.25, "<0.25%"),
            (0.25, 0.5, "0.25-0.5%"),
            (0.5, 1, "0.5-1%"),
            (1, 99, ">1%"),
        ):
            show(n, [r for r in rr if lo <= r["gap"] < hi])
        print(" NET: the straddle expires next morning (0 days) vs later")
        show("expires E", [r for r in rr if r["to_exp"] == 0])
        show("expires after E", [r for r in rr if r["to_exp"] > 0])


if __name__ == "__main__":
    main()
