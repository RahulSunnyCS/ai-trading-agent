"""BL-081 block 1: the no-trade column (1a) and the rupee gate (1b) on lists A / B / C / REF x P1 / P2 / P3.

    uv run --with pandas --with numpy --with duckdb python research/bl081/run_block1.py [workers]

Read-out registered in backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md (Block 1). Resumable:
each run's report is cached in out/block1/<list>_<period>_<rule>.txt.
"""

from __future__ import annotations

import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

LB = ["--fit-lookbacks", "5:30,21:25,63:25,126:20"]
LISTS = {
    "A": ["--weights", "5,34,33,23,0,5", *LB, "--family-key", "band"],
    "B": ["--weights", "0,36,35,24,0,5", *LB, "--family-key", "band"],
    "C": ["--weights", "15,30,30,20,0,5", *LB, "--family-key", "band"],
    "REF": ["--weights", "33,25,25,17"],
}
PERIODS = {
    "P1": [],
    "P2": ["--window-from", "2024-10-09", "--window-to", "2025-08-29"],
    "P3": ["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"),
           "--window-from", "2022-01-03", "--window-to", "2024-10-08"],
}
RULES = {"base": [], "notrade": ["--no-trade"], "rgate": ["--rupee-gate"]}
OUT = HERE / "out" / "block1"


def run(job):
    lst, per, rule = job
    f = OUT / f"{lst}_{per}_{rule}.txt"
    if f.exists() and "VERDICT" in f.read_text():
        out = f.read_text()
    else:
        out = subprocess.run(
            [sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *LISTS[lst], *PERIODS[per], *RULES[rule]],
            capture_output=True, text=True, cwd=HERE.parent.parent,
        ).stdout
        f.write_text(out)
    r = parse_case_a(out)
    picks = Path(re.search(r"picks file: (.*)", out).group(1))
    d = pd.read_csv(picks)
    row = dict(list=lst, period=per, rule=rule, days=len(d), **{k: r[k] for k in
               ("gross", "max_dd", "win_pct", "per_lot_day", "worst_week", "r_p90")})
    row["above_p90"] = r["gross"] >= r["r_p90"]
    row["lots_total"] = float(d.lots.sum())
    row["zero_picked_days"] = int((d.zero_picked > 0).sum()) if "zero_picked" in d else 0
    row["days_affected"] = int((d.n_dropped > 0).sum()) if "n_dropped" in d else 0
    row["picks_dropped"] = int(d.n_dropped.sum()) if "n_dropped" in d else 0
    row["dropped_pnl"] = float(d.dropped_pnl.sum()) if "dropped_pnl" in d else 0.0
    return row


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    jobs = [(name, p, r) for name in LISTS for p in PERIODS for r in RULES]
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, jobs))
    t = pd.DataFrame(rows)
    t.to_csv(HERE / "out" / "block1.csv", index=False)
    pd.set_option("display.width", 250)
    print(t.to_string(index=False, float_format=lambda x: f"{x:,.0f}"))
    print("\n=== read-out (registered)")
    for lst in LISTS:
        for p in PERIODS:
            b = t[(t.list == lst) & (t.period == p) & (t.rule == "base")].iloc[0]
            z = t[(t.list == lst) & (t.period == p) & (t.rule == "notrade")].iloc[0]
            g = t[(t.list == lst) & (t.period == p) & (t.rule == "rgate")].iloc[0]
            dd = (g.max_dd - b.max_dd) / abs(b.max_dd) * 100
            print(f"{lst:3s} {p}: 1a zero picked {z.zero_picked_days}d, gross {z.gross - b.gross:+,.0f} | "
                  f"1b affected {g.days_affected}d, {g.picks_dropped} picks dropped, their P&L {g.dropped_pnl:+,.0f}, "
                  f"gross {g.gross - b.gross:+,.0f}, per-lot-day {g.per_lot_day - b.per_lot_day:+.0f}, max DD {dd:+.0f}%")
    keep = []
    for lst in LISTS:
        ok = True
        for p in PERIODS:
            b = t[(t.list == lst) & (t.period == p) & (t.rule == "base")].iloc[0]
            g = t[(t.list == lst) & (t.period == p) & (t.rule == "rgate")].iloc[0]
            dd_better = (g.max_dd - b.max_dd) / abs(b.max_dd) >= 0.20
            ok &= bool(g.per_lot_day > b.per_lot_day and dd_better and g.days_affected > 0 and g.dropped_pnl < 0)
        keep.append((lst, ok))
    print("\n1b keep (per-lot-day up, DD >= 20% better, dropped picks lost, every period):", keep)


if __name__ == "__main__":
    main()
