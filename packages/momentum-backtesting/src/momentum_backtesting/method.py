"""Score a finished search fairly (BL-010 Phase 4).

Three things the first scoring got wrong, and what this does instead:

  the rebalance week was searched   A config that trades every K weeks was scored on the one
                                    calendar phase the search happened to draw. Here it is
                                    scored on all K phases, as K equal tranches (finding F6).
  only summaries were kept          Every config's weekly equity is kept, so questions about
                                    selection can be answered from stored curves.
  "best" was read off one sample    `pbo` measures how often the config that looks best on
                                    half the history is below the median on the other half
                                    (probability of backtest overfitting, Bailey et al.).
"""

from __future__ import annotations

import itertools
import json
import math
import multiprocessing as mp
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import bias, metrics, search

PBO_BLOCKS = 16  # bl010_criteria.json: phase_4_method.pbo.blocks
PBO_KILL = 0.3  # ...pbo.kill_above
TRANCHE_KILL_PTS = 0.03  # ...offset_average.kill_if_tranche_mean_below_reported_pts


def _score_group(task: dict[str, Any]) -> dict[str, Any]:
    """One ranking, every config that shares it, each on all of its calendar phases."""
    space = search.load_space(Path(task["space_path"]))
    runner = bias.Runner(space, **task["runner"])
    dest = Path(task["dest"])
    base = runner.base(task["heavy"])
    locks = None
    curves: dict[str, pd.Series] = {}
    rows = []
    started = time.time()
    for run in task["runs"]:
        merged = {**space.fixed, **run["light"]}
        every = int(merged.get("rebalance_every", 1))
        capital = float(merged.get("capital", 1_000_000.0))
        row: dict[str, Any] = {"id": run["id"], "every": every}
        try:
            phases = []
            for offset in range(every):
                outcome, ranking = runner.run(
                    base,
                    task["heavy"],
                    run["light"],
                    locks=locks,
                    rebalance_offset=offset,
                    capital=capital / every,
                )
                locks = locks or runner.locks(ranking)
                phases.append(outcome.result.equity)
            blend = pd.concat(phases, axis=1).mean(axis=1)
            cagrs = [float(metrics.cagr(p)) for p in phases]
            own = int(merged.get("rebalance_offset", 0))
            row.update(
                cagr=float(metrics.cagr(blend)),
                mdd=float(metrics.max_drawdown(blend)[0]),
                cagr_own_phase=cagrs[own],
                cagr_best_phase=max(cagrs),
                cagr_worst_phase=min(cagrs),
            )
            curves[run["id"]] = blend
        except Exception as error:  # noqa: BLE001 - recorded; the rest of the group still runs
            row["error"] = f"{type(error).__name__}: {error}"[:300]
        rows.append(row)
    if curves:
        frame = pd.DataFrame(curves).astype("float32")
        frame.to_parquet(dest / f"curves-{task['index']:03d}.parquet")
    with (dest / f"scores-{task['index']:03d}.jsonl").open("w") as sink:
        sink.writelines(json.dumps(row) + "\n" for row in rows)
    return {"index": task["index"], "runs": len(rows), "secs": round(time.time() - started)}


def score_search(
    space_path: Path,
    results_dir: Path,
    dest: Path,
    *,
    workers: int = 4,
    runner: dict[str, Any] | None = None,
    limit: int | None = None,
    echo=print,
) -> None:
    """Re-run every config of a finished search on all its phases and keep the blended weekly
    curves. One task per ranking; a finished task's files are not redone. `runner` passes
    `universe_kind` / `category_tags` through to score the same configs on another universe."""
    dest.mkdir(parents=True, exist_ok=True)
    groups: dict[str, dict] = {}
    for path in sorted(Path(results_dir).glob("results-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "metrics" not in rec:
                continue
            key = json.dumps(rec["heavy"], sort_keys=True)
            group = groups.setdefault(key, {"heavy": rec["heavy"], "runs": {}})
            group["runs"][rec["id"]] = {"id": rec["id"], "light": rec["light"]}
    tasks = []
    for index, key in enumerate(sorted(groups)):
        if (dest / f"scores-{index:03d}.jsonl").exists():
            continue
        runs = list(groups[key]["runs"].values())[:limit]
        tasks.append(
            {
                "index": index,
                "space_path": str(Path(space_path).resolve()),
                "dest": str(dest),
                "heavy": groups[key]["heavy"],
                "runs": runs,
                "runner": runner or {},
            }
        )
    echo(f"{len(tasks)} of {len(groups)} rankings to score, {workers} workers")
    started = time.time()
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for done in pool.imap_unordered(_score_group, tasks):
            echo(
                f"  ranking {done['index']}: {done['runs']} configs in {done['secs']} s "
                f"(elapsed {time.time() - started:.0f} s)"
            )


def load_scores(dest: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(one row per config, weekly equity: weeks x config id)."""
    rows = [
        json.loads(line)
        for path in sorted(dest.glob("scores-*.jsonl"))
        for line in path.read_text().splitlines()
    ]
    curves = pd.concat(
        [pd.read_parquet(path) for path in sorted(dest.glob("curves-*.parquet"))], axis=1
    )
    return pd.DataFrame(rows).set_index("id"), curves.sort_index()


def pbo(log_returns: np.ndarray, blocks: int = PBO_BLOCKS) -> dict[str, float]:
    """Probability of backtest overfitting by combinatorially symmetric cross-validation.

    `log_returns` is weeks x configs (weekly log returns, or log excess returns over a
    benchmark). The weeks are cut into `blocks` equal runs; every way of choosing half of them
    is an in-sample half, the rest out of sample. In each split the config with the highest
    in-sample total is picked, and its out-of-sample total is ranked among all configs.

      pbo                  share of splits where the pick lands at or below the median
      picked_oos_negative  share of splits where the pick's out-of-sample total is below zero
      slope                out-of-sample total of the pick regressed on its in-sample total
                           (1 = it keeps what it showed, 0 = what it showed tells nothing)
    """
    weeks, configs = log_returns.shape
    size = weeks // blocks
    sums = np.stack(
        [log_returns[i * size : (i + 1) * size].sum(axis=0) for i in range(blocks)]
    )  # blocks x configs
    total = sums.sum(axis=0)
    below, negative, picked_in, picked_out = 0, 0, [], []
    splits = list(itertools.combinations(range(blocks), blocks // 2))
    for chosen in splits:
        inside = sums[list(chosen)].sum(axis=0)
        outside = total - inside
        best = int(np.argmax(inside))
        rank = (outside < outside[best]).sum() / (configs - 1)  # 0 = worst, 1 = best
        below += rank <= 0.5
        negative += outside[best] < 0
        picked_in.append(inside[best])
        picked_out.append(outside[best])
    slope = float(np.polyfit(picked_in, picked_out, 1)[0]) if len(set(picked_in)) > 1 else math.nan
    return {
        "splits": len(splits),
        "configs": configs,
        "weeks_used": size * blocks,
        "pbo": below / len(splits),
        "picked_oos_negative": negative / len(splits),
        "slope": slope,
        "picked_oos_median": float(np.median(picked_out)),
        "picked_is_median": float(np.median(picked_in)),
    }


def excess_log_returns(curves: pd.DataFrame, benchmark: pd.Series) -> pd.DataFrame:
    """Weekly log return of each curve over the benchmark's, on the weeks all of them have."""
    frame = curves.dropna(axis=0, how="any")
    bench = benchmark.reindex(frame.index).ffill()
    returns = np.log(frame.astype("float64")).diff().iloc[1:]
    return returns.sub(np.log(bench).diff().iloc[1:], axis=0)
