"""BL-104 scoring: gates, Martin / Calmar, the plateau rule and the per-band tables.

Reads `results/<tag>/<family>_summary.csv` (run_grid.py) and writes, next to it,
`<family>_ranked.csv` (every cell with its gate verdicts, neighbours and robust score),
`<family>_band_winners.csv` (the top parameter sets per index x band) and `band_tables.md`.

The registered rules (backlog/BL-104 Phase 0):
  gates      n_days >= 95 % of the cohort's sessions; net > 0; Calmar >= 1; profit factor >= 1.05;
             MTM-stop frequency <= 30 %; Buy: entry hit rate >= 40 %
  ranking    Martin ratio (annualised net / Ulcer), tie-break rupees per lot-day
  plateau    robust = min(own Martin, median Martin of the +-1-step neighbours along each axis
             chain); a candidate passes its own gates and at least half of its neighbours pass
             (Phase 0 as superseded on 2026-10-15; the first wording is in the item's Log)
  band       one parameter set per family x index x band: the set with the best robust score
             averaged over the band's slots, candidate at every slot

    uv run python research/bl104/score.py --tag stage1 [--family W]
"""

from __future__ import annotations

import argparse
import csv
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
GATES = {
    "coverage": 0.95,
    "calmar": 1.0,
    "profit_factor": 1.05,
    "mtm_stop_frequency": 0.30,
    "entry_hit_rate": 0.40,  # Buy only
}
# Tail gate (owner, 2026-10-15; backlog/BL-104 Log): a cell may not have a worst day, or a sum of
# its five worst days, more than 1.5x its cohort template's, with the template's magnitude floored
# so a template with almost no tail (Buy) does not cap everything at a few hundred rupees.
TAIL = {"ratio": 1.5, "worst_day_floor_inr": 3000.0, "worst5_floor_inr": 15000.0}
# Per-family day-stop-rate cap; the registered BL-104 value is 30 % for every family. BL-106 runs
# with --buy-stop-cap 0.6 (the owner's 2026-10-15 loosening for Buy, a long-premium strategy).
STOP_CAP: dict[str, float] = {}
BIG = 1e9  # an infinite ratio (no drawdown at all) ranks above every finite one
TOP_N = 10

Key = tuple[tuple[str, Any], ...]


def fnum(value: str) -> float:
    if value in ("", "None"):
        return float("nan")
    try:
        return float(value)
    except ValueError:
        return float("nan")


def finite(value: float) -> float:
    if math.isnan(value):
        return -BIG
    return max(-BIG, min(BIG, value))


def ratio_or_nan(a: float, b: float) -> float:
    return a / b if b else float("nan")


def martin_floored(row: dict[str, Any]) -> float:
    """Annualised net over the Ulcer index with the Ulcer floored at one rupee: a cell that never
    fell below its peak is very good, not infinitely good (it would otherwise pull every
    neighbour's median up)."""
    if math.isnan(row["ulcer_index_inr"]) or math.isnan(row["annual_net_inr"]):
        return float("nan")
    return row["annual_net_inr"] / max(1.0, row["ulcer_index_inr"])


def key_of(params: dict[str, Any]) -> Key:
    return tuple((axis, value) for axis, value in params.items())


def failed_gates(row: dict[str, Any], sessions: int) -> list[str]:
    out = []
    if row["n_days"] < GATES["coverage"] * sessions:
        out.append("coverage")
    if row["family"] in ("W", "D") and not row["entry_hit_rate"] >= GATES["coverage"]:
        out.append(
            "coverage"
        )  # a premium strike with no contract that day is a 0 day, not a result
    if not row["net_inr"] > 0:
        out.append("net")
    if not row["calmar"] >= GATES["calmar"]:
        out.append("calmar")
    if not row["profit_factor"] >= GATES["profit_factor"]:
        out.append("profit_factor")
    if not row["mtm_stop_frequency"] <= STOP_CAP.get(row["family"], GATES["mtm_stop_frequency"]):
        out.append("mtm_stop_frequency")
    if row["family"] == "B" and not row["entry_hit_rate"] >= GATES["entry_hit_rate"]:
        out.append("entry_hit_rate")
    return out


