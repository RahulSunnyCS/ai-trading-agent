"""BL-176 Stage 2: derive one arm's focused search space from its Stage 1 results, by rule.

Registered in backlog/BL-176-momentum-search-on-f6-ranking.md (Phase 0) and committed before
Stage 1 ran, so the Stage 2 ranges come from this rule and never from reading the results:

  1. Per drawdown basket (criteria.json): the Stage 1 runs whose every fall passes it, ranked by
     the rank measure the search recorded for each run (`search.rank_measures`: the 25th
     percentile of its financial-year excess over Nifty200 Momentum 30 TRI, pre-tax, on the run's
     own sampled Friday). The basket's top 5% (rounded up) is kept if it holds at least 20 runs.
  2. The kept runs of every qualifying basket are pooled (a run in two baskets counts once).
     No basket qualifies: the arm gets no Stage 2, and the script says so (exit 0).
  3. Each numeric light axis: the pool's 10th to 90th percentile, clipped to Stage 1's range
     (an int axis widens to whole numbers: floor of the 10th, ceiling of the 90th). A band axis is
     read as exit rank minus top. `rebalance_offset_raw` keeps Stage 1's whole range: every
     Stage 3 figure is the all-Fridays blend, so the offset is never chosen.
  4. Each choice axis, light and heavy: the values held by at least 10% of the pool, in Stage 1's
     order. The heavy combinations are the product of those values (`canonical_heavy` removes
     the inert ones); all of them run.
  5. Runs per heavy combination: 7,000 / combinations, rounded up, between 100 and 500.

The fixed block is copied unchanged. The seed is 9 (Stage 1 used 8).

    uv run python scripts/bl176_focus.py data/search/round8_A_curated \
        --space search_spaces/round8_A_curated.toml --out search_spaces/round8_A_curated_focus.toml
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np

from momentum_backtesting import criteria
from momentum_backtesting import search as sr

# The rule's numbers are read from the committed criteria file, never restated here (the
# package rule; BL-176 review).
_KEYS = json.loads((criteria.SPACES / "bl176_criteria.json").read_text())["stage_2"]["keys"]
TOP_SHARE = _KEYS["top_share"]
MIN_KEPT = _KEYS["min_kept"]
LOW_PCT, HIGH_PCT = _KEYS["low_pct"], _KEYS["high_pct"]
MIN_VALUE_SHARE = _KEYS["min_value_share"]
TARGET_RUNS = _KEYS["target_runs"]
LIGHT_MIN, LIGHT_MAX = _KEYS["light_min"], _KEYS["light_max"]
SEED = _KEYS["seed"]
BANDS = {
    "pool_band": ("pool_top_n", "pool_exit_rank"),
    "category_band": ("category_top_n", "category_exit_rank"),
    "off_band": ("off_top_n", "off_exit_rank"),
}


def load_rows(results_dir: Path) -> list[dict[str, Any]]:
    """Every finished Stage 1 run that carries the rank measures."""
    rows = []
    for path in sorted(Path(results_dir).glob("results-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn last line from a stopped run
            if "metrics" in row and "rank" in row:
                rows.append(row)
    return rows


def pool(rows: list[dict[str, Any]], baskets: list[str]) -> tuple[list[dict], dict[str, int]]:
    """Steps 1 and 2: the pooled top runs, and how many each basket kept (0 = did not qualify)."""
    kept: dict[str, dict] = {}
    report = {}
    for basket in baskets:
        members = [r for r in rows if basket in r["rank"]["baskets"]]
        members.sort(key=lambda r: (-r["rank"]["lb_fy_excess"], r["id"]))
        top = members[: math.ceil(TOP_SHARE * len(members))]
        report[basket] = len(top) if len(top) >= MIN_KEPT else 0
        if len(top) >= MIN_KEPT:
            kept.update({r["id"]: r for r in top})
    return list(kept.values()), report


def axis_value(dim: sr.Dim, light: dict[str, Any]) -> Any:
    if dim.name in BANDS:
        top, exit_ = BANDS[dim.name]
        return light[exit_] - light[top]
    return light[dim.name]


def numeric_range(dim: sr.Dim, values: list[float]) -> list:
    lo, hi = np.percentile(values, [LOW_PCT, HIGH_PCT])
    floor_, ceil_ = dim.values
    if dim.kind == "int":
        lo, hi = math.floor(lo), math.ceil(hi)
    else:
        lo, hi = round(float(lo), 4), round(float(hi), 4)
    return [max(floor_, lo), min(ceil_, hi)]


def frequent(values: list[Any], order: tuple) -> list[Any]:
    """The choices held by at least MIN_VALUE_SHARE of `values`, in `order`."""
    keyed = [json.dumps(v) for v in values]
    return [
        v
        for v in order
        if keyed.count(json.dumps(list(v) if isinstance(v, tuple) else v))
        >= MIN_VALUE_SHARE * len(values)
    ]


def derive(space: sr.Space, kept: list[dict[str, Any]]) -> dict[str, Any]:
    """Steps 3 to 5: the focused heavy and light blocks and the runs per heavy combination."""
    light: dict[str, Any] = {}
    for dim in space.light:
        if dim.name == "rebalance_offset_raw":
            light[dim.name] = (dim.kind, list(dim.values))
            continue
        values = [axis_value(dim, r["light"]) for r in kept if _has(dim, r["light"])]
        if dim.kind == "choice":
            light[dim.name] = ("choice", frequent(values, dim.values))
        else:
            light[dim.name] = (dim.kind, numeric_range(dim, values))
    heavy = {
        dim.name: frequent([r["heavy"][dim.name] for r in kept], dim.values) for dim in space.heavy
    }
    focus = sr.Space(space.name, space.arm, space.fixed, _dims(heavy), (), None)
    combos = len(sr.heavy_combinations(focus, 10**6, SEED))
    per = min(LIGHT_MAX, max(LIGHT_MIN, math.ceil(TARGET_RUNS / combos)))
    return {"heavy": heavy, "light": light, "combos": combos, "light_per": per}


def _has(dim: sr.Dim, light: dict[str, Any]) -> bool:
    if dim.name in BANDS:
        return all(k in light for k in BANDS[dim.name])
    return dim.name in light


def _dims(heavy: dict[str, list]) -> tuple[sr.Dim, ...]:
    return tuple(
        sr.Dim(name, "choice", tuple(tuple(v) if isinstance(v, list) else v for v in values))
        for name, values in heavy.items()
    )


def toml_value(value: Any) -> str:
    if value is None:
        return '"none"'
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list | tuple):
        return "[" + ", ".join(toml_value(v) for v in value) + "]"
    return repr(value)


def render(space: sr.Space, focus: dict[str, Any], *, name: str, source: Path, out: Path) -> str:
    cmd = (
        f"uv run mbt search run {out} --heavy {focus['combos']} --light {focus['light_per']} "
        f"--seed {SEED} --workers {3 if space.arm == 'C1' else 4}"
    )
    lines = [
        f"# BL-176 Stage 2 (focused), derived by scripts/bl176_focus.py from {source}",
        f"# (Stage 1 space {space.name}). Written by rule, never by hand: see the script's",
        "# docstring and BL-176 Phase 0. Never edited after a run starts.",
        f"#   {cmd}",
        '# TOML has no null: the string "none" means None.',
        f'name = "{name}"',
        f'arm = "{space.arm}"',
        "",
        "[fixed]",
        *(f"{k} = {toml_value(v)}" for k, v in space.fixed.items()),
        "",
        "[heavy]",
        *(f"{k} = {{ choice = {toml_value(v)} }}" for k, v in focus["heavy"].items()),
        "",
        "[light]",
        *(f"{k} = {{ {kind} = {toml_value(v)} }}" for k, (kind, v) in focus["light"].items()),
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("results", type=Path, help="The arm's Stage 1 results folder.")
    parser.add_argument("--space", type=Path, required=True, help="Its Stage 1 space file.")
    parser.add_argument("--out", type=Path, required=True, help="The focus space to write.")
    args = parser.parse_args(argv)

    space = sr.load_space(args.space)
    rows = load_rows(args.results)
    if not rows:
        print(f"no run in {args.results} carries a rank measure: not a Stage 1 result to rank")
        return 2
    kept, report = pool(rows, list(criteria.load()["baskets"]))
    print(f"{len(rows)} Stage 1 runs with rank measures; kept per basket: {report}")
    if not kept:
        print(f"no basket keeps {MIN_KEPT} runs: {space.name} gets no Stage 2")
        return 0
    focus = derive(space, kept)
    name = f"{space.name}_focus"
    args.out.write_text(render(space, focus, name=name, source=args.results, out=args.out))
    sr.load_space(args.out)  # the file must load as written
    print(
        f"wrote {args.out}: {focus['combos']} heavy combinations x {focus['light_per']} = "
        f"{focus['combos'] * focus['light_per']} runs at most (feasibility drops some)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
