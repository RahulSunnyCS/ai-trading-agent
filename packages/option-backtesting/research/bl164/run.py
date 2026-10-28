"""BL-164 Phase 2: the three registered tests (H1, H2, H3) on the learning period only, each
recorded in the rule tester's ledger (three tries), then the pass rule's steps 1-2 (backlog/BL-164
Phase 0). Reveals nothing: the confirmation period stays locked.

    uv run python research/bl164/run.py [--workers 6]

Output: out/<id>.json (the tester's full result), out/summary.csv (one row per test).
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
from specs import specs  # noqa: E402

OUT = HERE / "out"
MIN_EVENTS = 40
T_MIN = 2.0
PCT_MIN = 0.90


def summary(rid: str, result: dict) -> dict:
    from option_backtesting.ruletest import study

    period = result["periods"]["learning"]
    rows = period.get("rows", [])
    mean, t = study.day_t({r["day"]: r["net"] for r in rows})
    random_time = period.get("random_time") or {}
    placebo = period.get("placebo") or {}
    slip = period.get("slippage") or {}
    out = {
        "id": rid,
        "spec_hash": result["spec_hash"],
        "test_id": result["id"],
        "events": period.get("events", 0),
        "net_mean": mean if rows else None,
        "net_t": t,
        "net_total": period.get("net_total"),
        "gross_mean": period.get("gross_mean"),
        "win_rate": period.get("win_rate"),
        "random_percentile": random_time.get("event_percentile"),
        "random_mean": random_time.get("mean"),
        "placebo_mean": placebo.get("placebo_mean"),
        "placebo_diff_mean": placebo.get("diff_mean"),
        "placebo_diff_t": placebo.get("diff_t"),
        "slip_0.5_net_mean": (slip.get("0.5") or {}).get("net_mean"),
        "slip_1_net_mean": (slip.get("1") or {}).get("net_mean"),
    }
    out["thin"] = out["events"] < MIN_EVENTS
    out["candidate"] = (
        not out["thin"]
        and out["net_mean"] is not None
        and out["net_mean"] > 0
        and t is not None
        and t >= T_MIN
        and out["random_percentile"] is not None
        and out["random_percentile"] >= PCT_MIN
        and out["slip_0.5_net_mean"] is not None
        and out["slip_0.5_net_mean"] > 0
    )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from trading_data.db import data_root

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import study
    from option_backtesting.ruletest.spec import from_dict

    root = data_root()
    OUT.mkdir(parents=True, exist_ok=True)
    frame = F.load_frame(root, "NIFTY", study.PERIODS["learning"][1])
    rows = []
    for body in specs():
        rid = body["id"]
        rule = from_dict(body)
        text = yaml.safe_dump({"rule": body}, sort_keys=False)
        options = study.Options(
            periods=("learning",),
            workers=args.workers,
            tries=1,
            progress=lambda m, rid=rid: print(f"[{rid}] {m}", flush=True),
        )
        result = study.run_test(root, rule, text, options, frame=frame)
        (OUT / f"{rid}.json").write_text(json.dumps(result, indent=1, default=str))
        rows.append(summary(rid, result))
        print(json.dumps(rows[-1], default=str), flush=True)
    with (OUT / "summary.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {OUT}/summary.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
