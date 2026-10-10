"""BL-075: the final map (stage 1), the structural switches on its region (stage 2), shuffles (stage 3).

    uv run --with pandas --with numpy --with duckdb python research/bl075/run_all.py --stage 1 [--workers 4]

Registered in backlog/BL-075-drb-final-map-and-structural-switches.md. Every run is one
`rotate.py --basket DRB-6W{0|3}L2 ...` invocation, cached as text under out/, so a stage resumes.
Relative score = gross / the best stage-1 cell's gross in that period; worst-period score = min over
the three periods; "above chance" = gross >= that run's own random P90 (case A).
"""

from __future__ import annotations

import itertools
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
OUT = HERE / "out"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

LB = ["--fit-lookbacks", "5:30,21:25,63:25,126:20"]
PERIODS = {
    "P1": [],
    "P2": ["--window-from", "2024-10-09", "--window-to", "2025-08-29"],
    "P3": ["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"), "--window-from", "2022-01-03", "--window-to", "2024-10-08"],
}
GRID = [0, 5, 10, 15, 20]
SPLITS = {"baseline": (25, 25, 17), "equal": (1, 1, 1), "novix": (1, 1, 0), "dteheavy": (1, 2, 1)}
STRUCT = {"mw0": [], "nobuy": ["--no-buy"], "nocl": ["--no-closest"]}  # mw0 = DRB-6W0L2 (basket name)


def fit_weights(remainder: int, ratio: tuple[int, int, int]) -> tuple[int, int, int]:
    """Largest-remainder rounding of `remainder` percent in the stated ratio (ties: first criterion)."""
    tot = sum(ratio)
    exact = [remainder * r / tot for r in ratio]
    w = [int(x) for x in exact]
    order = sorted(range(3), key=lambda i: (-(exact[i] - w[i]), i))
    for i in order[: remainder - sum(w)]:
        w[i] += 1
    return w[0], w[1], w[2]


def cell_args(own: int, fam: int, split: str) -> list[str]:
    wd, dt, vx = fit_weights(100 - own - fam, SPLITS[split])
    args = ["--weights", f"{own},{wd},{dt},{vx},0,{fam}", *LB]
    return args + (["--family-key", "band"] if fam else [])


def cells() -> list[tuple[int, int, str]]:
    return [(o, f, s) for s in SPLITS for o in GRID for f in GRID]


def run_one(key: str, args: list[str], period: str, mw0: bool = False, extra: list[str] | None = None) -> dict:
    cache = OUT / "runs" / f"{key}_{period}.txt"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists() and "CASE A" in cache.read_text():
        out = cache.read_text()
    else:
        cmd = [sys.executable, str(ROTATE), "--basket", "DRB-6W0L2" if mw0 else "DRB-6W3L2", *args, *PERIODS[period], *(extra or [])]
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE.parent.parent)
        out = proc.stdout
        cache.write_text(out)
        if "CASE A" not in out:
            return dict(key=key, period=period, error=(proc.stderr.strip().splitlines() or ["no report"])[-1])
    r = parse_case_a(out)
    return dict(key=key, period=period, gross=r["gross"], max_dd=r["max_dd"], win_pct=r["win_pct"], worst_week=r["worst_week"], r_p50=r["r_p50"], r_p90=r["r_p90"], above=r["gross"] >= r["r_p90"], per_lot_day=r["per_lot_day"])


def cell_key(o: int, f: int, s: str) -> str:
    return f"o{o}_f{f}_{s}"


def summarise(d: pd.DataFrame, best: dict[str, float]) -> pd.DataFrame:
    d = d.copy()
    d["rel"] = d.apply(lambda r: r.gross / best[r.period], axis=1)
    g = d.groupby("key").agg(min_rel=("rel", "min"), mean_rel=("rel", "mean"), all_above=("above", "all"), n=("period", "size"))
    return g


def stage1(workers: int) -> None:
    jobs = [(cell_key(*c), cell_args(*c), p) for c in cells() for p in PERIODS]
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(lambda j: run_one(*j), jobs))
    d = pd.DataFrame(rows)
    d.to_csv(OUT / "stage1_runs.csv", index=False)
    ok = d.dropna(subset=["gross"])
    best = ok.groupby("period").gross.max().to_dict()
    g = summarise(ok, best)
    g[["own", "fam", "split"]] = [(int(k.split("_")[0][1:]), int(k.split("_")[1][1:]), k.split("_")[2]) for k in g.index]
    # robust region: above chance everywhere, and every existing recency-axis neighbour too
    above = g.all_above.to_dict()
    def robust(r) -> bool:
        if not r.all_above:
            return False
        for do, df_ in ((-5, 0), (5, 0), (0, -5), (0, 5)):
            o, f = r.own + do, r.fam + df_
            if 0 <= o <= 20 and 0 <= f <= 20 and not above.get(cell_key(o, f, r.split), False):
                return False
        return True
    g["robust"] = g.apply(robust, axis=1)
    g.to_csv(OUT / "stage1_cells.csv")
    qual = g[g.all_above].sort_values("min_rel", ascending=False)
    top = qual.head(50) if len(qual) >= 10 else g.sort_values("min_rel", ascending=False).head(10)
    top.to_csv(OUT / "stage1_top.csv")
    pd.set_option("display.width", 200)
    print(f"stage 1: {len(g)} cells, {int(g.all_above.sum())} above chance in all three periods ({100 * g.all_above.mean():.0f}%), {int(g.robust.sum())} in the robust region")
    print(g.groupby("split").agg(cells=("all_above", "size"), above_all=("all_above", "sum"), robust=("robust", "sum"), best_min_rel=("min_rel", "max")).to_string())
    print("\nbest periods:", {k: f"{v:,.0f}" for k, v in best.items()})
    print("\ntop 15 by worst-period score:\n" + g.sort_values("min_rel", ascending=False).head(15)[["own", "fam", "split", "min_rel", "mean_rel", "all_above", "robust"]].to_string(float_format=lambda x: f"{x:.3f}"))
    for name, key in (("BL-073 candidate 10/0 baseline", cell_key(10, 0, "baseline")), ("BL-074 (a) 0/10 baseline", cell_key(0, 10, "baseline"))):
        if key in g.index:
            r = g.loc[key]
            print(f"{name}: min_rel {r.min_rel:.3f}, above chance everywhere {r.all_above}, robust {r.robust}")


