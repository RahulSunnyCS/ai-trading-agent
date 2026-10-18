"""BL-126 Q1 (standalone, net of charges), as registered: per day, the mean over the 25 slots of
(arm minus Core `N_p100`) at the same slot; mean per lot-day with a two-sided 90 % circular block
bootstrap (5-day blocks over the ordered days, 2,000 resamples, seed 20261018); per slot
(descriptive) and the max drawdown of the slot-averaged series. Exploratory, in-sample.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl126/q1.py
"""

from __future__ import annotations

import json
from datetime import date

import numpy as np
from common import ARMS, RESULTS, arm_names, core_names, slot_of

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown

BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261018, 0.90


def read_new(name: str) -> dict[date, float]:
    """Net of one new variant from this folder's result files (the live store's column layout)."""
    import csv

    with (RESULTS / "rotation" / "results" / f"{name}.csv").open() as f:
        return {date.fromisoformat(r["day"]): float(r["net"]) for r in csv.DictReader(f)}


def stops(name: str, new: bool, root, days) -> float:
    import csv

    path = (
        RESULTS / "rotation" / "results" / f"{name}.csv" if new else store.result_path(name, root)
    )
    with path.open() as f:
        rows = {date.fromisoformat(r["day"]): r["stopped_by"] for r in csv.DictReader(f)}
    return float(np.mean([bool(rows[d]) for d in days]))


def main() -> None:
    root = data_dir()
    cores = core_names()
    core = {n: store.read_net(n, root) for n in cores}
    days = sorted(set.intersection(*[set(v) for v in core.values()]))
    C = np.array([[core[n][d] for n in cores] for d in days])  # days x 25
    out: dict = {
        "days": len(days),
        "first_day": days[0].isoformat(),
        "last_day": days[-1].isoformat(),
        "weekend_sessions": sum(d.weekday() >= 5 for d in days),
        "slots": [slot_of(n) for n in cores],
        "block": BLOCK,
        "resamples": RESAMPLES,
        "seed": SEED,
        "level": LEVEL,
        "core": {
            "mean_per_lot_day": float(C.mean()),
            "max_drawdown": max_drawdown(C.mean(axis=1)),
            "overall_stop_share": float(np.mean([stops(n, False, root, days) for n in cores])),
        },
    }
    for arm in ARMS:
        names = arm_names(arm)
        new = {n: read_new(n) for n in names}
        assert all(set(v) == set(days) for v in new.values()), "new variant days differ from Core"
        X = np.array([[new[n][d] for n in names] for d in days])
        diff_day = (X - C).mean(axis=1)
        mean, lo, hi = block_bootstrap_mean(diff_day, RESAMPLES, BLOCK, SEED, LEVEL)
        dd_arm, dd_core = max_drawdown(X.mean(axis=1)), max_drawdown(C.mean(axis=1))
        per_slot = []
        for j, n in enumerate(cores):
            m, a, b = block_bootstrap_mean(X[:, j] - C[:, j], RESAMPLES, BLOCK, SEED, LEVEL)
            per_slot.append(
                {
                    "slot": slot_of(n),
                    "core_mean": float(C[:, j].mean()),
                    "arm_mean": float(X[:, j].mean()),
                    "diff": m,
                    "ci90": [a, b],
                    "core_max_dd": max_drawdown(C[:, j]),
                    "arm_max_dd": max_drawdown(X[:, j]),
                }
            )
        wins = sum(1 for s in per_slot if s["diff"] > 0)
        out[arm] = {
            "premium": ARMS[arm]["premium"],
            "sl_percent": ARMS[arm]["sl"],
            "arm_mean_per_lot_day": float(X.mean()),
            "core_mean_per_lot_day": float(C.mean()),
            "diff_mean": mean,
            "ci90": [lo, hi],
            "arm_max_drawdown": dd_arm,
            "core_max_drawdown": dd_core,
            "drawdown_no_deeper": bool(dd_arm >= dd_core),
            "reading": "positive" if (lo > 0 and dd_arm >= dd_core) else "not positive",
            "interval_above_zero": bool(lo > 0),
            "slots_with_positive_diff": wins,
            "overall_stop_share": float(np.mean([stops(n, True, root, days) for n in names])),
            "per_slot": per_slot,
        }
        print(
            f"{arm} (₹{ARMS[arm]['premium']}, SL {ARMS[arm]['sl']}%): arm {X.mean():+.1f} core "
            f"{C.mean():+.1f} diff {mean:+.1f} CI90 [{lo:+.1f}, {hi:+.1f}] "
            f"DD arm {dd_arm:,.0f} core {dd_core:,.0f} slots+ {wins}/25 -> {out[arm]['reading']}"
        )
    (RESULTS / "q1.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
