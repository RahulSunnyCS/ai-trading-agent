"""BL-158 Phase 1: the followed Four Sectors group at Monday's open (delay 0) against as followed
(delay 1, Friday close). The rules are search_spaces/bl158_criteria.json (committed before this
ran); this script reads its arms and base run from it, and `verdict` copies each rule's number
from the file's wording (a rule whose id is not in the file fails the run).

    uv run python scripts/bl158_monday_open.py

Arms A, B and C each run fresh over every rolling 3-year window (`sweep.rerun_windows`), each window
as the followed account: one run per Friday sleeve on a shared ranking, blended like the backtest
(`tranches.blend_reset`). Then A and C over the full period with tax on. Output goes to
data/research/bl158/ (git-ignored): windows per arm, the comparison and verdict.json.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from momentum_backtesting import api, db_read, sweep, tranches
from momentum_backtesting.engine import Result
from momentum_backtesting.tax import TaxRules

CRITERIA_PATH = Path(__file__).resolve().parent.parent / "search_spaces" / "bl158_criteria.json"
CRITERIA = json.loads(CRITERIA_PATH.read_text())
BASE_RUN = CRITERIA["base_run"].split()[0]
OUT = api.DATA_DIR / "research" / "bl158"
IST = ZoneInfo("Asia/Kolkata")


def base_params() -> dict:
    with db_read.read_catalog() as con:
        row = con.execute(
            "SELECT params FROM backtest_runs WHERE run_id = ?", [BASE_RUN]
        ).fetchone()
    return json.loads(row[0])


def request(changes: dict, **extra) -> api.BacktestRequest:
    return api.BacktestRequest(**{**BASE, **changes, **extra})


def run(req: api.BacktestRequest) -> Result:
    """The followed account for `req`: what `api._broad_parts` builds, without the payload."""
    ranking = api._broad_ranking(req)
    outer = api.DATA.get()
    every = api.split_every(req)
    reqs = [
        req.model_copy(update={"rebalance_offset": offset, "capital": req.capital / every})
        for offset in range(every)
    ]
    # `_run_broad` ignores `req.tax`: tax reaches a Broad run only as this argument (BL-116).
    tax = TaxRules(slab_rate=req.slab_rate) if req.tax else None
    phases = [api._run_broad(r, ranking, outer, tax=tax).result for r in reqs]
    return tranches.blend_reset(phases) if every > 1 else phases[0]


def day(ts: pd.Timestamp) -> str:
    return ts.strftime("%Y-%m-%d")


def code_commit() -> str:
    root = Path(api.__file__).resolve().parents[4]
    commit = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True
    ).stdout.strip()
    dirty = subprocess.run(
        [
            "git",
            "-C",
            str(root),
            "status",
            "--porcelain",
            "--",
            "packages/momentum-backtesting/src",
        ],
        capture_output=True,
        text=True,
    ).stdout.strip()
    return commit + ("+dirty" if dirty else "")


def verdict(frames: dict[str, pd.DataFrame], after_tax: dict[str, float]) -> dict:
    """Each pass rule's number and whether it holds (A is the baseline, C the candidate)."""
    joined = frames["C"].join(frames["A"], rsuffix=" A", how="inner")
    d_cagr = (joined["CAGR"] - joined["CAGR A"]) * 100
    d_sharpe = joined["Sharpe"] - joined["Sharpe A"]
    d_dd = (joined["max drawdown"] - joined["max drawdown A"]) * 100  # negative = C deeper
    both = int(((d_cagr > 0) & (d_sharpe > 0)).sum())
    worst_gap = (frames["C"]["max drawdown"].min() - frames["A"]["max drawdown"].min()) * 100
    tax_gap = (after_tax["C"] - after_tax["A"]) * 100
    rules = {
        "wins_most": {"value": f"{both} of {len(joined)} windows", "holds": both > len(joined) / 2},
        "median_cagr": {
            "value_pts": round(float(d_cagr.median()), 2),
            "holds": d_cagr.median() >= 1.0,
        },
        "median_drawdown": {
            "value_pts": round(float(d_dd.median()), 2),
            "holds": d_dd.median() >= -3.0,
        },
        "worst_drawdown": {"value_pts": round(float(worst_gap), 2), "holds": worst_gap >= -5.0},
        "after_tax": {"value_pts": round(float(tax_gap), 2), "holds": tax_gap >= 0.0},
    }
    expected = {r["id"] for r in CRITERIA["pass_rule"]["all_must_hold"]}
    assert expected == set(rules), f"criteria rules {expected} != computed {set(rules)}"
    for rule in rules.values():
        rule["holds"] = bool(rule["holds"])
    return {"rules": rules, "pass": all(r["holds"] for r in rules.values())}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    arms = {key: arm["changes"] for key, arm in CRITERIA["arms"].items()}
    started = time.time()
    full_a = run(request(arms["A"]))
    windows = sweep.rolling_windows(full_a.equity.index, years=3.0, step_weeks=13)
    print(f"{len(windows)} windows, {day(windows[0][0])} to {day(windows[-1][1])}", flush=True)

    frames = {}
    for key in ("A", "C", "B"):
        t = time.time()
        frames[key] = sweep.rerun_windows(
            lambda s, e, ch=arms[key]: run(request(ch, start=day(s), end=day(e))), windows
        )
        frames[key].to_csv(OUT / f"windows_{key}.csv")
        print(f"arm {key}: {len(frames[key])} windows in {time.time() - t:.0f}s", flush=True)
    comparison = sweep.compare_rolling(frames, baseline="A")
    comparison.to_csv(OUT / "compare.csv")

    after_tax = {}
    for key in ("A", "C"):
        result = run(request(arms[key], tax=True))
        after_tax[key] = float(sweep.window_row(result.equity, result.cash)["CAGR"])
    result = verdict(frames, after_tax)

    record = {
        "item": "BL-158 Phase 1",
        "criteria": str(CRITERIA_PATH.name),
        "criteria_sha256": hashlib.sha256(CRITERIA_PATH.read_bytes()).hexdigest(),
        "ran_at": datetime.now(IST).isoformat(timespec="seconds"),
        "data_version": db_read.data_version(),
        "code_commit": code_commit(),
        "windows": len(windows),
        "after_tax_cagr": {k: round(v, 4) for k, v in after_tax.items()},
        "comparison": json.loads(comparison.to_json(orient="index")),
        **result,
        "seconds": round(time.time() - started),
    }
    (OUT / "verdict.json").write_text(json.dumps(record, indent=2, default=str))
    print(json.dumps({"pass": result["pass"], "rules": result["rules"]}, indent=2), flush=True)


BASE = base_params()

if __name__ == "__main__":
    main()
