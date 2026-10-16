"""Experiment 3: walk-forward of the T1 method (registered in the research item before any fold ran).

Per fold: select the time-generic winners (BL-104 daytype_lists, Amendments 1-11) on a 12-month
window only, in two variants (1: one setting per family and day type; 2: up to two, the second only
when it correlates below 0.7), create them at all 25 entry times, simulate them 2024-10-09 ->
2026-10-09, and replay Adaptive (list C, no weight) on the fold's quarter over Core-298 + winners
against Adaptive over Core-298.

    uv run python research/bl107/walkforward.py --stage all --workers 4
    (stages: select, cells, sim, replay; each resumable)
"""

from __future__ import annotations

import argparse
import csv
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

RES = HERE / "results" / "walkforward"
SIM = RES / "sim"
FOLDS = [  # (fold, select start, half, select end exclusive, trade start, trade end exclusive)
    (1, date(2024, 10, 9), date(2025, 4, 9), date(2025, 10, 9), date(2025, 10, 9), date(2026, 1, 1)),
    (2, date(2025, 1, 1), date(2025, 7, 2), date(2026, 1, 1), date(2026, 1, 1), date(2026, 4, 1)),
    (3, date(2025, 4, 1), date(2025, 10, 1), date(2026, 4, 1), date(2026, 4, 1), date(2026, 7, 1)),
    (4, date(2025, 7, 1), date(2025, 12, 31), date(2026, 7, 1), date(2026, 7, 1), date(2026, 10, 10)),
]
VARIANTS = (1, 2)
# Experiment 8: the same quarters, each selected on everything from 2024-10-09 up to its start
# (ranked on the first half, confirmed on the second); variant 1 only.
EXPANDING = [
    (1, date(2024, 10, 9), date(2025, 4, 9), date(2025, 10, 9), date(2025, 10, 9), date(2026, 1, 1)),
    (2, date(2024, 10, 9), date(2025, 5, 21), date(2026, 1, 1), date(2026, 1, 1), date(2026, 4, 1)),
    (3, date(2024, 10, 9), date(2025, 7, 5), date(2026, 4, 1), date(2026, 4, 1), date(2026, 7, 1)),
    (4, date(2024, 10, 9), date(2025, 8, 20), date(2026, 7, 1), date(2026, 7, 1), date(2026, 10, 10)),
]
ALL25 = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47) if (9, 17) <= (h, m) <= (15, 17)]
LETTER = {"W": "w", "D": "d", "B": "b"}
TAG = {"expiry": "E", "other": "O"}


def stage_select() -> None:
    import daytype_lists as dl

    exp = dl.expiries()
    out = []
    for fold, start, half, end, _, _ in FOLDS:
        dl.WINDOW, dl.WIN = "custom", (start, half, end)
        for f in dl.FAMILIES:
            results = {slot: dl.evaluate(f, slot, exp[dl.grid.INDICES[f.idx]]) for slot in dl.ALL_SLOTS}
            for variant in VARIANTS:
                dl.MAX_PICKS = variant
                for kind in ("expiry", "other"):
                    agg = dl.aggregate(f, results, kind, dl.ALL_SLOTS)
                    allowed = dl.family_premiums(agg)[0] if f.is_premium else None
                    dec = dl.decide(f, agg, kind, allowed)
                    for r in dec["picks"]:
                        if r.get("is_template"):
                            continue
                        out.append({
                            "fold": fold, "variant": variant, "family": f.name, "fam": f.fam, "index": f.idx,
                            "kind": kind, "status": dec["status"], "params": r["params"],
                            "gain_first": r["gain_first"], "gain_test": r["gain_test"],
                            "rank_used": r.get("rank_used", ""),
                        })
            print(f"fold {fold} {f.name}: done", flush=True)
    RES.mkdir(parents=True, exist_ok=True)
    (RES / "winners.json").write_text(json.dumps(out, default=list, indent=1))
    for fold, *_ in FOLDS:
        for v in VARIANTS:
            n = sum(1 for w in out if w["fold"] == fold and w["variant"] == v)
            print(f"fold {fold} variant {v}: {n} settings", flush=True)


