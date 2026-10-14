"""BL-102 Stage 2: is the winning plateau flat? (backlog/BL-102 Phase 2)

generate   from `results/<stage1>/<family>_band_winners.csv`, the top band candidate of each
           index x band and, at each of the band's slots, its one-change neighbourhood with
           the registered Stage-2 values (the in-between steps adjacent to the winner, the
           extra trails / exits / re-entries, square-off complete without re-entry, Buy gap
           and valid-until). Written as `results/<tag>/cells.json` for run_grid.py --cells.
           Nothing here promotes a value: the adopted set stays the Stage-1 winner.
evaluate   after the run: the neighbourhood's median Martin against the winner's, pooled over
           the band's slots; below 70 % the winner is "fragile" (rule 3) and the template stays.

uv run python research/bl102/stage2.py generate --stage1 stage1 --tag stage2
uv run python research/bl102/run_grid.py --cells research/bl102/results/stage2/cells.json --tag stage2
uv run python research/bl102/stage2.py evaluate --tag stage2
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

RESULTS = HERE / "results"
FLAT_RATIO = 0.70

# Registered Stage-2 values. "fine" lists are merged with the coarse axis and the two values
# adjacent to the winner's are taken; "each" lists are tried one at a time.
STAGE2: dict[str, dict[str, Any]] = {
    "W": {
        "fine": {
            "sl": (30, 50, 70, 90, 110, 130, 140, 160),
            "mtm": (1500, 2500, 3500, 5000),
            "exit": ("14:50", "15:00", "15:20"),
        },
        "each": {
            "trail": ((10, 5), (20, 10), (20, 15)),
            "reentry": (("cost", 2, None), ("asap", 1, None)),
        },
        "square_off_complete": True,
    },
    "D": {
        "fine": {
            "sl": (7, 12, 13, 17, 18, 22, 23, 27, 28, 33, 35, 37, 45),
            "mtm": (2500, 3500, 5000),
        },
        "each": {"trail": ((5, 5), (15, 5)), "exit": ("15:10",), "cutoff": ("11:00", "12:00")},
        "square_off_complete": True,
    },
    "B": {
        "fine": {"range": (5, 20, 45), "target": (30, 150), "mtm": (None, 1500, 3000)},
        "each": {"gap": (0.5, 1.0, 2.0), "valid": (30, 60), "exit": ("15:00", "15:28")},
        "square_off_complete": False,
    },
}
# Merged orders for the "fine" axes (coarse + fine), None = the loosest end of a stop.
ORDER: dict[str, dict[str, tuple[Any, ...]]] = {
    "W": {
        "sl": (30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160),
        "mtm": (1500, 2000, 2500, 3000, 3500, 4000, 5000, None),
        "exit": ("14:50", "15:00", "15:10", "15:20", "15:28"),
    },
    "D": {
        "sl": (7, 10, 12, 13, 15, 17, 18, 20, 22, 23, 25, 27, 28, 30, 33, 35, 37, 40, 45),
        "mtm": (2000, 2500, 3000, 3500, 4000, 5000, None),
    },
    "B": {
        "range": (5, 10, 15, 20, 30, 45),
        "target": (None, 30, 50, 100, 150),
        "mtm": (1000, 1500, 2000, 3000, None),
    },
}


def adjacent(order: tuple[Any, ...], value: Any) -> list[Any]:
    i = order.index(value)
    return [order[j] for j in (i - 1, i + 1) if 0 <= j < len(order)]


def neighbourhood(
    family: str, params: dict[str, Any], slot: str
) -> list[tuple[str, dict[str, Any]]]:
    """(change, params) pairs around a winner; only values the Stage-2 list registers."""
    spec = STAGE2[family]
    out: list[tuple[str, dict[str, Any]]] = []
    for axis, fine in spec["fine"].items():
        current = params.get(axis)
        for value in adjacent(ORDER[family][axis], current):
            if value in fine or (axis == "mtm" and value is None and None in fine):
                out.append((f"{axis}={grid.pretty(axis, value)}", {**params, axis: value}))
    for axis, values in spec["each"].items():
        for value in values:
            if axis == "cutoff":
                reentry = params.get("reentry")
                if reentry is None or value <= slot:
                    continue
                out.append(
                    (f"cutoff={value}", {**params, "reentry": (reentry[0], reentry[1], value)})
                )
            else:
                if params.get(axis) == value:
                    continue
                out.append((f"{axis}={grid.pretty(axis, value)}", {**params, axis: value}))
    if spec["square_off_complete"]:
        out.append(("square_off=complete", {**params, "reentry": None, "square_off": "complete"}))
    return out


def read_winners(stage1_dir: Path, family: str) -> list[dict[str, Any]]:
    path = stage1_dir / f"{family}_band_winners.csv"
    if not path.exists():
        return []
    with path.open(newline="") as handle:
        rows = [
            r
            for r in csv.DictReader(handle)
            if r["band_candidate"] == "True" and r["band_rank"] == "1"
        ]
    for r in rows:
        r["params"] = grid.params_from_row(family, r)
    return rows


def generate(stage1_dir: Path, out_dir: Path, families: tuple[str, ...]) -> None:
    items: list[dict[str, Any]] = []
    dropped: list[str] = []
    for family in families:
        for w in read_winners(stage1_dir, family):
            index, band_ = w["index"], w["band"]
            slots = w["slots"].split(",")
            winner = f"{family}_{index}_{band_}"
            for slot in slots:
                template = grid.load_template(family, index, slot)
                items.append(
                    {
                        "family": family,
                        "index": index,
                        "slot": slot,
                        "params": w["params"],
                        "role": "winner",
                        "winner": winner,
                        "change": "",
                    }
                )
                items.append(
                    {
                        "family": family,
                        "index": index,
                        "slot": slot,
                        "params": None,
                        "role": "template",
                        "winner": winner,
                        "change": "",
                    }
                )
                for change, params in neighbourhood(family, w["params"], slot):
                    cell = grid.Cell(family, index, slot, params)
                    try:
                        grid.build(cell, template)
                    except (ValueError, TypeError) as error:
                        dropped.append(f"{cell.label}: {str(error).splitlines()[0][:80]}")
                        continue
                    items.append(
                        {
                            "family": family,
                            "index": index,
                            "slot": slot,
                            "params": params,
                            "role": "neighbour",
                            "winner": winner,
                            "change": change,
                        }
                    )
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "cells.json").write_text(json.dumps(items, indent=1, default=list))
    (out_dir / "dropped.txt").write_text("\n".join(dropped) + ("\n" if dropped else ""))
    winners = {i["winner"] for i in items}
    print(
        f"{len(items)} cells for {len(winners)} winners ({sum(i['role'] == 'neighbour' for i in items)} neighbours, {len(dropped)} invalid dropped) -> {out_dir / 'cells.json'}",
        flush=True,
    )


def fnum(value: str) -> float:
    try:
        return float(value)
    except ValueError:
        return float("nan")


def evaluate(out_dir: Path) -> None:
    items = json.loads((out_dir / "cells.json").read_text())
    role_of: dict[str, tuple[str, str, str]] = {}
    for item in items:
        params = (
            None
            if item["params"] is None
            else {k: tuple(v) if isinstance(v, list) else v for k, v in item["params"].items()}
        )
        label = grid.Cell(item["family"], item["index"], item["slot"], params).label
        role_of[label] = (item["winner"], item["role"], item["change"])
    martin: dict[tuple[str, str, str], list[float]] = defaultdict(
        list
    )  # (winner, role, change) -> per-slot Martin
    for path in sorted(out_dir.glob("*_summary.csv")):
        with path.open(newline="") as handle:
            for row in csv.DictReader(handle):
                if row["label"] in role_of:
                    m = fnum(row["martin"])
                    martin[role_of[row["label"]]].append(-1e9 if math.isnan(m) else min(1e9, m))
    rows = []
    winners = sorted({k[0] for k in martin})
    for winner in winners:
        own = statistics.fmean(martin[(winner, "winner", "")])
        tmpl = (
            statistics.fmean(martin[(winner, "template", "")])
            if (winner, "template", "") in martin
            else float("nan")
        )
        neighbours = {
            k[2]: statistics.fmean(v)
            for k, v in martin.items()
            if k[0] == winner and k[1] == "neighbour"
        }
        median = statistics.median(neighbours.values()) if neighbours else float("nan")
        flat = median >= FLAT_RATIO * own if neighbours else False
        rows.append(
            {
                "winner": winner,
                "winner_martin": own,
                "template_martin": tmpl,
                "n_neighbours": len(neighbours),
                "neighbour_median_martin": median,
                "neighbour_min_martin": min(neighbours.values()) if neighbours else float("nan"),
                "worst_change": min(neighbours, key=neighbours.get) if neighbours else "",
                "rule3_flat": flat,
            }
        )
        print(
            f"{winner}: Martin {own:.1f}, neighbourhood median {median:.1f} ({len(neighbours)} changes) -> {'FLAT' if flat else 'FRAGILE'}; worst change {rows[-1]['worst_change']}",
            flush=True,
        )
    with (out_dir / "flatness.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["winner"])
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {out_dir / 'flatness.csv'}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--stage1", default="stage1")
    g.add_argument("--tag", default="stage2")
    g.add_argument("--family", default="all")
    e = sub.add_parser("evaluate")
    e.add_argument("--tag", default="stage2")
    args = parser.parse_args()
    if args.command == "generate":
        families = grid.FAMILIES if args.family == "all" else tuple(args.family.split(","))
        generate(RESULTS / args.stage1, RESULTS / args.tag, families)
    else:
        evaluate(RESULTS / args.tag)


if __name__ == "__main__":
    main()
