"""BL-080 block 3: leave one category out of the 398-variant list, lists A, B, C, REF on P1 / P2 / P3.

uv run --with pandas --with numpy --with duckdb python research/bl080/ablate.py [parallel]
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
BL75 = HERE.parent / "bl075"
sys.path.insert(0, str(BL75))
sys.path.insert(0, str(HERE.parent / "common"))
import run_all as S  # noqa: E402
from rotparse import parse_case_a  # noqa: E402

LISTS = {
    "A": ["--weights", "5,34,33,23,0,5", *S.LB, "--family-key", "band"],
    "B": ["--weights", "0,36,35,24,0,5", *S.LB, "--family-key", "band"],
    "C": ["--weights", "15,30,30,20,0,5", *S.LB, "--family-key", "band"],
    "REF": ["--weights", "33,25,25,17"],
}
SINGLES = [
    f"{i}_{f}"
    for i, fams in (
        ("N", ("wide", "p40", "p60", "p80", "p100", "dir", "ditm1", "buy")),
        ("S", ("wide", "p120", "p200", "p250", "p320", "dir", "ditm1", "buy")),
    )
    for f in fams
]
GROUPS = ["closest", "dir_itm", "dir_atm", "buy", "wide_otm", "NIFTY", "SENSEX"]
NEW = ("p40", "p60", "p120", "p200", "ditm1")


def run(job):
    lst, drop, period = job
    if period == "P3" and drop in ("NIFTY", "SENSEX") or period == "P3" and drop.startswith("S_"):
        return None  # leaves nothing / changes nothing on the NIFTY-only period
    tag = f"{lst}_{drop or 'full'}_{period}".replace("/", "-")
    cache = HERE / "out_ablation" / f"{tag}.txt"
    cache.parent.mkdir(exist_ok=True)
    if cache.exists() and "picks file:" in cache.read_text():
        out = cache.read_text()
    else:
        cmd = [
            sys.executable,
            str(S.ROTATE),
            "--basket",
            "DRB-6W3L2",
            *LISTS[lst],
            *S.PERIODS[period],
            "--ext-closest",
            "--ext-dir",
        ]
        if drop:
            cmd += ["--drop", drop]
        out = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE.parent.parent).stdout
        cache.write_text(out)
    r = parse_case_a(out)
    picks = pd.read_csv(
        Path([x for x in out.splitlines() if x.startswith("picks file: ")][0].split(": ", 1)[1])
    )
    slots = [n for c in picks.core_A for n in c.split(",")]
    return dict(
        list=lst,
        drop=drop or "full",
        period=period,
        gross=r["gross"],
        max_dd=r["max_dd"],
        p90=r["r_p90"],
        above=r["gross"] >= r["r_p90"],
        new_share=sum(n.split("_")[1] in NEW for n in slots) / len(slots),
    )


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 4
    jobs = [(lst, d, p) for d in ["", *SINGLES, *GROUPS] for lst in LISTS for p in S.PERIODS]
    with ThreadPoolExecutor(workers) as pool:
        rows = [r for r in pool.map(run, jobs) if r]
    d = pd.DataFrame(rows)
    d.to_csv(HERE / "out_ablation.csv", index=False)
    full = d[d["drop"] == "full"].set_index(["list", "period"]).gross
    d["delta_pct"] = d.apply(lambda r: 100 * (r.gross / full[(r.list, r.period)] - 1), axis=1)
    t = d[d["drop"] != "full"].pivot_table(
        index="drop", columns="period", values="delta_pct", aggfunc="mean"
    )
    t["lists_above_chance"] = d[d["drop"] != "full"].groupby("drop").above.sum().astype(int)
    t["runs"] = d[d["drop"] != "full"].groupby("drop").above.size()
    pd.set_option("display.width", 200)
    print("mean change in gross vs the full 398 list, over lists A, B, C, REF (%):")
    print(t.round(1).to_string())
    # registered classification
    out = []
    for drop, g in d[d["drop"] != "full"].groupby("drop"):
        lowered = g[g.delta_pct < -5].groupby("list").period.nunique()
        carrying = int((lowered >= 2).sum()) >= 2
        flat = g[(g.delta_pct.abs() < 2) | (g.delta_pct > 0)].groupby("list").period.nunique()
        dead = int((flat >= 2).sum()) >= 2
        out.append(
            (drop, "carrying weight" if carrying else "dead weight" if dead else "in between")
        )
    print()
    for drop, verdict in out:
        print(f"{drop:10s} {verdict}")


if __name__ == "__main__":
    main()