def stage_cells() -> None:
    import grid

    winners = json.loads((RES / "winners.json").read_text())
    ids: dict[str, int] = {}
    cells, universes = [], {}
    for w in winners:
        sig = json.dumps([w["fam"], w["index"], w["params"]], sort_keys=True, default=list)
        if sig not in ids:
            ids[sig] = len(ids) + 1
            params = {k: tuple(v) if isinstance(v, list) else v for k, v in w["params"].items()}
            for slot in ALL25:
                name = f"{w['index']}_{LETTER[w['fam']]}{TAG[w['kind']]}{ids[sig]}_{slot.replace(':', '')}"
                try:
                    grid.build(grid.Cell(w["fam"], w["index"], slot, params))
                except (ValueError, FileNotFoundError):
                    continue  # e.g. Buy has no 15:17 file, or a range ending after the exit
                cells.append({"name": name, "family": w["fam"], "index": w["index"], "slot": slot,
                              "params": w["params"], "set": ids[sig]})
        universes.setdefault(f"{w['fold']}-{w['variant']}", set()).add(ids[sig])
    (RES / "cells.json").write_text(json.dumps(cells, default=list))
    (RES / "universes.json").write_text(json.dumps({k: sorted(v) for k, v in universes.items()}))
    print(f"{len(ids)} distinct settings, {len(cells)} variants", flush=True)


def _sim_job(index: str, slot: str, cells: list[dict], root: str) -> dict:
    import pool_run

    pool_run.FROM, pool_run.TO = date(2024, 10, 9), date(2026, 10, 9)
    return pool_run.job(index, slot, cells, root)


def stage_sim(workers: int) -> None:
    from option_backtesting.fyers.daily import data_dir

    cells = json.loads((RES / "cells.json").read_text())
    jobs: dict[tuple[str, str], list[dict]] = {}
    for c in cells:
        jobs.setdefault((c["index"], c["slot"]), []).append(c)
    SIM.mkdir(parents=True, exist_ok=True)
    pending = {k: v for k, v in jobs.items() if not (SIM / f"{k[0]}_{k[1].replace(':', '')}.npz").exists()}
    print(f"sim jobs {len(jobs)} pending {len(pending)}", flush=True)
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_sim_job, i, s, cs, str(data_dir())): (i, s) for (i, s), cs in pending.items()}
        for fut in as_completed(futs):
            i, s = futs[fut]
            r = fut.result()
            np.savez(SIM / f"{i}_{s.replace(':', '')}.npz", days=np.array(r["days"]), names=np.array(r["names"]),
                     gross=r["gross"], net=r["net"])
            print(f"done {i} {s}: {len(r['names'])} x {len(r['days'])} in {r['seconds']:.0f}s", flush=True)


