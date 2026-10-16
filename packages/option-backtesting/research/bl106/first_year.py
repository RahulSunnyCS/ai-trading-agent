"""BL-106 step 1: BL-104 Stage 1 figures recomputed on the first year only (2024-10-09 -> 2025-10-08).

Reads the stored Stage 1 summaries and day x cell series (after charges) and writes
`results/stage1_y1/<family>_summary.csv` plus first-year slices of the series, in the shape
`research/bl104/score.py` reads, so the registered scoring runs unchanged on first-year data.
P&L figures come from the first-year series; day-stop rate, entry rate and Buy hit rate are not in the
series and stay at their full-window values (disclosed in BL-106 Phase 0); profit factor is day-level.

    python research/bl106/first_year.py
"""

from __future__ import annotations

import csv
import json
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
BL104 = HERE.parent / "bl104" / "results"
SRC = BL104 / "stage1"
OUT = BL104 / "stage1_y1"
CUT = date(2025, 10, 8)
YEAR = 252


def metrics(v: np.ndarray) -> dict[str, float]:
    n = len(v)
    eq = np.cumsum(v)
    under = eq - np.maximum.accumulate(np.maximum(eq, 0.0))
    dd = float(under.min()) if n else 0.0
    ulcer = float(np.sqrt((np.minimum(under, 0.0) ** 2).mean())) if n else float("nan")
    annual = float(v.mean() * YEAR) if n else float("nan")
    wins, losses = v[v > 0].sum(), -v[v < 0].sum()
    k = max(1, math.ceil(n * 0.05))
    return {
        "n_days": n,
        "net_inr": float(v.sum()),
        "avg_day_inr": float(v.mean()),
        "median_day_inr": float(np.median(v)),
        "win_rate": float((v > 0).mean()),
        "worst_day_inr": float(v.min()),
        "max_drawdown_inr": dd,
        "ulcer_index_inr": ulcer,
        "cvar95_day_inr": float(np.sort(v)[:k].mean()),
        "annual_net_inr": annual,
        "calmar": annual / abs(dd) if dd < 0 else float("inf"),
        "martin": annual / ulcer if ulcer > 0 else float("inf"),
        "profit_factor": float(wins / losses) if losses > 0 else float("inf"),
        "return_on_capital_pct": float("nan"),
    }


def main() -> None:
    (OUT / "series").mkdir(parents=True, exist_ok=True)
    for fam in "WDB":
        with (SRC / f"{fam}_summary.csv").open(newline="") as h:
            rows = list(csv.DictReader(h))
        by_cohort: dict[str, list[dict]] = {}
        for r in rows:
            by_cohort.setdefault(r["cohort"], []).append(r)
        out = []
        for cohort, rs in by_cohort.items():
            m = np.load(SRC / "series" / f"{cohort}.npy").astype(float)
            meta = json.loads((SRC / "series" / f"{cohort}.json").read_text())
            keep = np.array([date.fromisoformat(d) <= CUT for d in meta["days"]])
            col = {lab: i for i, lab in enumerate(meta["labels"])}
            sliced = m[keep]
            np.save(OUT / "series" / f"{cohort}.npy", sliced.astype(np.float32))
            (OUT / "series" / f"{cohort}.json").write_text(
                json.dumps(
                    {**meta, "days": [d for d, k in zip(meta["days"], keep, strict=True) if k]}
                )
            )
            for r in rs:
                out.append({**r, **metrics(sliced[:, col[r["label"]]])})
        with (OUT / f"{fam}_summary.csv").open("w", newline="") as h:
            w = csv.DictWriter(h, fieldnames=list(out[0]))
            w.writeheader()
            w.writerows(out)
        print(f"{fam}: {len(out)} cells, first-year days {int(keep.sum())}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