def stage2(workers: int) -> None:
    top = pd.read_csv(OUT / "stage1_top.csv", index_col=0)
    s1 = pd.read_csv(OUT / "stage1_runs.csv").dropna(subset=["gross"])
    best = s1.groupby("period").gross.max().to_dict()
    combos = [c for r in (1, 2, 3) for c in itertools.combinations(STRUCT, r)]
    jobs = []
    for key in top.index:
        o, f, s = int(key.split("_")[0][1:]), int(key.split("_")[1][1:]), key.split("_")[2]
        for combo in combos:
            extra = [x for c in combo for x in STRUCT[c]]
            for p in PERIODS:
                jobs.append((f"{key}__{'+'.join(combo)}", cell_args(o, f, s), p, "mw0" in combo, extra))
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(lambda j: run_one(*j), jobs))
    d = pd.DataFrame(rows)
    d.to_csv(OUT / "stage2_runs.csv", index=False)
    ok = d.dropna(subset=["gross"]).copy()
    ok["cell"] = ok.key.str.split("__").str[0]
    ok["struct"] = ok.key.str.split("__").str[1]
    ok["rel"] = ok.apply(lambda r: r.gross / best[r.period], axis=1)
    base = s1.copy()
    base["rel"] = base.apply(lambda r: r.gross / best[r.period], axis=1)
    base_min = base.groupby("key").rel.min()
    rows2 = []
    for struct, g in ok.groupby("struct"):
        m = g.groupby("cell").agg(min_rel=("rel", "min"), all_above=("above", "all"))
        common = m.index.intersection(base_min.index)
        improved = float((m.loc[common].min_rel > base_min.loc[common]).mean())
        below = int((~m.loc[common].all_above).sum())
        rows2.append(dict(struct=struct, cells=len(common), improved=improved, below_chance=below, mean_min_rel=m.loc[common].min_rel.mean(), base_mean_min_rel=base_min.loc[common].mean()))
    sw = pd.DataFrame(rows2)
    sw.to_csv(OUT / "stage2_switches.csv", index=False)
    print(sw.to_string(index=False, float_format=lambda x: f"{x:.3f}"))
    adopted = [r.struct for r in sw.itertuples() if "+" not in r.struct and r.improved >= 0.70 and r.below_chance == 0]
    (OUT / "stage2_adopted.txt").write_text(",".join(adopted))
    print("adopted single switches:", adopted or "none")


def stage3(workers: int) -> None:
    """10 label shuffles per period for the top 10 stage-1 cells at the final structure (stage 2
    adopted no switch, so the structure is the current one). A cell is real only if its true gross
    beats all 10 shuffled grosses in every period."""
    top = pd.read_csv(OUT / "stage1_top.csv", index_col=0).head(10)
    s1 = pd.read_csv(OUT / "stage1_runs.csv").dropna(subset=["gross"]).set_index(["key", "period"])
    jobs = []
    for key in top.index:
        o, f, s = int(key.split("_")[0][1:]), int(key.split("_")[1][1:]), key.split("_")[2]
        for p in PERIODS:
            for seed in range(10):
                jobs.append((f"{key}__shuf{seed}", cell_args(o, f, s) + ["--shuffle-labels", str(seed)], p))
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(lambda j: run_one(*j), jobs))
    d = pd.DataFrame(rows).dropna(subset=["gross"])
    d["cell"] = d.key.str.split("__").str[0]
    out = []
    for key in top.index:
        row = {"cell": key}
        real = True
        for p in PERIODS:
            sh = d[(d.cell == key) & (d.period == p)].gross
            true = float(s1.loc[(key, p), "gross"])
            row[f"{p}_true"], row[f"{p}_shuf_max"], row[f"{p}_shuf_mean"] = true, sh.max(), sh.mean()
            real &= bool(true > sh.max())
        row["real"] = real
        out.append(row)
    res = pd.DataFrame(out)
    res.to_csv(OUT / "stage3_shuffles.csv", index=False)
    pd.set_option("display.width", 220)
    print(res.to_string(index=False, float_format=lambda x: f"{x:,.0f}"))
    print(f"real in all three periods: {int(res.real.sum())} of {len(res)}")


def main() -> None:
    OUT.mkdir(exist_ok=True)
    stage = int(sys.argv[sys.argv.index("--stage") + 1])
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    {1: stage1, 2: stage2, 3: stage3}[stage](workers)


if __name__ == "__main__":
    main()
