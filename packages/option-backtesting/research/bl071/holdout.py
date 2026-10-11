"""BL-071 part B: the registered rows on the 2022–2024 hold-out (NIFTY-only, imported days).

    uv run --with pandas --with numpy --with duckdb python research/bl071/holdout.py [parallel]

Each row = rotate.py --basket DRB-6W3L2 --nifty-only --early-results research/bl071/results
--window-from 2022-01-03 <row args>. The hold-out slice is the selection days before 2024-10-09 (the
day the main results start); the read-out is the one registered in
backlog/BL-071-drb-out-of-period-and-2022-import.md (part B). Writes out/holdout.csv.
"""

from __future__ import annotations

import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

CUT = pd.Timestamp("2024-10-09")
COMMON = ["--nifty-only", "--early-results", str(HERE / "results"), "--window-from", "2022-01-03"]
LB = ["--fit-lookbacks"]
ROWS = {
    "baseline 33/25/25/17": ["--weights", "33,25,25,17"],
    "recent-only": ["--weights", "100,0,0,0"],
    "no-recent 0/33/33/34": ["--weights", "0,33,33,34"],
    "no-vix 40/30/30/0": ["--weights", "40,30,30,0"],
    "B3 baseline + 21/63": ["--weights", "33,25,25,17", *LB, "21:50,63:50"],
    "B3 baseline + 63/126": ["--weights", "33,25,25,17", *LB, "63:50,126:50"],
    "recent-only + family 0.5": ["--weights", "100,0,0,0", "--recent-family", "0.5"],
    "BL-072 25/15/15/20/0/25 21/63": ["--weights", "25,15,15,20,0,25", *LB, "21:50,63:50"],
    "BL-072 25/15/15/20/0/25 63/126": ["--weights", "25,15,15,20,0,25", *LB, "63:50,126:50"],
    "BL-072 25/15/15/10/10/25 21/63": ["--weights", "25,15,15,10,10,25", *LB, "21:50,63:50"],
    "BL-072 25/15/15/10/10/25 63/126": ["--weights", "25,15,15,10,10,25", *LB, "63:50,126:50"],
    "BL-072a 30/20/20/0/0/30 63/126": ["--weights", "30,20,20,0,0,30", *LB, "63:50,126:50"],
    "BL-072d 40/20/20/10/0/10 63/126": ["--weights", "40,20,20,10,0,10", *LB, "63:50,126:50"],
}
IN_SAMPLE_GAP_PER_DAY = 204_763 / 202


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


def run(item):
    name, args = item
    tag = re.sub(r"[^A-Za-z0-9]+", "_", name)
    cache = HERE / "out" / f"holdout_{tag}.txt"
    cache.parent.mkdir(exist_ok=True)
    if cache.exists() and "picks file:" in cache.read_text():
        out = cache.read_text()
    else:
        out = subprocess.run(
            [sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *args, *COMMON],
            capture_output=True, text=True, cwd=HERE.parent.parent,
        ).stdout
        cache.write_text(out)
    picks = Path([x for x in out.splitlines() if x.startswith("picks file: ")][0].split(": ", 1)[1])
    d = pd.read_csv(picks, parse_dates=["day"]).set_index("day")
    return name, d, parse_case_a(out)


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    with ThreadPoolExecutor(workers) as pool:
        res = list(pool.map(run, ROWS.items()))
    series = {name: d[d.index < CUT].pnl_A for name, d, _ in res}
    rows = []
    for name, _d, _parsed in res:
        s = series[name]
        row = dict(
            row=name,
            holdout_days=len(s),
            gross=s.sum(),
            max_dd=mdd(s),
            win_pct=100 * (s > 0).mean(),
            per_day=s.mean(),
            worst_week=s.groupby(s.index.to_period("W")).sum().min(),
        )
        for y in (2022, 2023, 2024):
            ys = s[s.index.year == y]
            row[f"y{y}"] = ys.sum()
            row[f"y{y}_dd"] = mdd(ys) if len(ys) else np.nan
        rows.append(row)
    t = pd.DataFrame(rows)
    t.to_csv(HERE / "out" / "holdout.csv", index=False)
    days = series["baseline 33/25/25/17"].index
    print(f"hold-out: {days[0].date()} -> {days[-1].date()}, {len(days)} selection days (NIFTY only)\n")
    pd.set_option("display.width", 250)
    print(t.to_string(index=False, float_format=lambda x: f"{x:,.0f}"))

    # random comparator on the hold-out days (same shape; NIFTY-only pool)
    sys.argv = ["rotate.py", "--basket", "DRB-6W3L2", *COMMON]
    sys.path.insert(0, str(HERE.parent / "bl057"))
    import rotate as R  # noqa: E402

    P, _ = R.load_all()
    names = list(P.columns)
    is_wide, _, is_buy, _ = R.variant_masks(names)
    core_pool, buy_pool = np.where(~is_buy)[0], np.where(is_buy)[0]
    base = [d for n, d, _ in res if n == "baseline 33/25/25/17"][0]
    base = base[base.index < CUT]
    Pv = P.loc[base.index].to_numpy()
    n_buy = base.n_buy.to_numpy()
    rng = np.random.default_rng(57)
    tot = np.empty(1000)
    for r in range(1000):
        v_tot = 0.0
        for j in range(len(base)):
            while True:
                ix = rng.choice(core_pool, R.N_CORE, replace=False)
                if is_wide[ix].sum() >= R.MIN_WIDE_N:
                    break
            v = Pv[j, ix].sum()
            if n_buy[j]:
                v += Pv[j, rng.choice(buy_pool, n_buy[j], replace=False)].sum()
            v_tot += R.LOTS_PER * v
        tot[r] = v_tot
    p50, p90 = np.percentile(tot, 50), np.percentile(tot, 90)
    print(f"\nrandom picks on the hold-out (n=1000): P50 {p50:,.0f} | P90 {p90:,.0f} | max {tot.max():,.0f}")
    b, nr = series["baseline 33/25/25/17"].to_numpy(), series["no-recent 0/33/33/34"].to_numpy()
    gap = b.sum() - nr.sum()
    lo, hi = block_bootstrap(b - nr)
    print(f"(1) recent edge: baseline - no-recent {gap:,.0f} per day {gap / len(b):,.0f} (need >= {IN_SAMPLE_GAP_PER_DAY / 2:,.0f}); 90% interval [{lo:,.0f}, {hi:,.0f}] -> holds: {lo > 0 and gap / len(b) >= IN_SAMPLE_GAP_PER_DAY / 2}")
    for k in ("B3 baseline + 21/63", "B3 baseline + 63/126"):
        d = series[k].to_numpy() - b
        lo, hi = block_bootstrap(d)
        print(f"(2) {k}: gain over baseline {d.sum():,.0f}; 90% interval [{lo:,.0f}, {hi:,.0f}] -> holds: {lo > 0}")
    print(f"(3) baseline >= random P90: {b.sum() >= p90} (beats {100 * (tot < b.sum()).mean():.0f}% of random)")
    for k, s in series.items():
        print(f"    {k:34s} >= P90: {str(s.sum() >= p90):5s}  beats {100 * (tot < s.sum()).mean():3.0f}%")


if __name__ == "__main__":
    main()
