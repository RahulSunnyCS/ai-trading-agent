"""BL-071 part A: DRB-6W3L2 on 2025-01-10 -> 2025-08-29, scored from results that already existed.

    uv run --with pandas --with numpy --with duckdb python research/bl071/analyse.py

Runs rotate.py --window-from 2024-10-09 for the four BL-067 weight rows (if their picks files are
missing), cuts each picks file at 2025-09-01, and applies the read-out registered in
backlog/BL-071-drb-out-of-period-and-2022-import.md.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
BL57 = HERE.parent / "bl057"
CUT = pd.Timestamp("2025-09-01")
ROWS = {
    "baseline": (33, 25, 25, 17),
    "recent-only": (100, 0, 0, 0),
    "no-recent": (0, 33, 33, 34),
    "no-vix": (40, 30, 30, 0),
}
IN_SAMPLE_GAP_PER_DAY = 204_763 / 202  # baseline - no-recent, BL-068 (202 selection days)
STEM = "daily_picks_min3_core6_buy2L2_whole_day"


def picks_file(w) -> Path:
    suffix = "" if w == ROWS["baseline"] else "_w" + "_".join(map(str, w))
    return BL57 / f"{STEM}{suffix}_from2024-10-09.csv"


def ensure(w) -> None:
    f = picks_file(w)
    if f.exists():
        return
    subprocess.run(
        [sys.executable, str(BL57 / "rotate.py"), "--basket", "DRB-6W3L2", "--window-from", "2024-10-09"]
        + ([] if w == ROWS["baseline"] else ["--weights", ",".join(map(str, w))]),
        capture_output=True,
        text=True,
        check=True,
        cwd=HERE.parent.parent,
    )
    assert f.exists(), f


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def block_bootstrap(diff: np.ndarray, block: int = 5, n: int = 2000, seed: int = 71):
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(len(diff) / block))
    starts = np.arange(0, len(diff) - block + 1)
    tots = np.empty(n)
    for r in range(n):
        ix = np.concatenate([np.arange(s, s + block) for s in rng.choice(starts, nb)])[: len(diff)]
        tots[r] = diff[ix].sum()
    return float(np.percentile(tots, 5)), float(np.percentile(tots, 95))


def random_picks(days: pd.DatetimeIndex, n_buy: np.ndarray, n: int = 1000, seed: int = 57):
    """The BL-057 random comparator on the slice: 3 core strategies x 2 lots, at least 2 Widesl, the
    Buy strategy on the days the rule bought one."""
    sys.argv = ["rotate.py", "--basket", "DRB-6W3L2", "--window-from", "2024-10-09"]
    sys.path.insert(0, str(BL57))
    import rotate as R  # noqa: E402

    P, _ = R.load_all()
    names = list(P.columns)
    is_wide, _, is_buy, _ = R.variant_masks(names)
    core_pool, buy_pool = np.where(~is_buy)[0], np.where(is_buy)[0]
    Pv = P.loc[days].to_numpy()
    rng = np.random.default_rng(seed)
    tot = np.empty(n)
    for r in range(n):
        t = 0.0
        for j in range(len(days)):
            while True:
                ix = rng.choice(core_pool, R.N_CORE, replace=False)
                if is_wide[ix].sum() >= R.MIN_WIDE_N:
                    break
            v = Pv[j, ix].sum()
            if n_buy[j]:
                v += Pv[j, rng.choice(buy_pool, n_buy[j], replace=False)].sum()
            t += R.LOTS_PER * v
        tot[r] = t
    return tot


def main() -> None:
    for w in ROWS.values():
        ensure(w)
    sl = {}
    for k, w in ROWS.items():
        d = pd.read_csv(picks_file(w), parse_dates=["day"]).set_index("day")
        sl[k] = d[d.index < CUT]
    days = sl["baseline"].index
    print(f"slice: {days[0].date()} -> {days[-1].date()}, {len(days)} selection days (before {CUT.date()})\n")
    print(f"{'row':12s} {'gross':>10s} {'max DD':>10s} {'win%':>6s} {'per day':>8s} {'lots/day':>8s}")
    for k, d in sl.items():
        p = d.pnl_A
        print(f"{k:12s} {p.sum():>10,.0f} {mdd(p):>10,.0f} {100 * (p > 0).mean():>6.1f} {p.mean():>8,.0f} {d.lots.mean():>8.2f}")
    b, nr = sl["baseline"].pnl_A.to_numpy(), sl["no-recent"].pnl_A.to_numpy()
    tot = random_picks(days, sl["baseline"].n_buy.to_numpy())
    p50, p90 = np.percentile(tot, 50), np.percentile(tot, 90)
    beats = float((tot < b.sum()).mean())
    gap = b.sum() - nr.sum()
    lo, hi = block_bootstrap(b - nr)
    print(f"\nrandom picks (n=1000): P50 {p50:,.0f} | P90 {p90:,.0f} | max {tot.max():,.0f}; baseline beats {100 * beats:.0f}%")
    print(f"(1) baseline >= random P90: {b.sum() >= p90}")
    print(f"(2) baseline - no-recent: {gap:,.0f}, 90% block-bootstrap interval [{lo:,.0f}, {hi:,.0f}] -> excludes zero: {lo > 0}")
    print(
        f"(3) per-day gap {gap / len(days):,.0f} vs half the in-sample {IN_SAMPLE_GAP_PER_DAY / 2:,.0f} -> {gap / len(days) >= IN_SAMPLE_GAP_PER_DAY / 2}"
    )
    ok = (b.sum() >= p90) and lo > 0 and gap / len(days) >= IN_SAMPLE_GAP_PER_DAY / 2
    print("\nVERDICT:", "recent edge CONFIRMED out of period" if ok else "NOT confirmed (see which condition failed)")
    for k in ("recent-only", "no-vix"):
        print(f"report only: baseline - {k}: {b.sum() - sl[k].pnl_A.sum():,.0f}")


if __name__ == "__main__":
    main()
