"""BL-218: run the registered grid over the 10 sessions before every option expiry of each
root, both halves (the scorer reads them apart).

A job is one (root, session day): the day is loaded once and every cell is simulated on it.
Each day records its expiry, the session count back from expiry day (0 = expiry day), the week
(expiry / before), the half (fit / test), the season (summer / winter close) and, per cell, the
net after slippage and MCX charges, the gross, the charges, the number of trades and whether
anything was entered. A day `data_quality` excludes, or one that cannot be loaded (no settling
future), is recorded with its reason and no figures.

    uv run python research/bl218/run_grid.py --roots CRUDEOILM --tag main
    uv run python research/bl218/run_grid.py --roots CRUDEOILM --limit-cells 5 --tag smoke
    uv run python research/bl218/run_grid.py --roots CRUDEOILM --cells finalists.json \
        --slippage 0.5 --tag sens05

Output: results/<tag>/<ROOT>.npz (+ <ROOT>.json: grid version and SHA, days and their reasons).
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from functools import cache, lru_cache
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))

import grid  # noqa: E402
import mcx_charges  # noqa: E402
from trading_data import lake, quality  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.fyers.mcx import load_manifest  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402

RESULTS = HERE / "results"
#: the lot the backtest sizes with ("current": today's lot on every day, as the NSE items)
SIZING_DATE = date(2026, 11, 11)
_IST_OFFSET_S = 5 * 3600 + 1800


def schedule(root_dir: Path, root: str) -> list[dict]:
    """Every session the grid runs for `root`: the last 10 sessions up to each registered
    option expiry (expiry day included), with its expiry, k (sessions before expiry), week and
    half. Sessions are the days the lake holds an option file for the root (the MCX calendar as
    collected), quality exclusions included so that they are counted, not skipped silently."""
    sessions = lake.available_days(root_dir, "option", root)
    manifest = load_manifest(root_dir)
    expiries = sorted(date.fromisoformat(e) for e in manifest["roots"][root]["expiries"])
    out = []
    for e in expiries:
        half = (
            "fit"
            if grid.FIT[0] <= e <= grid.FIT[1]
            else "test"
            if grid.TEST[0] <= e <= grid.TEST[1]
            else None
        )
        if half is None:
            continue
        upto = [d for d in sessions if d <= e]
        if len(upto) < 10:
            continue  # the history starts inside this expiry's two weeks
        for k, d in enumerate(reversed(upto[-10:])):
            week = next(w for w, ks in grid.WEEKS.items() if k in ks)
            out.append({"day": d, "expiry": e, "k": k, "week": week, "half": half})
    return out


def season(root_dir: Path, root: str, day: date) -> str:
    """winter when the day's futures trade past 23:30 (the 23:55 close), else summer. The close
    is published in advance (it follows US daylight saving), so this is no look-ahead."""
    path = lake.bars_1m_path(root_dir, "future", root, day)
    if not path.exists():
        return "summer"
    ts = pq.read_table(path, columns=["ts"]).column("ts").cast("int64").to_numpy()
    if not len(ts):
        return "summer"
    unit = 1000 if ts.max() > 10**11 else 1  # ms or s on disk
    last = int((ts.max() // unit + _IST_OFFSET_S) % 86400 // 60)
    return "winter" if last >= 23 * 60 + 30 else "summer"


@lru_cache(maxsize=1)
def _cells_by_id() -> dict:
    return {c.id: c for c in grid.all_cells()}


@lru_cache(maxsize=1)
def _reference():
    return default_reference_data()


@cache
def _strategy(cell_id: str, root: str, season: str, slippage: float | None):
    """One worker builds each (cell, root, season, slippage) strategy once, not every session."""
    strategy = grid.build(_cells_by_id()[cell_id], root, season)
    if slippage is not None:
        execution = strategy.execution.model_copy(update={"slippage_pct": slippage})
        strategy = strategy.model_copy(update={"execution": execution})
    return strategy


def _run_day(job: tuple) -> dict:
    root_dir, root, day, cell_ids, slippage = job
    cells = [_cells_by_id()[i] for i in cell_ids]
    ref = _reference()
    n = len(cells)
    out = {
        "day": day,
        "reason": "",
        "net": np.full(n, np.nan),
        "gross": np.full(n, np.nan),
        "charges": np.full(n, np.nan),
        "trades": np.zeros(n, np.int16),
        "season": season(root_dir, root, day),
    }
    try:
        data = load_day(root_dir, root, day)
    except FileNotFoundError as error:
        out["reason"] = f"load: {error}"
        return out
    for i, cell in enumerate(cells):
        strategy = _strategy(cell.id, root, out["season"], slippage)
        result = simulate_day(strategy, data, ref, sizing_date=SIZING_DATE)
        charges = sum(mcx_charges.trade_charges(t) for t in result.trades)
        out["gross"][i] = result.gross
        out["charges"][i] = charges
        out["net"][i] = result.gross - charges
        out["trades"][i] = len(result.trades)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roots", default=",".join(grid.ROOTS))
    ap.add_argument("--tag", default="main")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--cells", help="JSON list of cell ids (finalists); default every cell")
    ap.add_argument("--limit-cells", type=int, help="the first N cells of each family (smoke)")
    ap.add_argument(
        "--slippage", type=float, help="sensitivity only; the registered 1%% is default"
    )
    args = ap.parse_args()

    root_dir = data_dir()
    if args.cells:
        cell_ids = json.loads(Path(args.cells).read_text())
    elif args.limit_cells:
        cell_ids = [c.id for f in grid.FAMILIES for c in grid.cells(f)[: args.limit_cells]]
    else:
        cell_ids = [c.id for c in grid.all_cells()]
    out_dir = RESULTS / args.tag
    out_dir.mkdir(parents=True, exist_ok=True)

    for root in args.roots.split(","):
        sched = schedule(root_dir, root)
        excluded = quality.excluded_days(root_dir, "option", root) or {}
        runnable = [s for s in sched if s["day"] not in excluded]
        jobs = [(root_dir, root, s["day"], cell_ids, args.slippage) for s in runnable]
        results: dict[date, dict] = {}
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            for r in pool.map(_run_day, jobs, chunksize=4):
                results[r["day"]] = r
        n = len(cell_ids)
        rows = []
        mats = {k: [] for k in ("net", "gross", "charges", "trades")}
        for s in sched:
            r = results.get(s["day"])
            reason = f"excluded: {excluded[s['day']]}" if s["day"] in excluded else r["reason"]
            rows.append(
                {
                    "day": s["day"].isoformat(),
                    "expiry": s["expiry"].isoformat(),
                    "k": s["k"],
                    "week": s["week"],
                    "half": s["half"],
                    "season": r["season"] if r else "",
                    "reason": reason,
                }
            )
            for k in mats:
                if r is None:
                    mats[k].append(np.zeros(n, np.int16) if k == "trades" else np.full(n, np.nan))
                else:
                    mats[k].append(r[k])
        np.savez_compressed(out_dir / f"{root}.npz", **{k: np.vstack(v) for k, v in mats.items()})
        (out_dir / f"{root}.json").write_text(
            json.dumps(
                {
                    "version": grid.VERSION,
                    "grid_sha": grid.grid_sha(),
                    "slippage_pct": args.slippage
                    if args.slippage is not None
                    else grid.SLIPPAGE_PCT,
                    "cells": cell_ids,
                    "days": rows,
                },
                indent=1,
            )
        )
        skipped = sum(1 for x in rows if x["reason"])
        print(f"{root}: {len(rows)} sessions ({skipped} not run), {n} cells -> {out_dir}")


if __name__ == "__main__":
    main()
