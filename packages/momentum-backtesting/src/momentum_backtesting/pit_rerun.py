"""The same configs on a universe that could have been known at the time (BL-010 Phase 3).

Round 7's arm A ranks today's 755 Total Market names in every year. This re-runs chosen
configs unchanged on three universes and writes one line per run:

  as_searched      today's index list, the curated category tags (what the search saw)
  pit_curated      each year's 750 most-traded stocks, the curated tags
  pit_extended     the same universe, with the wider tag file that also covers stocks outside
                   today's list

The curated tags name only today's 755, so under `pit_curated` a stock that later left the
index can be ranked but never picked through a category: it still leans on hindsight. The
extended tags remove that, at the cost of coarser categories.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from . import bias, search
from .engine import IDLE

VARIANTS = {
    "as_searched": {},
    "pit_curated": {"universe_kind": "turnover_rank", "category_tags": "curated"},
    "pit_extended": {"universe_kind": "turnover_rank", "category_tags": "extended"},
}


def pick(results_dir: Path, top: int, also: dict[str, str]) -> dict[str, str]:
    """label -> run id: the `top` runs by stored CAGR, plus named ones."""
    frame = search.load_results(results_dir)
    frame = frame[frame["error"].isna()] if "error" in frame else frame
    best = frame.nlargest(top, "cagr")
    picks = {f"top{i + 1:02d}": run_id for i, run_id in enumerate(best["id"])}
    return {**picks, **also}


def run(space_path: Path, results_dir: Path, picks: dict[str, str], out: Path, echo=print) -> None:
    """Resumable: a (variant, run id) already in `out` is skipped."""
    space = search.load_space(space_path)
    records = bias.load_records(results_dir, set(picks.values()))
    done = set()
    if out.exists():
        for line in out.read_text().splitlines():
            row = json.loads(line)
            done.add((row["variant"], row["id"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    for variant, kwargs in VARIANTS.items():
        runner = bias.Runner(space, **kwargs)
        bases: dict[str, object] = {}
        for label, run_id in picks.items():
            if (variant, run_id) in done:
                continue
            rec = records[run_id]
            key = json.dumps(rec["heavy"], sort_keys=True)
            started = time.time()
            row = {"variant": variant, "label": label, "id": run_id}
            try:
                if key not in bases:
                    if len(bases) >= 3:
                        bases.pop(next(iter(bases)))
                    bases[key] = runner.base(rec["heavy"])
                outcome, _ranking = runner.run(bases[key], rec["heavy"], rec["light"])
                row["metrics"] = search.run_metrics(outcome.result, IDLE)
            except Exception as error:  # noqa: BLE001 - recorded, the rest still run
                row["error"] = f"{type(error).__name__}: {error}"[:300]
            row["secs"] = round(time.time() - started, 1)
            with out.open("a") as sink:
                sink.write(json.dumps(row) + "\n")
            shown = row.get("metrics", {}).get("cagr", row.get("error"))
            echo(f"{variant} {label} {run_id}: {shown} ({row['secs']} s)")
            done.add((variant, run_id))


def table(out: Path) -> dict:
    """variant -> label -> metrics, and the summary the review reads."""
    rows: dict[str, dict[str, dict]] = {}
    for line in out.read_text().splitlines():
        row = json.loads(line)
        if "metrics" in row:
            rows.setdefault(row["variant"], {})[row["label"]] = row["metrics"]
    return rows
