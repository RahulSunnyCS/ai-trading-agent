"""BL-152 Phase 3: apply the registered pass rule (backlog/BL-152 Phase 0, criteria.json) to the grid.

Steps (numbers from criteria.json): thin -> candidate -> CSCV / PBO over every variant's daily net
series (a day with no trade = 0) -> plateau over each candidate's one-setting neighbours -> at most
three advance, highest t first. With --confirm, each advancing variant's confirmation period is
revealed once and tested (the registered step 5); without it nothing is revealed.

    uv run python research/bl152/judge.py             # learning-period verdict, reveals nothing
    uv run python research/bl152/judge.py --confirm   # step 5 for the advancing variants

CSCV comes from research/bl104/robust.py, imported as BL-105 and BL-106 do.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bl104"))
from robust import cscv_pbo  # noqa: E402
from specs import AXES, CRITERIA, grid  # noqa: E402

OUT = HERE / "out"
RULE = CRITERIA["pass_rule"]
_NORMAL = statistics.NormalDist()


def load_done() -> dict[str, dict]:
    rows = {}
    for line in (OUT / "done.jsonl").read_text().splitlines():
        if line.strip():
            row = json.loads(line)
            rows[row["id"]] = row
    return rows


def axes_of(vid: str) -> tuple[str, ...]:
    return tuple(vid.removeprefix("bl152_").split("_"))


def is_candidate(row: dict) -> bool:
    c = RULE["candidate"]
    mean, t, pct = row.get("net_mean"), row.get("net_t"), row.get("random_percentile")
    return (
        not row.get("thin", True)
        and row.get("events", 0) >= RULE["min_events"]
        and mean is not None
        and not math.isnan(mean)
        and mean > c["net_mean_gt"]
        and t is not None
        and t >= c["net_t_min"]
        and pct is not None
        and pct >= c["random_time_percentile_min"]
    )


def neighbours(vid: str, ids: set[str]) -> list[str]:
    mine = axes_of(vid)
    names = list(AXES)
    out = []
    for k, axis in enumerate(names):
        for value in AXES[axis]:
            if value != mine[k]:
                other = list(mine)
                other[k] = value
                nid = "bl152_" + "_".join(other)
                if nid in ids:
                    out.append(nid)
    return out


def series(rows: dict[str, dict], days: list[str]) -> tuple[np.ndarray, list[str]]:
    ids = sorted(rows)
    index = {d: k for k, d in enumerate(days)}
    matrix = np.zeros((len(days), len(ids)))
    for j, vid in enumerate(ids):
        for r in json.loads((OUT / "nets" / f"{vid}.json").read_text()):
            if r["day"] in index:
                matrix[index[r["day"]], j] += r["net"]
    return matrix, ids


def deflated_sharpe(matrix: np.ndarray) -> dict:
    """The simplified (Gaussian) deflated Sharpe of the best daily Sharpe, as analytics/overfit."""
    sd = matrix.std(axis=0, ddof=1)
    sharpe = np.where(sd > 0, matrix.mean(axis=0) / np.where(sd > 0, sd, 1), 0.0)
    n, t = matrix.shape[1], matrix.shape[0]
    var = float(np.var(sharpe, ddof=1)) if n > 1 else 0.0
    gamma = 0.5772156649015329
    sr0 = math.sqrt(var) * (
        (1 - gamma) * _NORMAL.inv_cdf(1 - 1 / n) + gamma * _NORMAL.inv_cdf(1 - 1 / (n * math.e))
    )
    best = float(sharpe.max())
    z = (best - sr0) * math.sqrt(t - 1) / math.sqrt(1 + best**2 / 2)
    return {"best_daily_sharpe": best, "sr0": sr0, "dsr": _NORMAL.cdf(z), "n": n, "days": t}


def confirm(root: Path, vids: list[str]) -> list[dict]:
    import yaml

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import store, study
    from option_backtesting.ruletest.spec import from_dict

    rules = dict(grid())
    lo, hi = study.PERIODS["confirmation"]
    frame = F.load_frame(root, CRITERIA["underlying"], hi)
    out = []
    for vid in vids:
        rule = rules[vid]
        compiled = from_dict(rule)
        store.reveal(root, compiled.spec_hash, "BL-152 registered step 5 (research/bl152/judge.py)")
        result = study.run_test(
            root,
            compiled,
            yaml.safe_dump({"rule": rule}, sort_keys=False),
            study.Options(periods=("confirmation",), workers=6),
            frame=frame,
        )
        period = result["periods"]["confirmation"]
        nets = {r["day"]: r["net"] for r in period.get("rows", [])}
        mean, t = study.day_t(nets)
        pct = (period.get("random_time") or {}).get("event_percentile")
        c = RULE["confirmation_pass"]
        passed = (
            bool(nets)
            and mean > c["net_mean_gt"]
            and t is not None
            and t >= c["net_t_min"]
            and pct is not None
            and pct >= c["random_time_percentile_min"]
        )
        out.append(
            {
                "id": vid,
                "test_id": result["id"],
                "events": period.get("events", 0),
                "net_mean": mean if nets else None,
                "net_t": t,
                "random_percentile": pct,
                "slip_0_5": ((period.get("slippage") or {}).get("0.5") or {}).get("net_mean"),
                "passed": passed,
            }
        )
        print(f"confirmation {vid}: {out[-1]}", flush=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--confirm", action="store_true", help="registered step 5: reveal and test")
    args = ap.parse_args()
    from option_backtesting.legwise.market import backtest_days
    from option_backtesting.ruletest import study

    root = Path(os.environ["TRADING_DATA_ROOT"])
    rows = load_done()
    expected = {vid for vid, _ in grid()}
    missing = sorted(expected - set(rows))
    if missing:
        print(
            f"{len(missing)} variants have no result yet (e.g. {missing[0]}); judge after the grid"
        )
        return 2
    lo, hi = study.PERIODS["learning"]
    usable, _ = backtest_days(root, CRITERIA["underlying"], lo, hi)
    days = [d.isoformat() for d in usable]
    matrix, ids = series(rows, days)
    pbo = {b: cscv_pbo(matrix, b)[0] for b in RULE["pbo"]["n_blocks"]}
    pbo_ok = all(v <= RULE["pbo"]["max"] for v in pbo.values())
    dsr = deflated_sharpe(matrix)
    thin = [
        v for v in ids if rows[v].get("thin", True) or rows[v].get("events", 0) < RULE["min_events"]
    ]
    candidates = [v for v in ids if is_candidate(rows[v])]
    plateau = {}
    for vid in candidates:
        near = neighbours(vid, set(ids))
        positive = [n for n in near if (rows[n].get("net_mean") or -1) > 0]
        plateau[vid] = {"neighbours": len(near), "positive": len(positive),
                        "share": len(positive) / len(near) if near else 0.0}  # fmt: skip
    advancing = [
        v
        for v in candidates
        if pbo_ok and plateau[v]["share"] >= RULE["plateau"]["share_positive_min"]
    ]
    advancing.sort(key=lambda v: -(rows[v]["net_t"] or 0))
    advancing = advancing[: RULE["max_to_confirmation"]]
    positive = sum(1 for v in ids if (rows[v].get("net_mean") or -1) > 0)
    report = {
        "judged": date.today().isoformat(),
        "variants": len(ids),
        "learning_days": len(days),
        "thin": len(thin),
        "positive_net_mean": positive,
        "candidates": candidates,
        "pbo": pbo,
        "pbo_ok": pbo_ok,
        "deflated_sharpe": dsr,
        "plateau": plateau,
        "advancing": advancing,
    }
    if args.confirm and advancing:
        report["confirmation"] = confirm(root, advancing)
    passed = [c["id"] for c in report.get("confirmation", []) if c["passed"]]
    if len(thin) > len(ids) / 2:
        verdict = "inconclusive (most variants thin)"
    elif not candidates:
        verdict = "killed: no candidate"
    elif not pbo_ok:
        verdict = "killed: the grid fails the PBO check"
    elif not advancing:
        verdict = "killed: no candidate holds its plateau"
    elif "confirmation" not in report:
        verdict = "pending: confirmation not run (--confirm)"
    elif passed:
        verdict = f"passed: {', '.join(passed)}"
    else:
        verdict = "killed: no advancing variant passes confirmation"
    report["verdict"] = verdict
    (OUT / "judgement.json").write_text(json.dumps(report, indent=2, default=float))
    best = sorted(ids, key=lambda v: -(rows[v].get("net_t") or -99))[:10]
    print(f"verdict: {verdict}")
    print(
        f"variants {len(ids)}, thin {len(thin)}, positive mean {positive}, candidates {len(candidates)}"
    )
    print(f"PBO {pbo} (ok: {pbo_ok}); deflated Sharpe {dsr['dsr']:.3f}")
    print("top 10 by t:")
    for v in best:
        r = rows[v]
        print(
            f"  {v:40s} n={r['events']:4d} mean={r['net_mean'] or float('nan'):8.0f} "
            f"t={r['net_t'] or float('nan'):5.2f} rand%={r['random_percentile'] or float('nan'):.2f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
