"""BL-165: BL-164's two leads (gap-down days, expiry days) on the locked confirmation period.

Steps, as registered in backlog/BL-165 Phase 0; each stops the run if it fails:

1. `expiry_day` is checked against the simulator's own choice (`load_day` + `pick_expiry`) on sampled
   sessions of both periods.
2. The reproduction check: each lead on the learning period must give BL-164's slice (same trade
   days, the same mean net to the rupee). Needs BL-164's result file (`research/bl164/run.py`).
3. The reveal (once per spec hash, noted BL-165) and the confirmation run, then the pass rule.

    uv run python research/bl165/run.py [--workers 6] [--specs-only]

Every test run is recorded in the rule tester's ledger. Output: out/<id>_<period>.json,
out/summary.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "common"))
from gap_and_go_specs import CONTROL_H1, rule  # noqa: E402

OUT = HERE / "out"
BL164_H1 = HERE.parent / "bl164" / "out" / "bl164_h1_gap_and_go.json"
MIN_EVENTS = 40
T_MIN = 2.24  # two tests, Bonferroni at 5%
PCT_MIN = 0.90
NOTES = "BL-165, a lead from BL-164's learning-period breakdown; registered in the backlog item"


def specs() -> list[dict]:
    on_expiry = {side: {"all": ["expiry_day", cond]} for side, cond in CONTROL_H1.items()}
    l1 = rule(
        "bl165_l1_gap_down",
        "BL-165 L1 gap-and-go, gap-down days",
        "h1_down",
        ("09:46", "12:00"),
        "gap_up",
        CONTROL_H1,
    )
    l2 = rule(
        "bl165_l2_expiry_day",
        "BL-165 L2 gap-and-go, expiry days",
        {"all": ["h1", "expiry_day"]},
        ("09:46", "12:00"),
        "gap_up",
        on_expiry,
    )
    return [{**l1, "notes": NOTES}, {**l2, "notes": NOTES}]  # fmt: skip


def expected(rid: str) -> list[dict]:
    """BL-164's H1 learning-period trades that make up the lead's slice."""
    rows = json.loads(BL164_H1.read_text())["periods"]["learning"]["rows"]
    if rid == "bl165_l1_gap_down":
        return [r for r in rows if r["side"] == "down"]
    return [r for r in rows if r["expiry_day"]]


def check_expiry(root: Path, frame, period_bounds, n: int = 25) -> None:
    from option_backtesting.legwise.market import backtest_days, load_day, pick_expiry

    flags = frame.expiry_loader()
    at = {d: i for i, d in enumerate(frame.days)}
    rng = random.Random(20261025)
    checked = 0
    for lo, hi in period_bounds:
        days = [d for d in backtest_days(root, "NIFTY", lo, hi)[0] if d.isoformat() in at]
        expiries = [d for d in days if flags[at[d.isoformat()]]]
        sample = rng.sample(days, min(n, len(days))) + rng.sample(expiries, min(n, len(expiries)))
        for day in sample:
            truth = pick_expiry(load_day(root, "NIFTY", day), "weekly") == day
            if truth != bool(flags[at[day.isoformat()]]):
                raise SystemExit(f"expiry_day disagrees with pick_expiry on {day}: stop")
            checked += 1
        print(
            f"expiry_day {lo}..{hi}: {len(expiries)} of {len(days)} usable sessions are expiry days"
        )
    print(f"expiry_day matches pick_expiry on {checked} sampled sessions")


def summary(rid: str, period: str, result: dict) -> dict:
    from option_backtesting.ruletest import study

    p = result["periods"][period]
    rows = p.get("rows", [])
    mean, t = study.day_t({r["day"]: r["net"] for r in rows})
    random_time = p.get("random_time") or {}
    placebo = p.get("placebo") or {}
    slip = p.get("slippage") or {}
    out = {
        "id": rid,
        "period": period,
        "spec_hash": result["spec_hash"],
        "test_id": result["id"],
        "events": p.get("events", 0),
        "net_mean": mean if rows else None,
        "net_t": t,
        "net_total": p.get("net_total"),
        "win_rate": p.get("win_rate"),
        "random_percentile": random_time.get("event_percentile"),
        "random_mean": random_time.get("mean"),
        "placebo_mean": placebo.get("placebo_mean"),
        "placebo_diff_t": placebo.get("diff_t"),
        "slip_0.5_net_mean": (slip.get("0.5") or {}).get("net_mean"),
        "slip_1_net_mean": (slip.get("1") or {}).get("net_mean"),
    }
    out["thin"] = out["events"] < MIN_EVENTS
    passes = (
        out["net_mean"] is not None
        and out["net_mean"] > 0
        and t is not None
        and t >= T_MIN
        and (out["random_percentile"] or 0) >= PCT_MIN
        and (out["slip_0.5_net_mean"] or -1) > 0
    )
    out["verdict"] = "inconclusive (thin)" if out["thin"] else ("passed" if passes else "killed")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--specs-only", action="store_true", help="validate and read back, run nothing")
    args = ap.parse_args()
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from option_backtesting.ruletest.spec import from_dict, read_back

    bodies = specs()
    if args.specs_only:
        for body in bodies:
            compiled = from_dict(body)
            print(f"\n== {body['id']}  {compiled.spec_hash[:12]}")
            print("\n".join(read_back(compiled)["sentences"]))
        return 0

    from trading_data.db import data_root

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import store, study

    root = data_root()
    OUT.mkdir(parents=True, exist_ok=True)
    frame = F.load_frame(root, "NIFTY", study.PERIODS["learning"][1])
    check_expiry(root, frame, [study.PERIODS["confirmation"], study.PERIODS["learning"]])

    def test(body: dict, period: str) -> dict:
        rid = body["id"]
        options = study.Options(
            periods=(period,),
            workers=args.workers,
            tries=1,
            progress=lambda m: print(f"[{rid} {period}] {m}", flush=True),
        )
        text = yaml.safe_dump({"rule": body}, sort_keys=False)
        result = study.run_test(root, from_dict(body), text, options, frame=frame)
        (OUT / f"{rid}_{period}.json").write_text(json.dumps(result, indent=1, default=str))
        return result

    # step 2: the reproduction check, before anything is revealed
    for body in bodies:
        result = test(body, "learning")
        rows = result["periods"]["learning"]["rows"]
        want = expected(body["id"])
        got_days, want_days = sorted(r["day"] for r in rows), sorted(r["day"] for r in want)
        got_mean = round(sum(r["net"] for r in rows) / max(len(rows), 1))
        want_mean = round(sum(r["net"] for r in want) / max(len(want), 1))
        print(f"{body['id']} learning: {len(rows)} trades, mean ₹{got_mean}; "
              f"BL-164 slice {len(want)} trades, mean ₹{want_mean}")  # fmt: skip
        if got_days != want_days or got_mean != want_mean:
            raise SystemExit(f"{body['id']}: does not reproduce BL-164's slice; nothing revealed")

    # step 3: reveal once and test the confirmation period
    rows_out = []
    for body in bodies:
        spec_hash = from_dict(body).spec_hash
        if not store.is_revealed(root, spec_hash):
            store.reveal(root, spec_hash, note=f"BL-165 {body['id']}: registered confirmation test")
        result = test(body, "confirmation")
        rows_out.append(summary(body["id"], "confirmation", result))
        print(json.dumps(rows_out[-1], default=str), flush=True)
    with (OUT / "summary.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows_out[0]))
        writer.writeheader()
        writer.writerows(rows_out)
    print(f"wrote {OUT}/summary.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
