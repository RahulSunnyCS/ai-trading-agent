"""BL-202 Stage 2: the new axes around each cohort's Stage-1 plateau cells.

    uv run python research/bl202/stage2.py generate [--stage1 stage1] [--top 5] [--date D]
    uv run python research/bl202/run_grid.py --cells research/bl202/results/stage2/cells.json --tag stage2 --workers 2
    uv run python research/bl202/stage2.py evaluate [--stage2 stage2] [--half fit]

`generate` reads Stage 1's fit-half ranking (`results/<stage1>/B_ranked_fit.csv`), takes each
cohort's top `--top` plateau cells (candidates in `cohort_rank` order) plus its template as the
BASE cells, and crosses every base with the registered Stage-2 axes (`grid.STAGE2`: exit × gap ×
valid-until × stop judged on × one re-entry at cost × peak trail = 288 a base). A cohort with no
candidate is KILLED (backlog/BL-202 Phase 0: "a cohort whose best Stage-1 plateau cell fails the
gates on the fit half has no Stage 2 and no finalist"). Left out, and counted: an exit earlier
than start + 60 min (`grid.excluded`) and a valid-until that `grid.build` would collapse to none
(at or past the exit), which would otherwise run the same strategy twice under two labels.

It writes TWO files: the committed pre-registration `stage2_cells_<date>.json` beside this script
(the bases with their Stage-1 figures, the killed cohorts, the counts and a SHA of the expanded
cell list) and the runner's input `results/stage2/cells.json` (the expanded list, git-ignored).
`evaluate` re-expands the committed file, checks the SHA, and reads the Stage-2 parts with
`score.py`'s half statistics: the base cell under Stage-2's default values must reproduce its
Stage-1 figure to the rupee (a regression line per cohort), then per axis and per base the change
in the fit-half lower bound of ₹ a lot-day when ONLY that axis moves off its default, so each axis
reads as flat or moves it. Whether an axis PASSES is Stage 3's rule (2) on the test half; this
table never reads the test half.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import statistics
import sys
from datetime import date
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

RESULTS = HERE / "results"
TOP = 5
#: the Stage-2 value of each axis that leaves a base cell as Stage 1 ran it
DEFAULTS: dict[str, Any] = {
    "exit": grid.ROTATION_EXIT,
    "gap": 0.0,
    "valid": None,
    "stop_on": "tick",
    "reentry": None,
    "peak": None,
}
STAGE2_AXES = tuple(grid.STAGE2)


def read_ranked(stage1: str) -> list[dict[str, str]]:
    path = RESULTS / stage1 / "B_ranked_fit.csv"
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def cohort_of(index: str, slot: str) -> str:
    return grid.Cell(index, slot, None).cohort


def valid_collapses(slot: str, exit_time: str, params: dict[str, Any]) -> bool:
    """Would `grid.build` turn this valid-until into none? Then the cell is a duplicate."""
    valid = params.get("valid")
    if valid is None:
        return False
    valid_until = grid.hhmm_plus(slot, valid)
    until = grid.hhmm_plus(slot, params["range"]) if "range" in params else None
    if until is None:  # the template base: its own range window
        template = grid.load_template(params["_index"], slot)
        until = template.legs[0].range_breakout.until
    return valid_until <= until or valid_until >= exit_time


def expand(base: dict[str, Any], slot: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Every Stage-2 cell of one base: its params plus one value per Stage-2 axis."""
    cells: list[dict[str, Any]] = []
    dropped = {"exit_before_min_hold": 0, "valid_until_collapses": 0}
    base_params = base["params"]
    for combo in grid.cartesian(grid.STAGE2):
        if grid.excluded(slot, combo) is not None:
            dropped["exit_before_min_hold"] += 1
            continue
        probe = {**(base_params or {"base": grid.TEMPLATE}), **combo, "_index": base["index"]}
        if valid_collapses(slot, combo["exit"], probe):
            dropped["valid_until_collapses"] += 1
            continue
        params = {**(base_params or {"base": grid.TEMPLATE}), **combo}
        cells.append({"index": base["index"], "slot": slot, "params": params})
    return cells, dropped


