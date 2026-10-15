"""BL-105 Phase 1 screen: lock / trail and restart over the registered Dir bases.

One job per (index, slot): each day is loaded once and every base (3 strikes x 2 trails) is run
with every variant of `bl105_grid.variants()`. Parts are resumable; the day x cell net series are
stored for the bootstrap and half-year checks (`score_screen.py`).

    python research/bl105/run_screen.py --tag phase1 --workers 3
    python research/bl105/run_screen.py --tag smoke --index N --slots 09:17 --from 2026-09-01 --to 2026-09-10 --workers 1
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bl104"))
import bl105_grid as g  # noqa: E402
import screen_lib as lib  # noqa: E402
from run_grid import Stats, cohort_days  # noqa: E402

from option_backtesting.data.reference.loader import (  # noqa: E402
    MissingReferenceData,
    default_reference_data,
)
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402

RESULTS = HERE / "results"
FROM, TO = date(2024, 10, 9), date(2026, 10, 9)
REACH_LEVELS = (1500, 2000, 3000, 4000, 6000)


def run_job(index: str, slot: str, days: list[date], root: str, phase: int = 1) -> dict[str, Any]:
    started = time.monotonic()
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    underlying = g.INDICES[index]
    spec = g.variants() if phase == 1 else g.phase2_variants()
    bases = {g.base_id(s, t): g.build_base(index, slot, s, t) for s in g.STRIKES for t in g.TRAILS}
    stats = {
        (b, v.id): Stats(underlying) for b in bases for v in spec if g.applies(v, b.split("_")[0])
    }
    series: dict[tuple[str, str], list[float]] = {k: [] for k in stats}
    cut_days = {k: 0 for k in stats}
    restarts = {k: 0 for k in stats}
    reach = {b: {lv: 0 for lv in REACH_LEVELS} for b in bases}
    used: list[date] = []
    skipped: dict[str, str] = {}
    for day in days:
        try:
            data = load_day(Path(root), underlying, day)
        except FileNotFoundError:
            skipped[day.isoformat()] = "no index or option file"
            continue
        except MissingReferenceData as error:
            skipped[day.isoformat()] = f"reference: {error}"
            continue
        used.append(day)
        for bid, strategy in bases.items():
            todo = [v for v in spec if g.applies(v, bid.split("_")[0])]
            results, made, best = lib.day_variants(strategy, data, ref, sizing, todo)
            for lv in REACH_LEVELS:
                reach[bid][lv] += best >= lv
            for v in todo:
                res = results[v.id]
                key = (bid, v.id)
                stats[key].add(res)
                series[key].append(stats[key].values[-1])
                cut_days[key] += (res.stopped_by or "").startswith(("cut at", "overall target"))
                restarts[key] += made.get(v.id, 0)
    rows = []
    for (bid, vid), st in stats.items():
        v = next(x for x in spec if x.id == vid)
        strike, trail = bid.split("_")
        n = max(1, len(used))
        row = {
            "index": index,
            "underlying": underlying,
            "slot": slot,
            "band": g.band(slot),
            "base": bid,
            "strike": strike,
            "leg_trail": "10/5" if trail == "t10-5" else "none",
            "variant": vid,
            "idea": v.idea,
            "kind": v.kind,
            "level": v.level,
            "restarts_allowed": v.restarts,
            "cut_days": cut_days[(bid, vid)],
            "cut_rate": cut_days[(bid, vid)] / n,
            "restarts_made": restarts[(bid, vid)],
            "grid_version": g.VERSION,
        }
        row.update(st.finish(1.0))
        if vid == "base":
            row.update({f"reach_{lv}_rate": reach[bid][lv] / n for lv in REACH_LEVELS})
        rows.append(row)
    keys = list(stats)
    matrix = np.array([series[k] for k in keys], dtype=np.float32).T
    return {
        "rows": rows,
        "matrix": matrix,
        "labels": [f"{b}|{v}" for b, v in keys],
        "days": [d.isoformat() for d in used],
        "skipped": skipped,
        "seconds": time.monotonic() - started,
    }


def write_part(out: Path, name: str, r: dict[str, Any]) -> None:
    (out / "series").mkdir(parents=True, exist_ok=True)
    (out / "parts").mkdir(parents=True, exist_ok=True)
    np.save(out / "series" / f"{name}.npy", r["matrix"])
    (out / "series" / f"{name}.json").write_text(
        json.dumps(
            {
                "labels": r["labels"],
                "days": r["days"],
                "skipped": r["skipped"],
                "grid": g.grid_sha(),
            }
        )
    )
    part = out / "parts" / f"{name}.csv"
    tmp = part.with_suffix(".tmp")
    fields = list(dict.fromkeys(k for row in r["rows"] for k in row))
    with tmp.open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=fields)
        w.writeheader()
        w.writerows(r["rows"])
    tmp.replace(part)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--tag", default="phase1")
    ap.add_argument("--index", default="all")
    ap.add_argument("--slots", default="grid")
    ap.add_argument("--from", dest="start", default=FROM.isoformat())
    ap.add_argument("--to", dest="end", default=TO.isoformat())
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--phase", type=int, default=1, choices=(1, 2), help="2 = the roll variants")
    ap.add_argument("--root", type=Path, default=None)
    args = ap.parse_args()
    root = args.root or data_dir()
    out = RESULTS / args.tag
    indices = list(g.INDICES) if args.index == "all" else args.index.split(",")
    slots = g.SLOTS if args.slots == "grid" else tuple(args.slots.split(","))
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    days = {i: cohort_days(root, g.INDICES[i], start, end) for i in indices}
    jobs = [(i, s) for i in indices for s in slots]
    pending = [
        (i, s) for i, s in jobs if not (out / "parts" / f"{i}_{s.replace(':', '')}.csv").exists()
    ]
    print(
        f"tag={args.tag} jobs={len(jobs)} pending={len(pending)} days={ {i: len(d) for i, d in days.items()} } "
        f"grid={g.grid_sha()} variants={len(g.variants())}",
        flush=True,
    )
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(run_job, i, s, days[i], str(root), args.phase): (i, s) for i, s in pending
        }
        for f in as_completed(futures):
            i, s = futures[f]
            r = f.result()
            write_part(out, f"{i}_{s.replace(':', '')}", r)
            print(
                f"done {i} {s}: {len(r['rows'])} cells x {len(r['days'])} days in {r['seconds']:.0f}s "
                f"(skipped {len(r['skipped'])})",
                flush=True,
            )
    rows = []
    for part in sorted((out / "parts").glob("*.csv")):
        with part.open(newline="") as h:
            rows += list(csv.DictReader(h))
    if rows:
        fields = list(dict.fromkeys(k for r in rows for k in r))
        with (out / "summary.csv").open("w", newline="") as h:
            w = csv.DictWriter(h, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {len(rows)} rows to {out / 'summary.csv'}", flush=True)


if __name__ == "__main__":
    main()
