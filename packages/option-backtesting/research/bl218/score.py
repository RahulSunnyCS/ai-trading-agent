"""BL-218 scorer: cohorts are root x family x week (expiry / before); each half is read apart.

Per cell, over the cohort's sessions in one half: coverage (sessions run / sessions due),
entry rate (sessions with a trade / sessions run), net in ₹ (one lot, after 1% slippage and MCX
charges), mean ₹ a session, profit factor (winning sessions / |losing sessions|), the largest
share of the net from one expiry, and LB: the 5th percentile of the mean ₹ a session over 2,000
bootstrap resamples of whole expiries (an expiry's five sessions move together, so they are the
block). Gates (registered): coverage >= 90%, entry >= 30%, net > 0, PF >= 1.05, no expiry
> 50% of the net. Robust score = min(own LB, median LB of the one-step neighbours), for a cell
that passes its gates with at least half its neighbours passing; otherwise none.

    uv run python research/bl218/score.py --tag main                      # fit half
    uv run python research/bl218/score.py --tag main --finalists           # propose finalists
    uv run python research/bl218/score.py --tag main --half test --only finalists_<date>.json

The test half is scored only for a committed finalists file.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))

import grid  # noqa: E402
from cscv import cscv_pbo  # noqa: E402

RESULTS = HERE / "results"
RESAMPLES = 2000
SEED = 20261111
GATES = {"coverage": 0.90, "entry": 0.30, "pf": 1.05, "top_expiry_share": 0.50}
PBO_BLOCKS = 6


def load(tag: str, root: str) -> tuple[dict, dict]:
    meta = json.loads((RESULTS / tag / f"{root}.json").read_text())
    mats = dict(np.load(RESULTS / tag / f"{root}.npz"))
    return meta, mats


def _lb(net: np.ndarray, groups: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """5th percentile of the mean a session, resampling whole expiries (rows of `net` are
    sessions, columns cells; NaN = not run, counted as no session)."""
    labels = np.unique(groups)
    sums = np.stack([np.nansum(net[groups == g], axis=0) for g in labels])
    counts = np.array([(groups == g).sum() for g in labels], float)
    pick = rng.integers(0, len(labels), size=(RESAMPLES, len(labels)))
    means = sums[pick].sum(axis=1) / counts[pick].sum(axis=1)[:, None]
    return np.percentile(means, 5, axis=0)


def score_cohort(meta: dict, mats: dict, family: str, week: str, half: str, cell_ids=None):
    days = meta["days"]
    rows = np.array([d["week"] == week and d["half"] == half for d in days])
    due = int(rows.sum())
    ids = cell_ids or [i for i in meta["cells"] if i.split("|", 1)[0] == family]
    cols = np.array([meta["cells"].index(i) for i in ids])
    net = mats["net"][rows][:, cols]
    trades = mats["trades"][rows][:, cols]
    expiry = np.array([d["expiry"] for d in days])[rows]
    ran = ~np.isnan(net)
    filled = np.where(ran, net, 0.0)
    total = filled.sum(axis=0)
    wins = np.where(filled > 0, filled, 0).sum(axis=0)
    losses = -np.where(filled < 0, filled, 0).sum(axis=0)
    by_expiry = np.stack([filled[expiry == e].sum(axis=0) for e in np.unique(expiry)])
    top_share = np.where(total > 0, by_expiry.max(axis=0) / np.where(total > 0, total, 1), np.inf)
    lb = _lb(filled, expiry, np.random.default_rng(SEED))
    run_n = ran.sum(axis=0)
    out = {}
    for j, cid in enumerate(ids):
        m = {
            "cell": cid,
            "sessions_due": due,
            "coverage": float(run_n[j] / due) if due else 0.0,
            "entry": float(((trades[:, j] > 0) & ran[:, j]).sum() / max(run_n[j], 1)),
            "net": float(total[j]),
            "mean": float(total[j] / max(run_n[j], 1)),
            "pf": float(wins[j] / losses[j]) if losses[j] > 0 else float("inf"),
            "top_expiry_share": float(top_share[j]),
            "lb": float(lb[j]),
        }
        m["fails"] = [
            g
            for g, ok in (
                ("coverage", m["coverage"] >= GATES["coverage"]),
                ("entry", m["entry"] >= GATES["entry"]),
                ("net", m["net"] > 0),
                ("pf", m["pf"] >= GATES["pf"]),
                ("top_expiry_share", m["top_expiry_share"] <= GATES["top_expiry_share"]),
            )
            if not ok
        ]
        out[cid] = m
    if cell_ids is None:  # plateau over the whole family
        by_id = {c.id: c for c in grid.cells(family)}
        for cid, m in out.items():
            nb = [out[n.id] for n in grid.neighbours(by_id[cid]) if n.id in out]
            passing = sum(1 for n in nb if not n["fails"])
            if m["fails"] or passing * 2 < len(nb):
                m["robust"] = None
            else:
                m["robust"] = min(m["lb"], float(np.median([n["lb"] for n in nb])))
        valid = filled[:, : len(ids)]
        m_pbo, splits = (
            cscv_pbo(valid, PBO_BLOCKS) if valid.shape[0] >= PBO_BLOCKS * 2 else (None, 0)
        )
        return out, {"pbo": m_pbo, "pbo_splits": splits, "sessions_due": due}
    return out, {"sessions_due": due}


def _fmt(m: dict) -> str:
    rob = "—" if m.get("robust") is None else f"{m['robust']:,.0f}"
    pf = "inf" if m["pf"] == float("inf") else f"{m['pf']:.2f}"
    return (
        f"| `{m['cell'].split('|', 1)[1].replace('|', ' · ')}` | {m['net']:,.0f} | {m['mean']:,.0f} | {pf} | "
        f"{m['entry']:.0%} | {m['lb']:,.0f} | {rob} | {', '.join(m['fails']) or 'pass'} |"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="main")
    ap.add_argument("--roots", default=",".join(grid.ROOTS))
    ap.add_argument("--half", choices=("fit", "test"), default="fit")
    ap.add_argument("--only", help="committed finalists file (required for --half test)")
    ap.add_argument("--finalists", action="store_true", help="write finalists_proposed.json")
    ap.add_argument("--top", type=int, default=5)
    args = ap.parse_args()

    finalists = None
    if args.half == "test":
        if not args.only:
            sys.exit("the test half is scored only for a committed finalists file (--only)")
        path = Path(args.only)
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", str(path)],
            cwd=HERE,
            capture_output=True,
        )
        dirty = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", str(path)], cwd=HERE)
        if tracked.returncode or dirty.returncode:
            sys.exit(f"{path} must be committed, unchanged, before the test half is read")
        finalists = json.loads(path.read_text())

    lines = [f"# BL-218 {args.half} half — tag {args.tag}", ""]
    proposed: dict = {}
    for root in args.roots.split(","):
        meta, mats = load(args.tag, root)
        if meta["grid_sha"] != grid.grid_sha():
            sys.exit(f"{root}: results were run on grid {meta['grid_sha']}, not {grid.grid_sha()}")
        for family in grid.FAMILIES:
            for week in grid.WEEKS:
                cohort = f"{root}/{family}/{week}"
                ids = None
                if finalists is not None:
                    ids = [c for c in finalists.get(cohort, []) if c in meta["cells"]]
                    if not ids:
                        continue
                elif not any(i.startswith(family + "|") for i in meta["cells"]):
                    continue
                res, extra = score_cohort(meta, mats, family, week, args.half, ids)
                ranked = sorted(
                    res.values(),
                    key=lambda m: (m.get("robust") is None, -(m.get("robust") or m["lb"])),
                )
                best = [m for m in ranked if m.get("robust") is not None and m["robust"] > 0]
                n_pass = sum(1 for m in res.values() if not m["fails"])
                pbo = extra.get("pbo")
                head = f"## {cohort} — {extra['sessions_due']} sessions due, {len(res)} cells, "
                head += f"{n_pass} pass the gates"
                if pbo is not None:
                    head += f", PBO {pbo:.2f}"
                lines += [head, "", "| cell | net ₹ | ₹/session | PF | entry | LB | robust | gates |",
                          "|---|---|---|---|---|---|---|---|"]  # fmt: skip
                lines += [_fmt(m) for m in ranked[: args.top]]
                lines.append("")
                if args.finalists and best:
                    proposed[cohort] = [best[0]["cell"]]
    out = RESULTS / args.tag / f"scores_{args.half}.md"
    out.write_text("\n".join(lines))
    print(out)
    if args.finalists:
        path = RESULTS / args.tag / "finalists_proposed.json"
        path.write_text(json.dumps(proposed, indent=1))
        print(path, f"{len(proposed)} cohorts with a positive robust cell")


if __name__ == "__main__":
    main()