def stage_replay() -> None:
    import replay as rp

    rp.patch_parts()
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.rotation import store
    from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
    from option_backtesting.rotation.variants import variant_names

    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    cells = {c["name"]: c for c in json.loads((RES / "cells.json").read_text())}
    universes = json.loads((RES / "universes.json").read_text())
    new: dict[str, dict[str, float]] = {}
    for f in sorted(SIM.glob("*.npz")):
        z = np.load(f)
        for j, n in enumerate(z["names"]):
            new[str(n)] = {str(d): float(z["gross"][i, j]) for i, d in enumerate(z["days"])}
    days = sorted(set(d for d in m.days if d in attrs and d.weekday() < 5)
                  & set.intersection(*(set(date.fromisoformat(x) for x in c) for c in new.values())))
    mi = {d: i for i, d in enumerate(m.days)}
    core_g = np.array([[m.values[mi[d], j] for j in range(len(m.names))] for d in days])
    exp = rp.expiry_days()
    rows, pooled = [], {"core": [], 1: [], 2: []}
    for fold, *_, t0, t1 in FOLDS:
        trade = [d for d in days if t0 <= d < t1]
        r = rp.replay(days, list(m.names), core_g, core_g, attrs, trade, 0.0, [""] * len(m.names), exp)
        core = np.array(r["C"]["gross"])
        pooled["core"] += list(core)
        rec = {"fold": fold, "days": len(trade), "core": core.mean()}
        for v in VARIANTS:
            ids = set(universes.get(f"{fold}-{v}", []))
            add = sorted(n for n, c in cells.items() if c["set"] in ids)
            names = list(m.names) + add
            G = np.hstack([core_g, np.array([[new[n][d.isoformat()] for n in add] for d in days])]) if add else core_g
            tags = [""] * len(m.names) + ["E"] * len(add)  # weight 0: a tag only marks "added"
            rv = rp.replay(days, names, G, G, attrs, trade, 0.0, tags, exp)
            g = np.array(rv["C"]["gross"])
            pooled[v] += list(g)
            rec[f"v{v}"] = g.mean()
            rec[f"v{v}_settings"] = len(ids)
            rec[f"v{v}_new_share"] = float(np.mean(rv["C"]["new"]))
            rec[f"v{v}_maxdd"] = max_drawdown(g)
        rec["core_maxdd"] = max_drawdown(core)
        rows.append(rec)
        print(f"fold {fold}: {len(trade)} days  Core {rec['core']:.0f}  v1 {rec['v1']:.0f} ({rec['v1_settings']} settings)"
              + (f"  v2 {rec['v2']:.0f} ({rec['v2_settings']} settings)" if 2 in VARIANTS else ""), flush=True)
    core = np.array(pooled["core"])
    print(f"\nWalk-forward, Adaptive gross per lot-day, {len(core)} days over 4 quarters")
    print(f"{'fold':>4s}{'days':>6s}{'Core':>8s}{'v1':>8s}{'v1-Core':>9s}{'v2':>8s}{'v2-Core':>9s}{'v1 n':>6s}{'v2 n':>6s}")
    for r in rows:
        v2 = (f"{r['v2']:8.0f}{r['v2'] - r['core']:+9.0f}" if 2 in VARIANTS else f"{'-':>8s}{'-':>9s}")
        n2 = r["v2_settings"] if 2 in VARIANTS else 0
        print(f"{r['fold']:4d}{r['days']:6d}{r['core']:8.0f}{r['v1']:8.0f}{r['v1'] - r['core']:+9.0f}"
              f"{v2}{r['v1_settings']:6d}{n2:6d}")
    verdict = {}
    for v in VARIANTS:
        g = np.array(pooled[v])
        mean, lo, hi = block_bootstrap_mean(g - core)
        wins = sum(r[f"v{v}"] > r["core"] for r in rows)
        verdict[v] = wins >= 3 and lo > 0
        print(f"variant {v}: pooled {g.mean():.0f} vs Core {core.mean():.0f}: diff {mean:+.0f} 90% [{lo:+.0f}, {hi:+.0f}]"
              f"  quarters won {wins}/4  maxDD {max_drawdown(g):,.0f} (Core {max_drawdown(core):,.0f})"
              f"  -> {'PASS' if verdict[v] else 'no pass'}")
    if 2 in VARIANTS:
        mean, lo, hi = block_bootstrap_mean(np.array(pooled[2]) - np.array(pooled[1]))
        print(f"variant 2 minus variant 1: {mean:+.0f} 90% [{lo:+.0f}, {hi:+.0f}]"
              f" -> {'variant 2 preferred' if lo > 0 else 'variant 1 (the simpler) stands'}")
    with (RES / "summary.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=("select", "cells", "sim", "replay", "all"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--scheme", default="fixed", choices=("fixed", "expanding"))
    args = ap.parse_args()
    if args.scheme == "expanding":
        global FOLDS, VARIANTS, RES, SIM
        FOLDS, VARIANTS = EXPANDING, (1,)
        RES = HERE / "results" / "walkforward_expanding"
        SIM = RES / "sim"
    if args.stage in ("select", "all"):
        stage_select()
    if args.stage in ("cells", "all"):
        stage_cells()
    if args.stage in ("sim", "all"):
        stage_sim(args.workers)
    if args.stage in ("replay", "all"):
        stage_replay()


if __name__ == "__main__":
    main()
