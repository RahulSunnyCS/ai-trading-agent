"""BL-010 Phase 6 step 0: pick the ensemble Phase 6 follows (criteria addendum 4), after
checking the picking rule with its own walk-forward. Writes `ensemble.json` and `ensemble.md`.

The pick is frozen (written to `search_spaces/bl010_phase6_frozen.json` by the caller) only if
the walk-forward passes; otherwise addendum 4 says Phase 6 tracks the index alone unless the
owner decides otherwise.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from . import choose, criteria
from .phase5 import MIDCAP, MOM30, SMALLCAP, _pct


def _joined(table: pd.DataFrame, column: str) -> float:
    years = len(table)
    return float((1 + table[column].fillna(0.0)).prod()) ** (1 / years) - 1 if years else math.nan


def run(
    curves: pd.DataFrame,
    facts: pd.DataFrame,
    records: dict[str, dict],
    series: dict[str, pd.Series],
    out: Path,
    *,
    echo=print,
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    spec = criteria.load()["phase_6_ensemble"]
    basket = spec["eligible"]["basket"]
    bench = series[MOM30].reindex(curves.index).ffill()
    indices = {k: series[k].reindex(curves.index).ffill() for k in (MIDCAP, SMALLCAP)}
    fys = choose.complete_fys(curves.index)
    report: dict = {"basket": basket, "fys": fys}

    membership: dict = {}
    for label, partial in (("committed", False), ("with_fy2019_partial", True)):
        echo(f"walk-forward: {label} ...")
        table = choose.walk_forward_ensemble(
            curves, indices, bench, facts, partial_first=partial, membership=membership, echo=echo
        )
        summary = {
            "years": [int(y) for y in table.index],
            "ensemble": _joined(table, "ensemble_return"),
            "median": _joined(table, "median_return"),
            "bench": _joined(table, "bench_return"),
            "table": json.loads(table.to_json(orient="index")),
        }
        if label == "committed":
            summary["passes"] = bool(
                summary["ensemble"] >= summary["median"] - 0.02
                and summary["ensemble"] >= summary["bench"] + 0.05
            )
        report[label] = summary

    echo("the pick on the full history ...")
    full = choose.basket_members(curves, indices)[basket]
    group = choose.ensemble_group(full, facts)
    windows = [choose.fy_bounds(f) for f in fys]
    picks = choose.typical_set(curves, group, bench, windows)
    phases = choose.rebalance_phases(picks, facts)
    line = choose.ensemble_curve(curves, picks)
    depth = float((line / line.cummax() - 1).min())
    fy_rows = {}
    for fy in fys:
        start, end = choose.fy_bounds(fy)
        fy_rows[fy] = {
            "ensemble": choose.ensemble_window_return(curves, picks, start, end),
            "group_median": float(choose.window_returns(curves[group], start, end).median()),
            "bench": float(choose.window_returns(bench, start, end)),
        }
    pairwise = np.log(curves[picks].astype(float)).diff().corr().to_numpy()
    np.fill_diagonal(pairwise, np.nan)
    report["pick"] = {
        "group": len(group),
        "configs": [
            {
                "id": cid,
                "holdings": int(facts.at[cid, "holdings"]),
                "rebalance_every": int(facts.at[cid, "every"]),
                "phase_slot": phases[cid],
                "cagr": float(choose.cagr(curves[cid])),
                "heavy": records[cid]["heavy"],
                "light": records[cid]["light"],
            }
            for cid in picks
        ],
        "max_pairwise_corr": float(np.nanmax(pairwise)) if len(picks) > 1 else math.nan,
        "ensemble_cagr": float(choose.cagr(line)),
        "ensemble_mdd": depth,
        "ensemble_ulcer": float(choose.ulcer(line.to_frame()).iloc[0]),
        "group_median_cagr": float(choose.cagr(curves[group]).median()),
        "bench_cagr": float(choose.cagr(bench)),
        "fy": fy_rows,
    }
    (out / "ensemble.json").write_text(json.dumps(report, indent=1, default=float))
    (out / "ensemble.md").write_text(markdown(report))
    echo(f"wrote {out / 'ensemble.md'}")
    return report


def markdown(report: dict) -> str:
    c, s = report["committed"], report["with_fy2019_partial"]
    p = report["pick"]
    lines = [
        "# BL-010 Phase 6: the ensemble to follow (criteria addendum 4)",
        "",
        f"Basket: {report['basket']}; 8-12 holdings; rebalance every 2 or 4 weeks. Pre-tax, "
        "Rs 2 lakh, point-in-time universe, today's curated tags.",
        "",
        "## Does the picking rule work? (walk-forward)",
        "",
        "| Variant | Years | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|---|",
    ]
    for label, w in (("committed", c), ("with FY2019 (sensitivity)", s)):
        years = w["years"]
        lines.append(
            f"| {label} | FY{years[0]}-FY{years[-1]} | {_pct(w['ensemble'])} | "
            f"{_pct(w['median'])} | {_pct(w['bench'])} |"
        )
    lines += [
        "",
        "Pass: the ensemble within 2 points a year of the group median and at least 5 points "
        f"above Mom30 TRI. **{'Passes' if c['passes'] else 'Killed'}.**",
        "",
        "| FY | Picked on | Group | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|---|---|",
    ]
    for fy, row in s["table"].items():
        lines.append(
            f"| {fy} | {row['selected_on']} | {row['group']} | {_pct(row['ensemble_return'])} | "
            f"{_pct(row['median_return'])} | {_pct(row['bench_return'])} |"
        )
    lines += [
        "",
        f"## The pick on the full history ({p['group']} configs eligible)",
        "",
        "| Config | Holdings | Every | Phase slot | CAGR |",
        "|---|---|---|---|---|",
    ]
    for cfg in p["configs"]:
        lines.append(
            f"| `{cfg['id']}` | {cfg['holdings']} | {cfg['rebalance_every']} weeks | "
            f"{cfg['phase_slot']} | {_pct(cfg['cagr'])} |"
        )
    lines += [
        "",
        f"Ensemble (equal capital, reset each April): CAGR {_pct(p['ensemble_cagr'])}, max "
        f"drawdown {_pct(p['ensemble_mdd'])}, Ulcer {_pct(p['ensemble_ulcer'])}. Group median "
        f"config {_pct(p['group_median_cagr'])}; Mom30 TRI {_pct(p['bench_cagr'])}. Highest "
        f"correlation between two picks: {p['max_pairwise_corr']:.2f}.",
        "",
        "| FY | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|",
    ]
    for fy, row in p["fy"].items():
        lines.append(
            f"| {fy} | {_pct(row['ensemble'])} | {_pct(row['group_median'])} | "
            f"{_pct(row['bench'])} |"
        )
    return "\n".join(lines) + "\n"
