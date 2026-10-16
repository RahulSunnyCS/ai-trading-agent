"""Experiment 4 (grid edges): T1-edge = the time-generic winners chosen on the first year over the
widened grid (`daytype_lists.py --window first --edges`), created at all 25 entry times, simulated
like T1 (2025-04-01 -> 2026-10-09), and Adaptive (list C, no weight) replayed on the test year over
Core-298, Core-298 + T1 and Core-298 + T1-edge. Registered in the research item before any run.

    uv run python research/bl107/edges_replay.py --workers 4
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
sys.path.insert(0, str(HERE.parent / "bl106"))
sys.path.insert(0, str(HERE))

RES = HERE / "results" / "edges"
WINNERS = HERE.parent / "bl104" / "results" / "daytype_fy_edges" / "winners.json"
ALL25 = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47) if (9, 17) <= (h, m) <= (15, 17)]
LETTER = {"W": "w", "D": "d", "B": "b"}
TAG = {"expiry": "E", "other": "O"}
ID_OFFSET = 500  # names never collide with T1's (sets 1-53)


def build_cells() -> list[dict]:
    import grid

    cells, ids = [], {}
    for w in json.loads(WINNERS.read_text()):
        if w["band"] != "all times" or w["kind"] not in TAG or w["params"] is None:
            continue
        sig = json.dumps([w["fam"], w["index"], w["params"]], sort_keys=True, default=list)
        if sig in ids:
            continue
        ids[sig] = ID_OFFSET + len(ids) + 1
        params = {k: tuple(v) if isinstance(v, list) else v for k, v in w["params"].items()}
        for slot in ALL25:
            try:
                grid.build(grid.Cell(w["fam"], w["index"], slot, params))
            except (ValueError, FileNotFoundError):
                continue
            cells.append({"name": f"{w['index']}_{LETTER[w['fam']]}{TAG[w['kind']]}{ids[sig]}_{slot.replace(':', '')}",
                          "family": w["fam"], "index": w["index"], "slot": slot, "params": w["params"],
                          "set": ids[sig], "label": f"{w['family']} {w['kind']}"})
    RES.mkdir(parents=True, exist_ok=True)
    (RES / "cells.json").write_text(json.dumps(cells, default=list))
    sets = {}
    for c in cells:
        sets.setdefault(c["set"], (c["label"], c["params"]))
    print(f"T1-edge: {len(sets)} settings, {len(cells)} variants")
    for k, (label, p) in sorted(sets.items()):
        print(f"  #{k} {label}: {json.dumps(p, default=list)}")
    return cells


def _job(index: str, slot: str, cells: list[dict], root: str) -> dict:
    import pool_run

    pool_run.FROM, pool_run.TO = date(2025, 4, 1), date(2026, 10, 9)
    return pool_run.job(index, slot, cells, root)


def simulate(cells: list[dict], workers: int) -> None:
    from option_backtesting.fyers.daily import data_dir

    out = RES / "sim"
    out.mkdir(parents=True, exist_ok=True)
    jobs: dict[tuple[str, str], list[dict]] = {}
    for c in cells:
        jobs.setdefault((c["index"], c["slot"]), []).append(c)
    pending = {k: v for k, v in jobs.items() if not (out / f"{k[0]}_{k[1].replace(':', '')}.npz").exists()}
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_job, i, s, cs, str(data_dir())): (i, s) for (i, s), cs in pending.items()}
        for fut in as_completed(futs):
            i, s = futs[fut]
            r = fut.result()
            np.savez(out / f"{i}_{s.replace(':', '')}.npz", days=np.array(r["days"]), names=np.array(r["names"]),
                     gross=r["gross"], net=r["net"])
    print(f"simulated {len(jobs)} jobs", flush=True)


def replay() -> None:
    import replay as rp

    rp.patch_parts()
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.rotation import store
    from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
    from option_backtesting.rotation.variants import variant_names

    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    t1cells = {c["name"]: c for c in json.loads((rp.RES / "cells.json").read_text())}

    def load(folder: Path) -> dict[str, dict[str, float]]:
        out = {}
        for f in sorted(folder.glob("*.npz")):
            z = np.load(f)
            for j, n in enumerate(z["names"]):
                out[str(n)] = {str(d): float(z["gross"][i, j]) for i, d in enumerate(z["days"])}
        return out

    t1 = {n: v for n, v in load(rp.RES / "sim").items() if t1cells.get(n, {}).get("universe") == "T1"}
    edge = load(RES / "sim")
    allsrc = {**t1, **edge}
    days = sorted(set(d for d in m.days if d in attrs and d >= rp.HIST_FROM and d.weekday() < 5)
                  & set.intersection(*(set(date.fromisoformat(x) for x in c) for c in allsrc.values())))
    test = [d for d in days if d >= rp.TEST_FROM]
    mi = {d: i for i, d in enumerate(m.days)}
    core_g = np.array([[m.values[mi[d], j] for j in range(len(m.names))] for d in days])
    exp = rp.expiry_days()
    out = {}
    for label, add in (("Core-298", []), ("T1", sorted(t1)), ("T1-edge", sorted(edge))):
        names = list(m.names) + add
        G = np.hstack([core_g, np.array([[allsrc[n][d.isoformat()] for n in add] for d in days])]) if add else core_g
        tags = [""] * len(m.names) + ["E"] * len(add)
        r = rp.replay(days, names, G, G, attrs, test, 0.0, tags, exp)
        out[label] = (np.array(r["C"]["gross"]), len(names), float(np.mean(r["C"]["new"])))
    core, t1g = out["Core-298"][0], out["T1"][0]
    print(f"\nAdaptive, test year ({len(test)} days), gross per lot-day")
    for label, (g, n, share) in out.items():
        line = f"{label:9s}{n:5d} strategies  {g.mean():6.1f}  maxDD {max_drawdown(g):8,.0f}  win {np.mean(g > 0):.0%}  new picks {share:.0%}"
        if label != "Core-298":
            mean, lo, hi = block_bootstrap_mean(g - core)
            line += f"  vs Core {mean:+6.1f} [{lo:+6.1f},{hi:+6.1f}]"
        print(line)
    g = out["T1-edge"][0]
    mean, lo, hi = block_bootstrap_mean(g - t1g)
    passes = lo > 0 and max_drawdown(g) >= max_drawdown(t1g)
    print(f"\nT1-edge minus T1: {mean:+.1f} 90% [{lo:+.1f}, {hi:+.1f}]; maxDD {max_drawdown(g):,.0f} vs {max_drawdown(t1g):,.0f}"
          f" -> {'PASS: T1-edge replaces T1 (owner decides the track)' if passes else 'no pass: T1 stands'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    cells = build_cells()
    simulate(cells, args.workers)
    replay()


if __name__ == "__main__":
    main()
