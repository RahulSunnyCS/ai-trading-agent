"""BL-202 scoring: the registered gates, the block-bootstrap lower bound, the plateau rule and the
per-cohort tables, each half of the window scored on its own.

Reads `results/<tag>/series/<cohort>.npy` (day x cell net after slippage and charges), its
`.aux.npz` (day-stop flags, winning and losing trade sums, charges) and `.json` (labels, days),
plus `parts/<cohort>.csv` for the whole-window fields the series cannot give (hold minutes, exits
by cause, orders a day). Every figure that gates or ranks a cell is computed from the series of
ONE half, split at `grid.FIT_TO` (backlog/BL-202 Phase 0):

  gates     days >= 95 % of the half's sessions; entry on >= 40 % of them (a day with no trade
            has a net of exactly 0: brokerage makes any traded day non-zero); net > 0; profit
            factor >= 1.05; day-stop days <= 60 %; the five worst days together >= -15,000
  ranking   the lower bound of the 90 % block-bootstrap interval of rupees a lot-day (5-day
            circular blocks, 2,000 resamples, seed 20261103), tie-break the Martin ratio
            (annualised net over the Ulcer index floored at one rupee)
  plateau   robust = min(own lower bound, median lower bound of the +-1-step neighbours along
            each axis chain, `grid.CHAINS`); a candidate passes its own gates and at least half
            of its neighbours pass

The resamples are the same for every cell of a cohort (one index matrix a half), so the lower
bound of (cell - template) is the lower bound of the paired difference, which rule (2) of the
pass rule reads.

The fit half is the only one Stage 1 and Stage 2 read. `--half test` scores only the cells of a
committed list (`--only finalists.json`, Stage 3), never the whole grid: the test half is scored
once, after the finalists are named.

    uv run python research/bl202/score.py --tag stage1                 # fit half, every cell
    uv run python research/bl202/score.py --tag stage3 --half test --only results/stage2/finalists.json

Writes, under `results/<tag>/`: `B_ranked_<half>.csv` (every cell with its gate verdicts,
neighbourhood and robust score), `B_cohorts_<half>.csv` (one line a cohort) and
`band_tables_<half>.md` (per cohort: the template, the top cells, the best set per strike and
the median lower bound per axis value).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

RESULTS = HERE / "results"
TRADING_DAYS_PER_YEAR = 252

GATES = {
    "coverage": 0.95,
    "entry_hit_rate": 0.40,
    "profit_factor": 1.05,
    "stop_frequency": 0.60,
    "worst5_inr": -15_000.0,
}
BOOTSTRAP = {"block": 5, "resamples": 2_000, "seed": 20261103, "level": 0.90}
BIG = 1e9
TOP_N = 10
HALVES = ("fit", "test", "all")

Key = tuple[tuple[str, Any], ...]


# --- loading --------------------------------------------------------------------------------


def load_cohort(out_dir: Path, cohort: str) -> dict[str, Any]:
    meta = json.loads((out_dir / "series" / f"{cohort}.json").read_text())
    net = np.load(out_dir / "series" / f"{cohort}.npy").astype(np.float64)
    aux = dict(np.load(out_dir / "series" / f"{cohort}.aux.npz"))
    with (out_dir / "parts" / f"{cohort}.csv").open(newline="") as handle:
        parts = {r["label"]: r for r in csv.DictReader(handle)}
    days = np.array(meta["days"], dtype="datetime64[D]")
    skipped_days = [k for k in meta["skipped"] if not k.startswith("cell:")]
    return {
        "cohort": cohort,
        "labels": meta["labels"],
        "days": days,
        "skipped_days": np.array(skipped_days, dtype="datetime64[D]"),
        "net": net,
        "aux": {k: v.astype(np.float64) for k, v in aux.items()},
        "parts": parts,
        "run": meta.get("run"),
    }


def half_mask(days: np.ndarray, half: str) -> np.ndarray:
    cut = np.datetime64(grid.FIT_TO)
    if half == "fit":
        return days <= cut
    if half == "test":
        return days > cut
    return np.ones(len(days), dtype=bool)


# --- vectorised statistics (days x cells) ----------------------------------------------------


def drawdown_stats(net: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(max drawdown <= 0, Ulcer index) per cell, equity starting at 0 as run_grid's do."""
    equity = np.cumsum(net, axis=0)
    peak = np.maximum.accumulate(np.maximum(equity, 0.0), axis=0)
    under = np.minimum(equity - peak, 0.0)
    return under.min(axis=0), np.sqrt((under**2).mean(axis=0))


