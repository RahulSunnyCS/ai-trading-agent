"""BL-105 Phase 1 scoring: every variant against its own base, per slot, then across slots.

Registered rule (backlog/BL-105 Phase 0), per index x slot x base x variant, the variant's daily
net minus the base's daily net:
  r1  5-day block bootstrap 90 % lower bound of the mean difference > 0
  r2  max drawdown and Ulcer no worse than the base's by more than 10 %
  r3  worst day and sum of the five worst days within 1.5 x the base's (magnitudes floored at
      3,000 / 15,000 as in BL-104's tail gate)
  r4  at least 3 of 4 half-years with a mean not below the base's
A variant passes a slot when r1..r4 hold. An idea setting passes an index when it passes in at
least 4 of the 7 slots for one base (the same parameters in every slot).

    python research/bl105/score_screen.py --tag phase1
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bl104"))
import bl105_grid as g  # noqa: E402

from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402

HALVES = (
    (date(2024, 10, 9), date(2025, 3, 31)),
    (date(2025, 4, 1), date(2025, 9, 30)),
    (date(2025, 10, 1), date(2026, 3, 31)),
    (date(2026, 4, 1), date(2026, 10, 9)),
)
FLOORS = {"day": 3000.0, "five": 15000.0}


def ulcer(v: np.ndarray) -> float:
    eq = np.cumsum(v)
    under = eq - np.maximum.accumulate(np.maximum(eq, 0.0))
    return float(np.sqrt((np.minimum(under, 0.0) ** 2).mean())) if v.size else float("nan")


def five(v: np.ndarray) -> float:
    return float(np.sort(v)[:5].sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="phase1")
    args = ap.parse_args()
    out = HERE / "results" / args.tag
    with (out / "summary.csv").open(newline="") as handle:
        summary = {
            (r["index"], r["slot"], r["base"], r["variant"]): r for r in csv.DictReader(handle)
        }
    spec = {v.id: v for v in g.variants()}
    rows = []
    for idx in g.INDICES:
        for slot in g.SLOTS:
            name = f"{idx}_{slot.replace(':', '')}"
            m = np.load(out / "series" / f"{name}.npy").astype(float)
            meta = json.loads((out / "series" / f"{name}.json").read_text())
            col = {lab: i for i, lab in enumerate(meta["labels"])}
            days = np.array([date.fromisoformat(d) for d in meta["days"]])
            for base in sorted({k.split("|")[0] for k in col}):
                b = m[:, col[f"{base}|base"]]
                dd_b, ul_b, wd_b, w5_b = max_drawdown(b), ulcer(b), b.min(), five(b)
                for vid in spec:
                    if vid == "base":
                        continue
                    v = m[:, col[f"{base}|{vid}"]]
                    diff = v - b
                    mean, lo, hi = block_bootstrap_mean(diff)
                    dd_v, ul_v = max_drawdown(v), ulcer(v)
                    r1 = lo > 0
                    r2 = dd_v >= 1.1 * dd_b - 1e-9 and ul_v <= 1.1 * ul_b + 1e-9
                    r3 = v.min() >= -1.5 * max(abs(wd_b), FLOORS["day"]) and five(v) >= -1.5 * max(
                        abs(w5_b), FLOORS["five"]
                    )
                    halves_ok = sum(
                        v[(days >= lo_d) & (days <= hi_d)].mean()
                        >= b[(days >= lo_d) & (days <= hi_d)].mean()
                        for lo_d, hi_d in HALVES
                    )
                    r4 = halves_ok >= 3
                    srow = summary[(idx, slot, base, vid)]
                    rows.append(
                        {
                            "index": idx,
                            "slot": slot,
                            "band": g.band(slot),
                            "base": base,
                            "variant": vid,
                            "idea": spec[vid].idea,
                            "level": spec[vid].level,
                            "restarts": spec[vid].restarts,
                            "base_avg_inr": b.mean(),
                            "var_avg_inr": v.mean(),
                            "diff_mean_inr": mean,
                            "diff_lo90": lo,
                            "diff_hi90": hi,
                            "base_dd": dd_b,
                            "var_dd": dd_v,
                            "base_worst": wd_b,
                            "var_worst": v.min(),
                            "base_worst5": w5_b,
                            "var_worst5": five(v),
                            "halves_ok": halves_ok,
                            "cut_rate": float(srow["cut_rate"]),
                            "restarts_made": int(srow["restarts_made"]),
                            "r1": r1,
                            "r2": r2,
                            "r3": r3,
                            "r4": r4,
                            "pass": r1 and r2 and r3 and r4,
                        }
                    )
    fields = list(rows[0])
    with (out / "screen_scored.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {out / 'screen_scored.csv'}")


if __name__ == "__main__":
    main()