def is_default(params: dict[str, Any]) -> bool:
    return all(params.get(axis) == value for axis, value in DEFAULTS.items())


def json_ready(value: Any) -> Any:
    if isinstance(value, tuple):
        return [json_ready(v) for v in value]
    if isinstance(value, dict):
        return {k: json_ready(v) for k, v in value.items()}
    return value


def cells_sha(cells: list[dict[str, Any]]) -> str:
    text = json.dumps(json_ready(cells), sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()[:16]


STAGE1_FIELDS = (
    "cohort_rank",
    "robust",
    "lb_day_inr",
    "avg_day_inr",
    "profit_factor",
    "martin",
    "entry_hit_rate",
    "stop_frequency",
    "worst5_inr",
    "max_drawdown_inr",
    "neighbour_median_lb_inr",
)


def generate(stage1: str, top: int, day: str) -> dict[str, Any]:
    rows = read_ranked(stage1)
    by_cohort: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        by_cohort.setdefault(row["cohort"], []).append(row)
    bases: list[dict[str, Any]] = []
    killed: dict[str, str] = {}
    for cohort in sorted(by_cohort):
        members = by_cohort[cohort]
        index, slot = members[0]["index"], members[0]["slot"]
        candidates = sorted(
            (r for r in members if r["candidate"] == "True"), key=lambda r: int(r["cohort_rank"])
        )
        if not candidates:
            n_pass = sum(r["passes"] == "True" for r in members)
            killed[cohort] = (
                f"no plateau candidate on the fit half ({n_pass} of {len(members)} cells pass "
                "the gates, none with half its neighbours passing)"
            )
            continue
        template = next(r for r in members if r["cell"] == grid.TEMPLATE)
        chosen = candidates[:top]
        if template not in chosen:  # a template that is itself a top-five candidate counts once
            chosen.append(template)
        for r in chosen:
            bases.append(
                {
                    "cohort": cohort,
                    "index": index,
                    "slot": slot,
                    "label": r["label"],
                    "params": grid.params_from_row(r),
                    "stage1": {k: r[k] for k in STAGE1_FIELDS},
                }
            )
    cells: list[dict[str, Any]] = []
    dropped: dict[str, int] = {"exit_before_min_hold": 0, "valid_until_collapses": 0}
    per_cohort: dict[str, int] = {}
    for base in bases:
        expanded, d = expand(base, base["slot"])
        cells.extend(expanded)
        for k, v in d.items():
            dropped[k] += v
        per_cohort[base["cohort"]] = per_cohort.get(base["cohort"], 0) + len(expanded)
    return {
        "version": "bl202-stage2",
        "generated": day,
        "stage1_tag": stage1,
        "grid_sha": grid.grid_sha(),
        "top": top,
        "stage2_axes": json_ready(grid.STAGE2),
        "defaults": json_ready(DEFAULTS),
        "killed": killed,
        "bases": json_ready(bases),
        "counts": {
            "bases": len(bases),
            "cells": len(cells),
            "per_cohort": per_cohort,
            "dropped": dropped,
        },
        "cells_sha": cells_sha(cells),
        "_cells": cells,
    }


def write_generated(spec: dict[str, Any], day: str) -> tuple[Path, Path]:
    cells = spec.pop("_cells")
    committed = HERE / f"stage2_cells_{day}.json"
    committed.write_text(json.dumps(spec, indent=1) + "\n")
    out = RESULTS / "stage2" / "cells.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(json_ready(cells)))
    return committed, out


def reexpand(committed: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    spec = json.loads(committed.read_text())
    cells: list[dict[str, Any]] = []
    for base in spec["bases"]:
        params = base["params"]
        if params is not None:
            params = {k: tuple(v) if isinstance(v, list) else v for k, v in params.items()}
        expanded, _ = expand({**base, "params": params}, base["slot"])
        cells.extend(expanded)
    if cells_sha(cells) != spec["cells_sha"]:
        raise SystemExit(f"{committed.name}: the expanded cells no longer match cells_sha")
    return spec, cells


def label_of(index: str, slot: str, params: dict[str, Any] | None) -> str:
    return grid.Cell(index, slot, params).label


def evaluate(stage2: str, committed: Path, half: str) -> str:
    """The Stage-2 table: regression per cohort, then each axis's effect per base."""
    import numpy as np

    score = _load_scorer()
    spec, cells = reexpand(committed)
    out_dir = RESULTS / stage2
    lines = [
        f"## BL-202 Stage 2 — {stage2}, {half} half, bases from {committed.name} "
        f"(grid {spec['grid_sha']}, cells {spec['cells_sha']})",
        "",
        "Per cohort: does each base cell under Stage 2's defaults (exit 15:14, gap 0, no "
        "valid-until, stop on tick, no re-entry, no peak trail) reproduce its Stage-1 figure; then "
        "per axis the change in the lower bound of ₹ a lot-day when ONLY that axis moves off its "
        "default (median over the bases, and the best base). Flat = |median Δ| < ₹10. Whether an "
        "axis passes is Stage 3's rule (2) on the test half, never read here.",
        "",
    ]
    stage1_lb = {b["label"]: float(b["stage1"]["lb_day_inr"]) for b in spec["bases"]}
    stage1_avg = {b["label"]: float(b["stage1"]["avg_day_inr"]) for b in spec["bases"]}
    all_rows: list[dict[str, Any]] = []
    for cohort in sorted({c["index"] + c["slot"] for c in cells}):
        index, slot = cohort[0], cohort[1:]
        name = cohort_of(index, slot)
        try:
            data = score.load_cohort(out_dir, name)
        except FileNotFoundError:
            lines += [f"### {name}: no part yet", ""]
            continue
        stats = score.half_stats(data, half)
        labels = data["labels"]
        by_label = {label: i for i, label in enumerate(labels)}
        bases = [b for b in spec["bases"] if b["cohort"] == name]
        lines += [f"### {name} — {half} half, {int(stats['n_days'])} days", ""]
        reg: list[str] = []
        axis_rows: list[list[str]] = []
        for base in bases:
            params = base["params"]
            if params is not None:
                params = {k: tuple(v) if isinstance(v, list) else v for k, v in params.items()}
            base_params = params or {"base": grid.TEMPLATE}
            default_label = label_of(index, slot, {**base_params, **DEFAULTS})
            i0 = by_label.get(default_label)
            if i0 is None:
                reg.append(f"- {base['label']}: default cell missing from the part")
                continue
            lb0, avg0 = float(stats["lb_day_inr"][i0]), float(stats["avg_day_inr"][i0])
            same = (
                abs(avg0 - stage1_avg[base["label"]]) < 0.5
                and abs(lb0 - stage1_lb[base["label"]]) < 0.5
            )
            reg.append(
                f"- {base['label']}: Stage 1 {stage1_avg[base['label']]:.0f} (LB "
                f"{stage1_lb[base['label']]:.0f}) vs Stage 2 default {avg0:.0f} (LB {lb0:.0f}) — "
                + ("same" if same else "DIFFERS")
            )
            for axis in STAGE2_AXES:
                for value in grid.STAGE2[axis]:
                    if value == DEFAULTS[axis]:
                        continue
                    label = label_of(index, slot, {**base_params, **DEFAULTS, axis: value})
                    i = by_label.get(label)
                    if i is None:
                        continue
                    lb, avg = float(stats["lb_day_inr"][i]), float(stats["avg_day_inr"][i])
                    all_rows.append(
                        {
                            "cohort": name,
                            "base": base["label"],
                            "axis": axis,
                            "value": grid.pretty(axis, value),
                            "lb_day_inr": lb,
                            "avg_day_inr": avg,
                            "delta_lb_inr": lb - lb0,
                            "delta_avg_inr": avg - avg0,
                            "entry_hit_rate": float(stats["entry_hit_rate"][i]),
                            "stop_frequency": float(stats["stop_frequency"][i]),
                            "worst5_inr": float(stats["worst5_inr"][i]),
                            "profit_factor": float(stats["profit_factor"][i]),
                        }
                    )
        lines += ["Regression (base under Stage-2 defaults vs its Stage-1 figure):", *reg, ""]
        cohort_rows = [r for r in all_rows if r["cohort"] == name]
        if cohort_rows:
            lines += [
                "| axis | value | bases | median Δ LB | median Δ ₹/day | best Δ LB (base) | "
                "median entry % | median stop % | verdict |",
                "|---|---|---|---|---|---|---|---|---|",
            ]
            for axis in STAGE2_AXES:
                for value in grid.STAGE2[axis]:
                    if value == DEFAULTS[axis]:
                        continue
                    rows = [
                        r
                        for r in cohort_rows
                        if r["axis"] == axis and r["value"] == grid.pretty(axis, value)
                    ]
                    if not rows:
                        continue
                    med = statistics.median(r["delta_lb_inr"] for r in rows)
                    best = max(rows, key=lambda r: r["delta_lb_inr"])
                    axis_rows.append(
                        [
                            axis,
                            grid.pretty(axis, value),
                            str(len(rows)),
                            f"{med:+.0f}",
                            f"{statistics.median(r['delta_avg_inr'] for r in rows):+.0f}",
                            f"{best['delta_lb_inr']:+.0f} ({best['base'].replace(name + '_', '')})",
                            f"{100 * statistics.median(r['entry_hit_rate'] for r in rows):.0f}",
                            f"{100 * statistics.median(r['stop_frequency'] for r in rows):.0f}",
                            "flat" if abs(med) < 10 else ("up" if med > 0 else "down"),
                        ]
                    )
            lines += ["| " + " | ".join(r) + " |" for r in axis_rows]
            lines.append("")
        # the cohort's best Stage-2 cells outright, for the finalist choice
        order = np.argsort(-np.nan_to_num(stats["lb_day_inr"], nan=-1e9))[:10]
        lines += [
            f"Top 10 Stage-2 cells by {half}-half lower bound:",
            "",
            "| label | LB ₹/day | ₹/day | PF | entry % | stop % | worst 5 |",
            "|---|---|---|---|---|---|---|",
        ]
        for i in order:
            lines.append(
                f"| {labels[i].replace(name + '_', '')} | {stats['lb_day_inr'][i]:.0f} | "
                f"{stats['avg_day_inr'][i]:.0f} | {stats['profit_factor'][i]:.2f} | "
                f"{100 * stats['entry_hit_rate'][i]:.0f} | {100 * stats['stop_frequency'][i]:.0f} | "
                f"{stats['worst5_inr'][i]:,.0f} |"
            )
        lines.append("")
    if all_rows:
        path = out_dir / f"stage2_axes_{half}.csv"
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(all_rows[0]))
            writer.writeheader()
            writer.writerows(all_rows)
    text = "\n".join(lines)
    (out_dir / f"stage2_table_{half}.md").write_text(text + "\n")
    return text


def _load_scorer():
    import importlib.util

    spec = importlib.util.spec_from_file_location("bl202_score", HERE / "score.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--stage1", default="stage1", help="results/<tag>/ of the Stage 1 scoring")
    g.add_argument("--top", type=int, default=TOP)
    g.add_argument("--date", default=date.today().isoformat())
    e = sub.add_parser("evaluate")
    e.add_argument("--stage2", default="stage2", help="results/<tag>/ of the Stage 2 run")
    e.add_argument(
        "--cells", type=Path, default=None, help="the committed stage2_cells_<date>.json"
    )
    e.add_argument("--half", default="fit", choices=("fit", "all"))
    args = parser.parse_args()
    if args.command == "generate":
        spec = generate(args.stage1, args.top, args.date)
        counts = spec["counts"]
        committed, out = write_generated(spec, args.date)
        print(f"killed: {spec['killed'] or 'none'}")
        print(
            f"bases {counts['bases']}, cells {counts['cells']}, per cohort {counts['per_cohort']}"
        )
        print(f"dropped {counts['dropped']}; cells sha {spec['cells_sha']}")
        print(f"wrote {committed} and {out}")
        return
    committed = args.cells or sorted(HERE.glob("stage2_cells_*.json"))[-1]
    print(evaluate(args.stage2, committed, args.half))


if __name__ == "__main__":
    main()