def block_starts(n_days: int) -> np.ndarray:
    """The resample index matrix (resamples x days): how many times each day is drawn, with
    5-day circular blocks. Shared by every cell of a half so the resamples are paired."""
    block, resamples = BOOTSTRAP["block"], BOOTSTRAP["resamples"]
    rng = np.random.default_rng(BOOTSTRAP["seed"])
    n_blocks = math.ceil(n_days / block)
    starts = rng.integers(0, n_days, size=(resamples, n_blocks))
    counts = np.zeros((resamples, n_days), dtype=np.float64)
    for k in range(block):
        idx = (starts + k) % n_days
        np.add.at(counts, (np.arange(resamples)[:, None], idx), 1.0)
    return counts


def bootstrap_means(net: np.ndarray, counts: np.ndarray) -> np.ndarray:
    """Resample means of rupees a lot-day (resamples x cells)."""
    return (counts @ net) / counts[0].sum()


def lower_bound(means: np.ndarray) -> np.ndarray:
    return np.percentile(means, 100 * (1 - BOOTSTRAP["level"]) / 2, axis=0)


def half_stats(data: dict[str, Any], half: str) -> dict[str, np.ndarray]:
    mask = half_mask(data["days"], half)
    net = data["net"][mask]
    aux = {k: v[mask] for k, v in data["aux"].items()}
    n = int(mask.sum())
    sessions = n + int(half_mask(data["skipped_days"], half).sum()) if n else 0
    if n == 0:
        raise SystemExit(f"{data['cohort']}: no days in the {half} half")
    total = net.sum(axis=0)
    annual = total / n * TRADING_DAYS_PER_YEAR
    dd, ulcer = drawdown_stats(net)
    win_sum = aux["win_sum"].sum(axis=0)
    loss_sum = aux["loss_sum"].sum(axis=0)
    with np.errstate(divide="ignore", invalid="ignore"):
        profit_factor = np.where(loss_sum < 0, win_sum / np.abs(loss_sum), np.inf)
    counts = block_starts(n)
    means = bootstrap_means(net, counts)
    return {
        "n_days": np.full(net.shape[1], n),
        "sessions": np.full(net.shape[1], sessions),
        "net_inr": total,
        "avg_day_inr": total / n,
        "lb_day_inr": lower_bound(means),
        "median_day_inr": np.median(net, axis=0),
        "win_rate": (net > 0).mean(axis=0),
        "entry_hit_rate": (net != 0).mean(axis=0),
        "worst_day_inr": net.min(axis=0),
        "worst5_inr": np.sort(net, axis=0)[:5].sum(axis=0),
        "max_drawdown_inr": dd,
        "ulcer_inr": ulcer,
        "martin": annual / np.maximum(1.0, ulcer),
        "profit_factor": profit_factor,
        "stop_frequency": aux["stopped"].mean(axis=0),
        "charges_per_day_inr": aux["charges"].sum(axis=0) / n,
        "_means": means,
    }


# --- gates, plateau, ranking ------------------------------------------------------------------


def failed_gates(r: dict[str, Any]) -> list[str]:
    out = []
    if r["n_days"] < GATES["coverage"] * r["sessions"]:
        out.append("coverage")
    if not r["entry_hit_rate"] >= GATES["entry_hit_rate"]:
        out.append("entry_hit_rate")
    if not r["net_inr"] > 0:
        out.append("net")
    if not r["profit_factor"] >= GATES["profit_factor"]:
        out.append("profit_factor")
    if not r["stop_frequency"] <= GATES["stop_frequency"]:
        out.append("stop_frequency")
    if not r["worst5_inr"] >= GATES["worst5_inr"]:
        out.append("worst5")
    return out


def key_of(params: dict[str, Any]) -> Key:
    return tuple((axis, value) for axis, value in params.items())


def neighbour_keys(params: dict[str, Any]) -> list[Key]:
    """The +-1-step neighbours along each axis chain; only cells that exist in the cohort are
    later counted."""
    out: list[Key] = []
    for axis, chains in grid.CHAINS.items():
        value = params[axis]
        for chain in chains:
            if value not in chain:
                continue
            i = chain.index(value)
            for j in (i - 1, i + 1):
                if 0 <= j < len(chain):
                    out.append(key_of({**params, axis: chain[j]}))
    return list(dict.fromkeys(out))