def neighbour_keys(family: str, params: dict[str, Any]) -> list[Key]:
    """The +-1-step neighbours along each axis chain (grid.CHAINS); only cells that exist in the
    cohort are later counted, so an excluded combination is simply not a neighbour."""
    out: list[Key] = []
    for axis, chains in grid.CHAINS[family].items():
        value = params[axis]
        for chain in chains:
            if value not in chain:
                continue
            i = chain.index(value)
            for j in (i - 1, i + 1):
                if 0 <= j < len(chain):
                    out.append(key_of({**params, axis: chain[j]}))
    return list(dict.fromkeys(out))


def load_summary(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(newline="") as handle:
        for raw in csv.DictReader(handle):
            row: dict[str, Any] = dict(raw)
            for column, value in raw.items():
                if column.startswith("p_") or column in (
                    "cohort",
                    "family",
                    "index",
                    "underlying",
                    "slot",
                    "band",
                    "label",
                    "cell",
                    "lot_sizing",
                    "grid_version",
                    "dd_recovered",
                ):
                    continue
                row[column] = fnum(value)
            row["params"] = grid.params_from_row(row["family"], raw)
            row["key"] = None if row["params"] is None else key_of(row["params"])
            rows.append(row)
    return rows


def tail_failures(row: dict[str, Any], template: dict[str, Any] | None) -> list[str]:
    if template is None or row["key"] is None:
        return []
    cap_day = TAIL["ratio"] * max(abs(template["worst_day_inr"]), TAIL["worst_day_floor_inr"])
    cap_5 = TAIL["ratio"] * max(abs(template["worst5_inr"]), TAIL["worst5_floor_inr"])
    out = []
    if row["worst_day_inr"] < -cap_day:
        out.append("tail_worst_day")
    if row["worst5_inr"] < -cap_5:
        out.append("tail_worst5")
    return out


def attach_worst5(out_dir: Path, cohort: str, rows: list[dict[str, Any]]) -> None:
    """Sum of each cell's five worst days, from the stored day x cell series."""
    import json

    import numpy as np

    matrix = np.load(out_dir / "series" / f"{cohort}.npy").astype(float)
    labels = json.loads((out_dir / "series" / f"{cohort}.json").read_text())["labels"]
    index = {label: i for i, label in enumerate(labels)}
    worst5 = np.sort(matrix, axis=0)[:5].sum(axis=0)
    for r in rows:
        r["worst5_inr"] = float(worst5[index[r["label"]]])


def score_cohort(rows: list[dict[str, Any]], tail: bool = False) -> None:
    """Adds gate / neighbour / robust columns in place for one cohort's rows."""
    family = rows[0]["family"]
    sessions = int(max(r["n_days"] for r in rows))
    by_key = {r["key"]: r for r in rows if r["key"] is not None}
    template = next((r for r in rows if r["key"] is None), None)
    for r in rows:
        r["sessions"] = sessions
        failed = failed_gates(r, sessions)
        if tail:
            failed += tail_failures(r, template)
        r["gates_failed"] = ";".join(failed)
        r["passes"] = r["gates_failed"] == ""
        r["martin_f"] = finite(martin_floored(r))
        r["tail_ratio_worst"] = ratio_or_nan(r["worst_day_inr"], r["avg_day_inr"])
        r["tail_ratio_cvar"] = ratio_or_nan(r["cvar95_day_inr"], r["avg_day_inr"])
    for r in rows:
        if r["key"] is None:  # the template: scored as itself, no neighbourhood
            r["n_neighbours"] = 0
            r["neighbours_passing"] = 0
            r["neighbour_median_martin"] = float("nan")
            r["candidate"] = r["passes"]
            r["robust"] = r["martin_f"] if r["passes"] else -BIG
            continue
        neighbours = [by_key[k] for k in neighbour_keys(family, r["params"]) if k in by_key]
        passing = sum(n["passes"] for n in neighbours)
        median = (
            statistics.median(n["martin_f"] for n in neighbours) if neighbours else r["martin_f"]
        )
        r["n_neighbours"] = len(neighbours)
        r["neighbours_passing"] = passing
        r["neighbour_median_martin"] = median
        r["candidate"] = bool(r["passes"] and (not neighbours or passing * 2 >= len(neighbours)))
        r["robust"] = min(r["martin_f"], median) if r["candidate"] else -BIG
    ranked = sorted(rows, key=lambda r: (-r["robust"], -r["avg_day_inr"]))
    for position, r in enumerate(ranked, 1):
        r["cohort_rank"] = position


def band_winners(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One table per index x band: parameter sets present at every slot of the band, with the
    mean robust score, mean rupees per lot-day and the template's for comparison."""
    out: list[dict[str, Any]] = []
    family = rows[0]["family"]
    groups: dict[tuple[str, str], dict[Key | None, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for r in rows:
        groups[(r["index"], r["band"])][r["key"]].append(r)
    for (index, band_), sets in sorted(groups.items()):
        slots = sorted({r["slot"] for members in sets.values() for r in members})
        template = sets.get(None, [])
        template_avg = (
            statistics.fmean(r["avg_day_inr"] for r in template) if template else float("nan")
        )
        template_dd = (
            statistics.fmean(r["max_drawdown_inr"] for r in template) if template else float("nan")
        )
        template_ulcer = (
            statistics.fmean(r["ulcer_index_inr"] for r in template) if template else float("nan")
        )
        scored = []
        for key, members in sets.items():
            if len(members) < len(slots):
                continue
            scored.append(
                {
                    "family": family,
                    "index": index,
                    "band": band_,
                    "slots": ",".join(slots),
                    **grid.params_to_row(family, None if key is None else dict(key)),
                    "key": key,
                    "is_template": key is None,
                    "label_at_first_slot": members[0]["label"],
                    "band_candidate": all(m["candidate"] for m in members),
                    "slots_candidate": sum(m["candidate"] for m in members),
                    "band_robust": statistics.fmean(
                        m["robust"] if m["candidate"] else m["martin_f"] for m in members
                    ),
                    "mean_martin": statistics.fmean(m["martin_f"] for m in members),
                    "mean_calmar": statistics.fmean(finite(m["calmar"]) for m in members),
                    "mean_avg_day_inr": statistics.fmean(m["avg_day_inr"] for m in members),
                    "mean_max_drawdown_inr": statistics.fmean(
                        m["max_drawdown_inr"] for m in members
                    ),
                    "mean_ulcer_inr": statistics.fmean(m["ulcer_index_inr"] for m in members),
                    "mean_win_rate": statistics.fmean(m["win_rate"] for m in members),
                    "mean_profit_factor": statistics.fmean(
                        finite(m["profit_factor"]) for m in members
                    ),
                    "mean_mtm_stop_frequency": statistics.fmean(
                        m["mtm_stop_frequency"] for m in members
                    ),
                    "mean_return_on_capital_pct": statistics.fmean(
                        m["return_on_capital_pct"] for m in members
                    ),
                    "template_avg_day_inr": template_avg,
                    "delta_vs_template_inr": statistics.fmean(m["avg_day_inr"] for m in members)
                    - template_avg,
                    "dd_vs_template_pct": (
                        statistics.fmean(m["max_drawdown_inr"] for m in members) / template_dd - 1
                    )
                    * 100
                    if template_dd
                    else float("nan"),
                    "ulcer_vs_template_pct": (
                        statistics.fmean(m["ulcer_index_inr"] for m in members) / template_ulcer - 1
                    )
                    * 100
                    if template_ulcer
                    else float("nan"),
                }
            )
        scored.sort(
            key=lambda s: (not s["band_candidate"], -s["band_robust"], -s["mean_avg_day_inr"])
        )
        for position, s in enumerate(scored, 1):
            s["band_rank"] = position
        out.extend(scored)
    return out


def strike_table(winners: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The best (band-candidate first) parameter set per strike, per index x band."""
    best: dict[tuple[str, str, str], dict[str, Any]] = {}
    for w in winners:  # already sorted best-first within each index x band
        k = (w["index"], w["band"], w["p_strike"])
        best.setdefault(k, w)
    return [best[k] for k in sorted(best)]


def fmt(value: Any, digits: int = 0) -> str:
    if isinstance(value, float):
        if math.isnan(value):
            return "—"
        if abs(value) >= BIG:
            return "∞"
        return f"{value:,.{digits}f}"
    return str(value)


def render_markdown(
    family: str, winners: list[dict[str, Any]], strikes: list[dict[str, Any]], tag: str
) -> str:
    lines = [f"## {grid.FAMILY_NAME[family]} ({family}) — {tag}", ""]
    axes = list(grid.AXES[family])
    for index, band_ in sorted({(w["index"], w["band"]) for w in winners}):
        rows = [w for w in winners if w["index"] == index and w["band"] == band_]
        lines.append(f"### {grid.INDICES[index]} band {band_} (slots {rows[0]['slots']})")
        lines.append("")
        lines.append(
            f"Template: {fmt(rows[0]['template_avg_day_inr'])} ₹/lot-day. "
            f"{sum(r['band_candidate'] for r in rows)} band candidates of {len(rows)} sets."
        )
        lines.append("")
        header = [
            "rank",
            *axes,
            "cand",
            "robust",
            "Martin",
            "Calmar",
            "₹/day",
            "Δ vs tmpl",
            "maxDD",
            "DD vs tmpl %",
            "Ulcer",
            "win %",
            "PF",
            "MTM stop %",
        ]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "---|" * len(header))
        for r in rows[:TOP_N]:
            cells = [str(r["band_rank"])]
            cells += [
                grid.pretty(a, dict(r["key"])[a]) if r.get("key") else "template" for a in axes
            ]
            cells += [
                "yes"
                if r["band_candidate"]
                else f"{r['slots_candidate']}/{len(r['slots'].split(','))}",
                fmt(r["band_robust"], 1),
                fmt(r["mean_martin"], 1),
                fmt(r["mean_calmar"], 2),
                fmt(r["mean_avg_day_inr"]),
                fmt(r["delta_vs_template_inr"]),
                fmt(r["mean_max_drawdown_inr"]),
                fmt(r["dd_vs_template_pct"], 0),
                fmt(r["mean_ulcer_inr"]),
                fmt(r["mean_win_rate"] * 100, 0),
                fmt(r["mean_profit_factor"], 2),
                fmt(r["mean_mtm_stop_frequency"] * 100, 0),
            ]
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
        lines.append("Best set per strike:")
        lines.append("")
        header = [
            "strike",
            *[a for a in axes if a != "strike"],
            "cand",
            "robust",
            "₹/day",
            "Δ vs tmpl",
            "maxDD",
        ]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "---|" * len(header))
        for r in [s for s in strikes if s["index"] == index and s["band"] == band_ and s["key"]]:
            cells = [grid.pretty("strike", dict(r["key"])["strike"])]
            cells += [grid.pretty(a, dict(r["key"])[a]) for a in axes if a != "strike"]
            cells += [
                "yes" if r["band_candidate"] else "no",
                fmt(r["band_robust"], 1),
                fmt(r["mean_avg_day_inr"]),
                fmt(r["delta_vs_template_inr"]),
                fmt(r["mean_max_drawdown_inr"]),
            ]
            lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
    return "\n".join(lines)


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


def score_family(
    out_dir: Path, family: str, tail: bool = False
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    suffix = "_tail" if tail else ""
    rows = load_summary(out_dir / f"{family}_summary.csv")
    cohorts: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        cohorts[r["cohort"]].append(r)
    for cohort, members in cohorts.items():
        if tail:
            attach_worst5(out_dir, cohort, members)
        score_cohort(members, tail)
    rows.sort(key=lambda r: (r["cohort"], r["cohort_rank"]))
    write_csv(out_dir / f"{family}_ranked{suffix}.csv", rows)
    winners = band_winners(rows)
    write_csv(out_dir / f"{family}_band_winners{suffix}.csv", winners)
    strikes = strike_table(winners)
    text = render_markdown(family, winners, strikes, out_dir.name)
    print(
        f"{family}: {len(rows)} cells, {sum(r['passes'] for r in rows)} pass the gates, "
        f"{sum(r['candidate'] for r in rows)} candidates; {len(winners)} band sets, "
        f"{sum(w['band_candidate'] for w in winners)} band candidates",
        flush=True,
    )
    return rows, winners, text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="stage1")
    parser.add_argument("--family", default="all")
    parser.add_argument(
        "--tail-gate",
        action="store_true",
        help="also gate on worst day / worst-five-days vs the template; files get a _tail suffix",
    )
    parser.add_argument(
        "--buy-stop-cap", type=float, default=None, help="day-stop-rate cap for Buy"
    )
    args = parser.parse_args()
    if args.buy_stop_cap is not None:
        STOP_CAP["B"] = args.buy_stop_cap
    out_dir = RESULTS / args.tag
    families = grid.FAMILIES if args.family == "all" else tuple(args.family.split(","))
    texts = []
    for family in families:
        if not (out_dir / f"{family}_summary.csv").exists():
            print(f"{family}: no summary under {out_dir}", flush=True)
            continue
        texts.append(score_family(out_dir, family, args.tail_gate)[2])
    if texts:
        name = "band_tables_tail.md" if args.tail_gate else "band_tables.md"
        (out_dir / name).write_text("\n\n".join(texts) + "\n")
        print(f"wrote {out_dir / name}", flush=True)


if __name__ == "__main__":
    main()
