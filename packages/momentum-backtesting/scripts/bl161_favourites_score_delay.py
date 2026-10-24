"""BL-161: every favourite re-run with only the score and the signal delay changed.

Pre-registered in backlog/BL-161-favourites-score-and-friday-fill.md (Phase 0). On the original
local branch the pre-registration was committed (b5de3c0d) before this ran; on main it lands
together with the result. Reads a snapshot of GET /api/favorite-strategies, runs each individual
favourite config 6 ways (score in voladj/ranksum/blend x signal_delay in 1/0) through the same
Broad path the API uses, and writes one JSON row per run. Resumable: rows already in the output
are skipped.

    uv run python scripts/bl161_favourites_score_delay.py <favourites.json> <out.jsonl>
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from momentum_backtesting import api, metrics

SCORES = ("voladj", "ranksum", "blend")
DELAYS = (1, 0)


def individual_configs(favourites: list[dict]) -> list[dict]:
    """Every favourite with a config of its own; a group's members are favourites already."""
    seen: dict[str, dict] = {}
    for fav in favourites:
        for run in fav.get("members") or [fav]:
            if "group" in run["config"] or run["id"] in seen:
                continue
            seen[run["id"]] = run
    return list(seen.values())


def curve_stats(eq: pd.Series, bench: pd.Series) -> dict:
    summary_dd = eq / eq.cummax() - 1
    ulcer = float(np.sqrt((summary_dd**2).mean()))
    worst = np.sort(summary_dd.to_numpy())  # most negative first
    tail = worst[: max(1, int(np.ceil(0.05 * len(worst))))]
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = float((eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1)
    return {"ulcer": ulcer, "martin": cagr / ulcer if ulcer else None, "cdar95": float(tail.mean())}


def run_one(config: dict, score: str, delay: int) -> dict:
    req = api.BacktestRequest(**{**config, "score": score, "signal_delay": delay})
    ranking = api._broad_ranking(req)
    outcome = api._run_broad(req, ranking, api.DATA.get())
    result = outcome.result
    stats = metrics.summary(result)
    extra = curve_stats(result.equity, result.benchmark)
    return {
        "cagr": stats["CAGR"],
        "benchmark_cagr": stats["benchmark CAGR"],
        "excess_cagr": stats["CAGR"] - stats["benchmark CAGR"],
        "max_drawdown": stats["max drawdown"],
        "sharpe": stats["Sharpe (vs cash)"],
        "turnover": metrics.turnover(result),
        "start": stats["start"],
        "end": stats["end"],
        **extra,
    }


def main(favourites_path: str, out_path: str) -> None:
    favourites = json.loads(Path(favourites_path).read_text())
    configs = individual_configs(favourites)
    out = Path(out_path)
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            row = json.loads(line)
            done.add((row["id"], row["score"], row["signal_delay"]))
    print(
        f"{len(configs)} configs x {len(SCORES) * len(DELAYS)} = "
        f"{len(configs) * len(SCORES) * len(DELAYS)} runs; {len(done)} already done",
        flush=True,
    )
    for run in configs:
        config = run["config"]
        for score in SCORES:
            for delay in DELAYS:
                key = (run["id"], score, delay)
                if key in done:
                    continue
                started = time.time()
                row = {
                    "id": run["id"],
                    "name": run["name"],
                    "saved_score": config.get("score"),
                    "saved_delay": config.get("signal_delay"),
                    "saved_kpis": run.get("kpis", {}),
                    "score": score,
                    "signal_delay": delay,
                }
                try:
                    row.update(run_one(config, score, delay))
                except Exception as error:  # noqa: BLE001 - record and carry on overnight
                    row["error"] = f"{type(error).__name__}: {error}"
                row["seconds"] = round(time.time() - started, 1)
                with out.open("a") as handle:
                    handle.write(json.dumps(row) + "\n")
                print(
                    f"{run['name'][:40]:40} {score:8} d{delay} "
                    f"{row.get('cagr', float('nan')):.4f} {row['seconds']}s "
                    f"{row.get('error', '')}",
                    flush=True,
                )
                api.DATA.trim_cache()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
