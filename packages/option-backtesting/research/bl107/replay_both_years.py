"""BL-107: Adaptive (registered list C, no weight) over Core-298, T1, T2 and New-556, every day after
the 63-day warm-up from 2024-10-09 to 2026-10-09, history from 2024-10-09 for every universe.
First-year figures are IN-SAMPLE for T1, T2 and New-556 (they were chosen on that year).

    uv run python research/bl107/replay_both_years.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import replay as rp  # noqa: E402

from option_backtesting.rotation import score, variants  # noqa: E402

FAM = {"w": "wide", "d": "dir", "b": "buy"}
_orig = variants.parts


def parts(name: str) -> tuple[str, str, str]:
    a, b, c = name.split("_")
    if len(b) == 3 and b[0] in FAM and b[1] in "ABCD":
        return a, FAM[b[0]], c
    if len(b) >= 3 and b[0] in FAM and b[1] in "EO" and b[2:].isdigit():
        return a, FAM[b[0]], c
    return _orig(name)


variants.parts = parts
score.parts = parts

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import (  # noqa: E402
    is_buy,
    is_dir,
    is_wide,
    variant_names,
)

CUT = date(2025, 10, 9)
END = date(2026, 10, 9)


def load(dirs: list[Path]) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for d in dirs:
        for f in sorted(d.glob("*.npz")):
            z = np.load(f)
            for j, n in enumerate(z["names"]):
                out.setdefault(str(n), {}).update({str(day): float(z["gross"][i, j]) for i, day in enumerate(z["days"])})
    return out


def main() -> None:
    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    res = HERE / "results"
    added = load([res / "sim_early" / "t1t2", res / "sim"])
    pool = load([res / "sim_early" / "pool", HERE.parent / "bl106" / "results" / "sim", HERE.parent / "bl106" / "results" / "sim_ext"])
    cells = {c["name"]: c for c in json.loads((res / "cells.json").read_text())}
    allsrc = {**added, **pool}
    days = sorted(set(d for d in m.days if d in attrs and d <= END and d.weekday() < 5)
                  & set.intersection(*(set(date.fromisoformat(x) for x in c) for c in allsrc.values())))
    mi = {d: i for i, d in enumerate(m.days)}
    coreG = np.array([[m.values[mi[d], j] for j in range(len(m.names))] for d in days])

    def mat(names: list[str]) -> np.ndarray:
        return np.array([[allsrc[n][d.isoformat()] for n in names] for d in days])

    t1 = [n for n in sorted(added) if cells[n]["universe"] == "T1"]
    t2 = [n for n in sorted(added) if cells[n]["universe"] == "T2"]
    pl = sorted(pool)
    U = {
        "Core-298": (list(m.names), coreG),
        "T1 (Core + 223)": (list(m.names) + t1, np.hstack([coreG, mat(t1)])),
        "T2 (Core + 379)": (list(m.names) + t2, np.hstack([coreG, mat(t2)])),
        "New-556 only": (pl, mat(pl)),
        "Core + New-556": (list(m.names) + pl, np.hstack([coreG, mat(pl)])),
    }
    replay_days = days[WARMUP:]
    exp = rp.expiry_days()
    out = {}
    for label, (names, G) in U.items():
        r = rp.replay(days, names, G, G, attrs, replay_days, 0.0, [""] * len(names), exp)
        out[label] = (np.array(r["C"]["gross"]), [p for ps in r["C"]["picks"] for p in ps], len(names))
        print(f"  replayed {label}", flush=True)
    first = np.array([d < CUT for d in replay_days])
    print(f"\nAdaptive, gross per lot-day. First year {replay_days[0]} -> 2025-10-08 ({first.sum()} days; IN-SAMPLE for"
          f" T1, T2, New-556), test year 2025-10-09 -> {replay_days[-1]} ({(~first).sum()} days)\n")
    print(f"{'universe':18s}{'size':>5s}  {'1st yr':>7s}{'maxDD':>9s}{'win':>5s}{'vs Core':>9s}   {'test yr':>7s}{'maxDD':>9s}{'win':>5s}{'vs Core':>9s}{'90% interval':>17s}")
    base = out["Core-298"][0]
    for label, (g, _picks, n) in out.items():
        row = f"{label:18s}{n:5d}  "
        for mask in (first, ~first):
            x = g[mask]
            row += f"{x.mean():7.0f}{max_drawdown(x):9,.0f}{np.mean(x > 0):5.0%}{(x - base[mask]).mean():+9.0f}   "
        if label != "Core-298":
            mean, lo, hi = block_bootstrap_mean(g[~first] - base[~first])
            row += f"  [{lo:+6.0f},{hi:+6.0f}]"
        print(row)
    print("\npick mix (both years): " + "; ".join(
        f"{k} W{np.mean([is_wide(p) for p in v[1]]):.0%}/D{np.mean([is_dir(p) for p in v[1]]):.0%}/B{np.mean([is_buy(p) for p in v[1]]):.0%}"
        for k, v in out.items()))


if __name__ == "__main__":
    main()
