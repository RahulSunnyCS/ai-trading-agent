"""BL-127 Stage A (selection year only): for each premium, the stop with the highest mean gross per
lot-day averaged over the 25 slots; a tie within ₹5 goes to the smaller max drawdown of the
slot-averaged series. Reported for every cell: mean, drawdown, slots with a positive mean.

Selection year 2024-10-09 -> 2025-10-08. No day on or after 2025-10-09 is used (asserted).
Core's own N_p80 / N_p100 (SL 115 %) cells use their stored results; the 16 others this folder's
simulations. Gross per lot-day throughout (the files carry no per-order cost).

    uv run python research/bl127/stage_a.py
"""

from __future__ import annotations

import json

import numpy as np
from common import (
    PREMIUMS,
    RESULTS,
    SELECTION_END,
    SELECTION_START,
    SLS,
    TEST_START,
    core_slots,
    is_core_cell,
    names_of,
    read_gross,
)

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store
from option_backtesting.rotation.readout import max_drawdown

TIE = 5.0


def cell_matrix(premium: int, sl: int, root) -> tuple[list, np.ndarray]:
    series = []
    for n in names_of(premium, sl):
        path = (
            store.result_path(n, root)
            if is_core_cell(premium, sl)
            else RESULTS / "rotation" / "results" / f"{n}.csv"
        )
        series.append(read_gross(path, SELECTION_END))
    days = sorted(set.intersection(*[set(s) for s in series]))
    days = [d for d in days if d >= SELECTION_START]
    assert all(d < TEST_START for d in days)
    return days, np.array([[s[d] for s in series] for d in days])


def main() -> None:
    root = data_dir()
    slots = core_slots()
    table, winners = {}, {}
    ref_days = None
    for premium in PREMIUMS:
        rows = []
        for sl in SLS:
            days, X = cell_matrix(premium, sl, root)
            ref_days = ref_days or days
            assert days == ref_days, (premium, sl)
            avg = X.mean(axis=1)
            rows.append(
                {
                    "premium": premium,
                    "sl": sl,
                    "core_file": is_core_cell(premium, sl),
                    "mean": float(avg.mean()),
                    "max_drawdown": max_drawdown(avg),
                    "slots_positive": int((X.mean(axis=0) > 0).sum()),
                    "per_slot_mean": dict(zip(slots, map(float, X.mean(axis=0)), strict=True)),
                }
            )
        best = max(r["mean"] for r in rows)
        near = [r for r in rows if r["mean"] >= best - TIE]
        win = max(near, key=lambda r: r["max_drawdown"])  # shallowest fall
        win["winner"] = True
        winners[premium] = {
            "sl": win["sl"],
            "core_file": win["core_file"],
            "tie_candidates": [r["sl"] for r in near],
        }
        table[premium] = rows
        for r in rows:
            print(
                f"₹{premium} SL {r['sl']:>3}  mean {r['mean']:+8.1f}  dd {r['max_drawdown']:>10,.0f}"
                f"  slots+ {r['slots_positive']:>2}/25  {'<- winner' if r.get('winner') else ''}"
            )
    out = {
        "window": [SELECTION_START.isoformat(), SELECTION_END.isoformat()],
        "days": len(ref_days),
        "first_day": ref_days[0].isoformat(),
        "last_day": ref_days[-1].isoformat(),
        "tie_rule_inr": TIE,
        "table": {str(k): v for k, v in table.items()},
        "winners": {str(k): v for k, v in winners.items()},
    }
    assert max(ref_days) < TEST_START
    (RESULTS / "stage_a.json").write_text(json.dumps(out, indent=1))
    print("winners", winners)


if __name__ == "__main__":
    main()
