"""BL-247 scorer: one number a cohort-session, D = mean over the cohort's pairs of
(net at 15:30 - net at 17:05). Only cohorts the prices-live gate passed are read.

    uv run python research/bl247/score.py fit     # writes results/scores_fit.md and passed.json
    uv run python research/bl247/score.py test
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))

import grid  # noqa: E402
from run import COLUMNS, RESULTS  # noqa: E402


def lower_bound(values: np.ndarray, expiry: np.ndarray) -> float:
    """5th percentile of the mean over resamples of whole expiries (their sessions move
    together)."""
    labels = np.unique(expiry)
    sums = np.array([values[expiry == e].sum() for e in labels])
    counts = np.array([(expiry == e).sum() for e in labels], dtype=float)
    rng = np.random.default_rng(grid.SEED)
    pick = rng.integers(0, len(labels), size=(grid.RESAMPLES, len(labels)))
    return float(np.percentile(sums[pick].sum(axis=1) / counts[pick].sum(axis=1), 5))


def columns(family: str, entry: str) -> list[int]:
    return [i for i, (e, f, _) in enumerate(COLUMNS) if f == family and e == entry]


def cohort(meta: dict, mats: dict, family: str, week: str) -> dict:
    days = meta["days"]
    rows = np.array([d["week"] == week and not d["reason"] for d in days])
    due = sum(d["week"] == week for d in days)
    new = mats["net"][rows][:, columns(family, grid.ENTRY)]
    base = mats["net"][rows][:, columns(family, grid.BASE_ENTRY)]
    expiry = np.array([d["expiry"] for d in days])[rows]
    diff = (new - base).mean(axis=1)
    level = new.mean(axis=1)
    by_expiry = np.array([level[expiry == e].sum() for e in np.unique(expiry)])
    total = float(level.sum())
    return {
        "sessions": int(rows.sum()),
        "due": int(due),
        "diff": float(diff.mean()),
        "diff_lb": lower_bound(diff, expiry),
        "net_new": float(level.mean()),
        "net_base": float(base.mean(axis=1).mean()),
        "entry_new": float(mats["entered"][rows][:, columns(family, grid.ENTRY)].mean()),
        "entry_base": float(mats["entered"][rows][:, columns(family, grid.BASE_ENTRY)].mean()),
        "top_expiry_share": float(by_expiry.max() / total) if total > 0 else None,
        "pairs_better": int(((new.mean(axis=0) - base.mean(axis=0)) > 0).sum()),
        "pairs": new.shape[1],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("half", choices=("fit", "test"))
    args = ap.parse_args()
    gate = json.loads((RESULTS / "gate.json").read_text())
    lines = [
        f"# BL-247 {args.half} half (grid SHA {grid.grid_sha()})",
        "",
        "Rupees a lot a session, the mean over the cohort's 24 pairs, after 1% slippage and MCX"
        " charges.",
        "",
        "| Cohort | Sessions | 15:30 net | 17:05 net | 15:30 minus 17:05 | 5th pct | Pairs better |"
        " Entered 15:30 / 17:05 | Result |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    passed, results = [], {}
    loaded: dict = {}
    for key, info in gate["cohorts"].items():
        root, family, week = key.split("|")
        name = f"{root} {family} {week}"
        if not info["live"]:
            lines.append(f"| {name} | — | — | — | — | — | — | — | not judged: prices not live |")
            continue
        path = RESULTS / args.half / f"{root}.json"
        if not path.exists():
            continue
        if root not in loaded:
            loaded[root] = (
                json.loads(path.read_text()),
                dict(np.load(path.with_suffix(".npz"))),
            )
        meta, mats = loaded[root]
        if np.isnan(mats["net"][:, columns(family, grid.ENTRY)]).all():
            continue
        m = cohort(meta, mats, family, week)
        if args.half == "fit":
            ok = m["diff"] > 0 and m["diff_lb"] > 0 and m["net_new"] > 0
        else:
            ok = m["diff"] > 0 and m["net_new"] > 0
        if ok:
            passed.append(key)
        results[key] = m | {"passed": ok}
        lines.append(
            f"| {name} | {m['sessions']}/{m['due']} | {m['net_new']:,.0f} | {m['net_base']:,.0f} |"
            f" {m['diff']:+,.0f} | {m['diff_lb']:+,.0f} | {m['pairs_better']}/{m['pairs']} |"
            f" {m['entry_new']:.0%} / {m['entry_base']:.0%} | {'PASS' if ok else 'fail'} |"
        )
    (RESULTS / f"scores_{args.half}.md").write_text("\n".join(lines) + "\n")
    (RESULTS / f"scores_{args.half}.json").write_text(json.dumps(results, indent=1))
    if args.half == "fit":
        (RESULTS / "passed.json").write_text(json.dumps(passed, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
