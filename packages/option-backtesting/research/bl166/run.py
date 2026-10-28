"""BL-166 Phase 2: the one registered test on the learning period (one ledger try), the pass rule's
steps 1-2, and only for a candidate the once-only reveal and the confirmation run (steps 3-4).

    uv run python research/bl166/run.py [--workers 6]

Output: out/<id>_<period>.json, out/summary.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from specs import RULE  # noqa: E402

OUT = HERE / "out"
MIN_EVENTS, T_MIN, PCT_MIN = 40, 2.0, 0.90


def summary(period: str, result: dict) -> dict:
    from option_backtesting.ruletest import study

    p = result["periods"][period]
    rows = p.get("rows", [])
    mean, t = study.day_t({r["day"]: r["net"] for r in rows})
    nets = sorted(r["net"] for r in rows)
    slip = p.get("slippage") or {}
    out = {
        "period": period,
        "test_id": result["id"],
        "spec_hash": result["spec_hash"],
        "events": p.get("events", 0),
        "win_rate": p.get("win_rate"),
        "net_mean": mean if rows else None,
        "net_t": t,
        "net_total": p.get("net_total"),
        "median": nets[len(nets) // 2] if nets else None,
        "mean_without_best3": (sum(nets[:-3]) / (len(nets) - 3)) if len(nets) > 3 else None,
        "random_percentile": (p.get("random_time") or {}).get("event_percentile"),
        "random_mean": (p.get("random_time") or {}).get("mean"),
        "placebo_mean": (p.get("placebo") or {}).get("placebo_mean"),
        "slip_0.5_net_mean": (slip.get("0.5") or {}).get("net_mean"),
        "slip_1_net_mean": (slip.get("1") or {}).get("net_mean"),
    }
    out["thin"] = out["events"] < MIN_EVENTS
    out["meets_rule"] = (
        not out["thin"]
        and (out["net_mean"] or 0) > 0
        and t is not None
        and t >= T_MIN
        and (out["random_percentile"] or 0) >= PCT_MIN
        and (period == "confirmation" or (out["slip_0.5_net_mean"] or -1) > 0)
    )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from trading_data.db import data_root

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import store, study
    from option_backtesting.ruletest.spec import from_dict

    root = data_root()
    OUT.mkdir(parents=True, exist_ok=True)
    rule = from_dict(RULE)
    text = yaml.safe_dump({"rule": RULE}, sort_keys=False)
    frame = F.load_frame(root, "NIFTY", study.PERIODS["learning"][1])

    def test(period: str) -> dict:
        options = study.Options(
            periods=(period,), workers=args.workers, tries=1,
            progress=lambda m: print(f"[{period}] {m}", flush=True),
        )  # fmt: skip
        result = study.run_test(root, rule, text, options, frame=frame)
        (OUT / f"{RULE['id']}_{period}.json").write_text(json.dumps(result, indent=1, default=str))
        return summary(period, result)

    rows = [test("learning")]
    print(json.dumps(rows[-1], default=str), flush=True)
    if rows[-1]["thin"]:
        print("verdict: inconclusive (thin)")
    elif not rows[-1]["meets_rule"]:
        print("verdict: killed (not a candidate); confirmation period not opened")
    else:
        store.reveal(root, rule.spec_hash, note="BL-166 S1: registered confirmation test")
        rows.append(test("confirmation"))
        print(json.dumps(rows[-1], default=str), flush=True)
        print("verdict:", "passed" if rows[-1]["meets_rule"] else "killed (fails confirmation)")
    with (OUT / "summary.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