WHOLE_WINDOW = (
    "avg_hold_minutes",
    "orders_per_day",
    "payoff_ratio",
    "trade_win_rate",
    "exit_sl_count",
    "exit_target_count",
    "exit_overall_sl_count",
    "exit_exit_time_count",
    "exit_square_off_count",
    "exit_trail_count",
    "premium_outlay_avg_inr",
)


def fnum(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def score_cohort(data: dict[str, Any], half: str) -> list[dict[str, Any]]:
    stats = half_stats(data, half)
    means = stats.pop("_means")
    labels = data["labels"]
    template_i = next(
        (i for i, lab in enumerate(labels) if lab.endswith(f"_{grid.TEMPLATE}")), None
    )
    lb_vs_template = lower_bound(means - means[:, [template_i]]) if template_i is not None else None
    rows: list[dict[str, Any]] = []
    for i, label in enumerate(labels):
        part = data["parts"][label]
        params = grid.params_from_row(part)
        row: dict[str, Any] = {
            "cohort": data["cohort"],
            "index": part["index"],
            "underlying": part["underlying"],
            "slot": part["slot"],
            "band": part["band"],
            "label": label,
            "half": half,
            **grid.params_to_row(params),
            "premium_inr": part["premium_inr"],
            "slippage_pct": part["slippage_pct"],
            **{k: float(v[i]) for k, v in stats.items()},
            "lb_vs_template_inr": float(lb_vs_template[i])
            if lb_vs_template is not None
            else float("nan"),
            **{f"ww_{k}": fnum(part[k]) for k in WHOLE_WINDOW},
        }
        row["params"] = params
        row["key"] = None if params is None else key_of(params)
        failed = failed_gates(row)
        row["gates_failed"] = ";".join(failed)
        row["passes"] = not failed
        rows.append(row)
    by_key = {r["key"]: r for r in rows if r["key"] is not None}
    for r in rows:
        if r["key"] is None:
            r["n_neighbours"] = 0
            r["neighbours_passing"] = 0
            r["neighbour_median_lb_inr"] = float("nan")
            r["candidate"] = r["passes"]
            r["robust"] = r["lb_day_inr"] if r["passes"] else -BIG
            continue
        neighbours = [by_key[k] for k in neighbour_keys(r["params"]) if k in by_key]
        passing = sum(n["passes"] for n in neighbours)
        median = (
            statistics.median(n["lb_day_inr"] for n in neighbours)
            if neighbours
            else r["lb_day_inr"]
        )
        r["n_neighbours"] = len(neighbours)
        r["neighbours_passing"] = passing
        r["neighbour_median_lb_inr"] = median
        r["candidate"] = bool(r["passes"] and (not neighbours or passing * 2 >= len(neighbours)))
        r["robust"] = min(r["lb_day_inr"], median) if r["candidate"] else -BIG
    ranked = sorted(rows, key=lambda r: (-r["robust"], -finite(r["martin"]), -r["lb_day_inr"]))
    for position, r in enumerate(ranked, 1):
        r["cohort_rank"] = position
    return rows


def finite(value: float) -> float:
    if math.isnan(value):
        return -BIG
    return max(-BIG, min(BIG, value))


# --- tables -----------------------------------------------------------------------------------


def fmt(value: Any, digits: int = 0) -> str:
    if isinstance(value, float):
        if math.isnan(value) or value <= -BIG:  # -BIG: no robust score (not a candidate)
            return "—"
        if value >= BIG:
            return "∞"
        return f"{value:,.{digits}f}"
    return str(value)


def cell_values(r: dict[str, Any]) -> list[str]:
    axes = list(grid.AXES)
    if r["key"] is None:
        return ["template"] * len(axes)
    params = dict(r["key"])
    return [grid.pretty(a, params[a]) for a in axes]


def table(header: list[str], rows: list[list[str]]) -> list[str]:
    return [
        "| " + " | ".join(header) + " |",
        "|" + "---|" * len(header),
        *("| " + " | ".join(cells) + " |" for cells in rows),
    ]


def stat_cells(r: dict[str, Any]) -> list[str]:
    return [
        "yes" if r["candidate"] else ("gates" if r["passes"] else r["gates_failed"]),
        fmt(r["robust"]),
        fmt(r["lb_day_inr"]),
        fmt(r["avg_day_inr"]),
        fmt(r["lb_vs_template_inr"]),
        fmt(r["median_day_inr"]),
        fmt(r["win_rate"] * 100),
        fmt(r["entry_hit_rate"] * 100),
        fmt(r["worst_day_inr"]),
        fmt(r["worst5_inr"]),
        fmt(r["max_drawdown_inr"]),
        fmt(r["ulcer_inr"]),
        fmt(r["martin"], 1),
        fmt(r["profit_factor"], 2),
        fmt(r["stop_frequency"] * 100),
        fmt(r["ww_avg_hold_minutes"]),
    ]


STAT_HEADER = [
    "cand",
    "robust",
    "LB ₹/day",
    "₹/day",
    "LB vs tmpl",
    "median",
    "win %",
    "entry %",
    "worst day",
    "worst 5",
    "maxDD",
    "Ulcer",
    "Martin",
    "PF",
    "stop %",
    "hold min",
]


def axis_marginals(rows: list[dict[str, Any]]) -> list[list[str]]:
    """Median lower bound and share of gate passes per axis value, over the cohort's grid cells."""
    out = []
    grid_rows = [r for r in rows if r["key"] is not None]
    for axis, values in grid.AXES.items():
        for value in values:
            members = [r for r in grid_rows if dict(r["key"])[axis] == value]
            if not members:
                continue
            out.append(
                [
                    axis,
                    grid.pretty(axis, value),
                    str(len(members)),
                    fmt(statistics.median(r["lb_day_inr"] for r in members)),
                    fmt(statistics.median(r["avg_day_inr"] for r in members)),
                    fmt(100 * statistics.fmean(r["passes"] for r in members)),
                    fmt(100 * statistics.fmean(r["candidate"] for r in members)),
                    fmt(max(r["lb_day_inr"] for r in members)),
                ]
            )
    return out


def render_cohort(rows: list[dict[str, Any]], half: str) -> tuple[str, dict[str, Any]]:
    first = rows[0]
    ranked = sorted(rows, key=lambda r: r["cohort_rank"])
    template = next((r for r in rows if r["key"] is None), None)
    n_pass = sum(r["passes"] for r in rows)
    n_cand = sum(r["candidate"] for r in rows)
    best = ranked[0]
    lines = [
        f"### {first['underlying']} {first['slot']} (band {first['band']}, cohort "
        f"{first['cohort']}) — {half} half, {int(first['n_days'])} days",
        "",
        f"{len(rows)} cells: {n_pass} pass the gates, {n_cand} candidates (gates + plateau). "
        + (
            f"Template: {fmt(template['avg_day_inr'])} ₹/lot-day, lower bound "
            f"{fmt(template['lb_day_inr'])}, gates {template['gates_failed'] or 'pass'}."
            if template
            else "No template cell."
        ),
        "",
    ]
    header = ["rank", *grid.AXES, *STAT_HEADER]
    body = [[str(r["cohort_rank"]), *cell_values(r), *stat_cells(r)] for r in ranked[:TOP_N]]
    if template and template["cohort_rank"] > TOP_N:
        body.append([str(template["cohort_rank"]), *cell_values(template), *stat_cells(template)])
    lines += table(header, body)
    lines += ["", "Best set per strike (by robust score, then lower bound):", ""]
    by_strike: dict[str, dict[str, Any]] = {}
    for r in ranked:
        if r["key"] is not None:
            by_strike.setdefault(dict(r["key"])["strike"], r)
    lines += table(
        header,
        [
            [str(r["cohort_rank"]), *cell_values(r), *stat_cells(r)]
            for _, r in sorted(by_strike.items(), key=lambda kv: grid.AXES["strike"].index(kv[0]))
        ],
    )
    lines += ["", "Per axis value (median over the cohort's cells holding it):", ""]
    lines += table(
        ["axis", "value", "cells", "median LB", "median ₹/day", "pass %", "cand %", "best LB"],
        axis_marginals(rows),
    )
    lines.append("")
    summary = {
        "cohort": first["cohort"],
        "underlying": first["underlying"],
        "slot": first["slot"],
        "band": first["band"],
        "half": half,
        "n_days": int(first["n_days"]),
        "cells": len(rows),
        "passing": n_pass,
        "candidates": n_cand,
        "template_avg_day_inr": template["avg_day_inr"] if template else float("nan"),
        "template_lb_day_inr": template["lb_day_inr"] if template else float("nan"),
        "template_gates": (template["gates_failed"] or "pass") if template else "",
        "best_label": best["label"],
        "best_robust": best["robust"],
        "best_lb_day_inr": best["lb_day_inr"],
        "best_avg_day_inr": best["avg_day_inr"],
        "best_lb_vs_template_inr": best["lb_vs_template_inr"],
        "best_candidate": best["candidate"],
    }
    return "\n".join(lines), summary


def write_csv(
    path: Path, rows: list[dict[str, Any]], drop: tuple[str, ...] = ("params", "key")
) -> None:
    if not rows:
        return
    fields = [c for c in rows[0] if c not in drop]
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def overview(summaries: list[dict[str, Any]]) -> list[str]:
    header = [
        "cohort",
        "days",
        "cells",
        "pass",
        "cand",
        "template ₹/day",
        "template LB",
        "template gates",
        "best robust",
        "best LB",
        "best ₹/day",
        "best LB vs tmpl",
        "best cand",
    ]
    body = [
        [
            s["cohort"],
            str(s["n_days"]),
            str(s["cells"]),
            str(s["passing"]),
            str(s["candidates"]),
            fmt(s["template_avg_day_inr"]),
            fmt(s["template_lb_day_inr"]),
            s["template_gates"],
            fmt(s["best_robust"]),
            fmt(s["best_lb_day_inr"]),
            fmt(s["best_avg_day_inr"]),
            fmt(s["best_lb_vs_template_inr"]),
            "yes" if s["best_candidate"] else "no",
        ]
        for s in summaries
    ]
    return table(header, body)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--tag", default="stage1")
    parser.add_argument("--half", choices=HALVES, default="fit")
    parser.add_argument(
        "--only",
        type=Path,
        help="JSON list of labels (or of {label} objects) to score; required for --half test",
    )
    args = parser.parse_args()
    if args.half == "test" and not args.only:
        raise SystemExit(
            "the test half is scored only for a committed list of finalists (--only); "
            "backlog/BL-202 Phase 0"
        )
    only: set[str] | None = None
    if args.only:
        items = json.loads(args.only.read_text())
        only = {it["label"] if isinstance(it, dict) else it for it in items}
    out_dir = RESULTS / args.tag
    cohorts = sorted(p.stem for p in (out_dir / "parts").glob("*.csv"))
    if not cohorts:
        raise SystemExit(f"no parts under {out_dir}")
    all_rows: list[dict[str, Any]] = []
    texts: list[str] = []
    summaries: list[dict[str, Any]] = []
    for cohort in cohorts:
        data = load_cohort(out_dir, cohort)
        rows = score_cohort(data, args.half)
        if only is not None:
            rows = [r for r in rows if r["label"] in only]
            if not rows:
                continue
        text, summary = render_cohort(rows, args.half)
        texts.append(text)
        summaries.append(summary)
        all_rows.extend(sorted(rows, key=lambda r: r["cohort_rank"]))
        print(
            f"{cohort}: {len(rows)} cells, {summary['passing']} pass, {summary['candidates']} "
            f"candidates; best {summary['best_label']} robust {fmt(summary['best_robust'])}",
            flush=True,
        )
    suffix = args.half
    write_csv(out_dir / f"{grid.FAMILY}_ranked_{suffix}.csv", all_rows)
    write_csv(out_dir / f"{grid.FAMILY}_cohorts_{suffix}.csv", summaries)
    head = [
        f"## BL-202 Buy grid — {out_dir.name}, {args.half} half "
        f"({'to ' + grid.FIT_TO if args.half == 'fit' else 'after ' + grid.FIT_TO if args.half == 'test' else 'whole window'}), "
        f"grid {grid.grid_sha()}, slippage {grid.SLIPPAGE_PCT} %",
        "",
        "Ranking: robust = min(own 90 % block-bootstrap lower bound of ₹ a lot-day, the median "
        "lower bound of the ±1-step neighbours); gates on this half: entry ≥ 40 % of days, net > 0, "
        "PF ≥ 1.05, day-stop days ≤ 60 %, worst five days ≥ −₹15,000. `hold min` is whole-window.",
        "",
        *overview(summaries),
        "",
    ]
    path = out_dir / f"band_tables_{suffix}.md"
    path.write_text("\n".join(head) + "\n" + "\n\n".join(texts) + "\n")
    print(f"wrote {path}", flush=True)


if __name__ == "__main__":
    main()
