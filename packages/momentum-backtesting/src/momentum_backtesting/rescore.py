"""Re-run finished search candidates over the FULL period and record how their equity curve behaves
over time, not just how deep it dips: time under water, new highs, and how each weak stretch went.

A search keeps summary numbers (CAGR, max drawdown depth). "Steady highs" - a curve that keeps
setting new highs even while the market goes nowhere - needs the curve itself, so the candidates
are re-run and the weekly equity is kept. Nothing here picks a winner; `steady.py` does that.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import time
from pathlib import Path
from typing import Any

import pandas as pd

from . import bias, metrics, reference_benchmarks, search
from .engine import IDLE

#: The two stretches the owner named: mid-caps weak, then a market that could not regain its highs.
WEAK = {"w1": ("2017-01-01", "2019-12-31"), "w2": ("2024-01-01", None)}
#: Three consecutive blocks of the full history, for "does no block lag the benchmark".
BLOCKS = {
    "b1": ("2017-01-01", "2019-12-31"),
    "b2": ("2020-01-01", "2022-12-31"),
    "b3": ("2023-01-01", None),
}
WINDOWS = {**WEAK, **BLOCKS}
REFS = ("Nifty 50 TRI", "Nifty200 Momentum 30 TRI")


def window_hurdles(refs: pd.DataFrame, index: pd.DatetimeIndex) -> dict[str, float]:
    """Each reference's CAGR over every named window of `index` (the backtest's weeks)."""
    out: dict[str, float] = {}
    for name, (start, end) in WINDOWS.items():
        weeks = index[
            (index >= pd.Timestamp(start)) & (True if end is None else index <= pd.Timestamp(end))
        ]
        if len(weeks) < 2:
            continue
        for ref in REFS:
            if ref not in refs:
                continue
            aligned = reference_benchmarks.aligned(refs[ref], weeks)
            if aligned is not None:
                out[f"{name}|{ref}"] = round(float(metrics.cagr(aligned)), 5)
    return out


def underwater_reference(refs: pd.DataFrame, index: pd.DatetimeIndex) -> dict[str, dict]:
    """The benchmarks' own time under water over the same weeks, for context."""
    out = {}
    for ref in REFS:
        if ref in refs:
            aligned = reference_benchmarks.aligned(refs[ref], index)
            if aligned is not None:
                out[ref] = {
                    **metrics.underwater_stats(aligned),
                    **metrics.window_stats(aligned, WINDOWS),
                    "cagr": float(metrics.cagr(aligned)),
                    "mdd": float(metrics.max_drawdown(aligned)[0]),
                }
    return out


def run_group(task: dict[str, Any]) -> dict[str, Any]:
    space = search.load_space(Path(task["space_path"]))
    heavy = task["heavy"]
    runner = bias.Runner(space)
    base = runner.base(heavy)
    locks = None
    out_path = Path(task["out_dir"]) / f"rescore-{os.getpid()}.jsonl"
    started = time.time()
    done = errors = 0
    with out_path.open("a", buffering=1) as sink:
        for rec in task["recs"]:
            row: dict[str, Any] = {"id": rec["id"], "heavy": heavy, "light": rec["light"]}
            try:
                outcome, ranking = runner.run(base, heavy, rec["light"], locks=locks)
                if locks is None:
                    locks = runner.locks(ranking)
                eq = outcome.result.equity
                row["metrics"] = search.run_metrics(outcome.result, IDLE)
                row["windows"] = metrics.window_stats(eq, WINDOWS)
                row["hurdles"] = window_hurdles(runner.refs, eq.index)
                row["equity"] = [round(float(x), 4) for x in eq]
                done += 1
            except Exception as error:  # noqa: BLE001 - recorded, never fatal
                row["error"] = f"{type(error).__name__}: {error}"[:300]
                errors += 1
            sink.write(json.dumps(row, default=float) + "\n")
    return {
        "heavy": len(task["recs"]),
        "done": done,
        "errors": errors,
        "secs": round(time.time() - started, 1),
    }


def run_rescore(
    results_dir: Path,
    space_path: Path,
    dest: Path,
    *,
    min_cagr: float = 0.20,
    workers: int = 4,
    echo=print,
) -> None:
    df = search.load_results(results_dir)
    pool = df[
        df["error"].isna() & (df.cagr >= min_cagr) & (df.turnover_x <= 3) & (df.buys_per_yr >= 10)
    ]
    records = bias.load_records(results_dir, set(pool["id"]))
    dest.mkdir(parents=True, exist_ok=True)
    seen = {
        json.loads(line)["id"]
        for p in dest.glob("rescore-*.jsonl")
        for line in p.read_text().splitlines()
        if line.startswith("{")
    }
    groups: dict[str, list[dict[str, Any]]] = {}
    for rec in records.values():
        if rec["id"] not in seen:
            groups.setdefault(json.dumps(rec["heavy"], sort_keys=True, default=list), []).append(
                rec
            )
    tasks = []
    for key, recs in groups.items():
        heavy = json.loads(key)
        for i in range(
            0, len(recs), 150
        ):  # chunks, so progress is visible and a crash loses little
            tasks.append(
                {
                    "space_path": str(Path(space_path).resolve()),
                    "out_dir": str(dest),
                    "heavy": heavy,
                    "recs": recs[i : i + 150],
                }
            )
    total = sum(len(t["recs"]) for t in tasks)
    echo(
        f"{len(pool)} candidates (CAGR >= {min_cagr:.0%}), {len(seen)} already done, "
        f"{total} to run in {len(tasks)} chunks, {workers} worker(s)"
    )
    if not tasks:
        return
    ctx = mp.get_context("spawn")
    started = time.time()
    with ctx.Pool(workers, maxtasksperchild=1) as pool_:
        for i, s in enumerate(pool_.imap_unordered(run_group, tasks), 1):
            echo(
                f"  chunk {i}/{len(tasks)}: {s['done']} ok, {s['errors']} errors, {s['secs']} s "
                f"(elapsed {time.time() - started:.0f} s)"
            )


def load_rescored(dest: Path) -> pd.DataFrame:
    rows = []
    for path in sorted(Path(dest).glob("rescore-*.jsonl")):
        for line in path.read_text().splitlines():
            if not line.startswith("{"):
                continue
            rec = json.loads(line)
            if "metrics" not in rec:
                continue
            flat = {
                "id": rec["id"],
                **rec["metrics"],
                **rec["windows"],
                **{f"hurdle_{k}": v for k, v in rec["hurdles"].items()},
            }
            flat["_heavy"] = json.dumps(rec["heavy"], sort_keys=True, default=list)
            flat["_light"] = json.dumps(rec["light"], sort_keys=True, default=list)
            flat["_equity"] = rec["equity"]
            rows.append(flat)
    return pd.DataFrame(rows).drop_duplicates("id") if rows else pd.DataFrame()
