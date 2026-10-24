"""BL-161: apply the pre-registered rule to bl161_favourites_score_delay.py's output.

uv run python scripts/bl161_report.py <out.jsonl> [summary.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd


def load(path: str) -> pd.DataFrame:
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    return pd.DataFrame(rows)


def main(path: str, summary_path: str | None = None) -> None:
    df = load(path)
    if "error" not in df:
        df["error"] = None
    errors = df[df["error"].notna()]
    df = df[df["cagr"].notna()].copy()

    # Controls: saved score at delay 1 must reproduce the saved CAGR within 0.5 pt.
    controls = df[(df["score"] == df["saved_score"]) & (df["signal_delay"] == df["saved_delay"])]
    drift = controls.assign(
        saved_cagr=controls["saved_kpis"].map(lambda k: k.get("cagr")),
    )
    drift["diff_pts"] = (drift["cagr"] - drift["saved_cagr"]) * 100
    drift_bad = drift[drift["diff_pts"].abs() > 0.5]

    base = df[(df["score"] == df["saved_score"]) & (df["signal_delay"] == 1)].set_index("id")

    def delta(sub: pd.DataFrame, field: str) -> pd.Series:
        sub = sub.set_index("id")
        return sub[field] - base.loc[sub.index, field]

    voladj_ids = base.index[base["saved_score"] == "voladj"]
    rule_a = {}
    for score in ("ranksum", "blend"):
        sub = df[(df["score"] == score) & (df["signal_delay"] == 1) & df["id"].isin(voladj_ids)]
        d_martin = delta(sub, "martin")
        d_dd = delta(sub, "max_drawdown")
        d_cagr = delta(sub, "cagr")
        rule_a[score] = {
            "n": int(len(sub)),
            "median_d_martin": float(d_martin.median()),
            "martin_improved": int((d_martin > 0).sum()),
            "median_d_max_dd_pts": float(d_dd.median() * 100),
            "median_d_cagr_pts": float(d_cagr.median() * 100),
            "pass": bool(
                d_martin.median() > 0 and (d_martin > 0).sum() >= 8 and d_dd.median() * 100 >= -3
            ),
        }

    d0 = df[(df["score"] == df["saved_score"]) & (df["signal_delay"] == 0)]
    d_cagr_delay = delta(d0, "cagr") * 100
    rule_b = {
        "n": int(len(d0)),
        "median_d_cagr_pts": float(d_cagr_delay.median()),
        "median_abs_d_cagr_pts": float(d_cagr_delay.abs().median()),
        "matters": bool(d_cagr_delay.abs().median() > 1),
    }

    cols = ["cagr", "excess_cagr", "max_drawdown", "ulcer", "martin", "cdar95", "sharpe"]
    table = df.pivot_table(index="name", columns=["score", "signal_delay"], values=cols)
    medians = df.groupby(["score", "signal_delay"])[cols].median().round(4)
    by_variant = medians.reset_index().to_dict("records")
    summary = {
        "runs": int(len(df)),
        "errors": errors[["name", "score", "signal_delay", "error"]].to_dict("records"),
        "control_drift_over_half_pt": drift_bad[["name", "cagr", "saved_cagr", "diff_pts"]].to_dict(
            "records"
        ),
        "rule_a": rule_a,
        "rule_b": rule_b,
        "median_by_variant": by_variant,
    }
    print(json.dumps(summary, indent=1, default=str))
    pd.set_option("display.width", 250, "display.max_columns", 60)
    for metric in ("cagr", "max_drawdown", "martin", "ulcer"):
        print(f"\n== {metric} ==")
        scale = 100 if metric in ("cagr", "max_drawdown", "ulcer") else 1
        print((table[metric] * scale).round(2))
    if summary_path:
        Path(summary_path).write_text(json.dumps(summary, indent=1, default=str) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:])
