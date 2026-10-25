"""BL-165 exploratory screen (owner override, 2026-10-25): gap-and-go with ₹80 / ₹100 / ₹120 premium
strikes, and next week's options on expiry day. Not a verdict: both periods were already seen for this
family. Every variant is one exploratory test in the rule tester's ledger.

    uv run python research/bl165/screen.py [--workers 6]

Output: out/screen/<id>.json, out/screen/summary.csv (one row per variant and period).
"""

from __future__ import annotations

import argparse
import copy
import csv
import json
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "common"))
from gap_and_go_specs import CONTROL_H1, TEMPLATE, rule  # noqa: E402

OUT = HERE / "out" / "screen"
NOTES = "BL-165 exploratory screen (owner override 2026-10-25); not a verdict"
ON_EXPIRY = {side: {"all": ["expiry_day", cond]} for side, cond in CONTROL_H1.items()}
BOTH = ("learning", "confirmation")


def template(strike: dict, expiry: str) -> dict:
    out = copy.deepcopy(TEMPLATE)
    for leg in out["legs"]:
        leg["strike"], leg["expiry"] = dict(strike), expiry
    return out


def variants() -> list[tuple[dict, tuple[str, ...]]]:
    """(rule, periods) for the 10 registered variants (BL-165 Log, the override entry)."""
    out = []
    for p in (80, 100, 120):
        prem = {"closest_premium": p}
        a = rule(
            f"bl165_s_all_p{p}",
            f"BL-165 screen: H1, ₹{p} premium",
            "h1",
            ("09:46", "12:00"),
            "gap_up",
            CONTROL_H1,
        )
        b = rule(
            f"bl165_s_exp_p{p}",
            f"BL-165 screen: H1 on expiry days, ₹{p} premium",
            {"all": ["h1", "expiry_day"]},
            ("09:46", "12:00"),
            "gap_up",
            ON_EXPIRY,
        )
        out.append(({**a, "template": template(prem, "weekly")}, BOTH))
        out.append(({**b, "template": template(prem, "weekly")}, BOTH))
    for name, strike in (
        ("itm3", {"strike_type": "ITM3"}),
        *((f"p{p}", {"closest_premium": p}) for p in (80, 100, 120)),
    ):
        c = rule(
            f"bl165_s_exp_nw_{name}",
            f"BL-165 screen: H1 on expiry days, next week, {name}",
            {"all": ["h1", "expiry_day"]},
            ("09:46", "12:00"),
            "gap_up",
            ON_EXPIRY,
        )
        out.append(({**c, "template": template(strike, "next_weekly")}, ("learning",)))
    return [({**body, "notes": NOTES}, periods) for body, periods in out]  # fmt: skip


def rows_of(rid: str, result: dict) -> list[dict]:
    from option_backtesting.ruletest import study

    out = []
    for period, p in result["periods"].items():
        rows = p.get("rows", [])
        mean, t = study.day_t({r["day"]: r["net"] for r in rows})
        nets = sorted(r["net"] for r in rows)
        slip = p.get("slippage") or {}
        out.append(
            {
                "id": rid,
                "period": period,
                "test_id": result["id"],
                "events": p.get("events", 0),
                "found": p.get("events_found", 0),
                "win_rate": p.get("win_rate"),
                "net_mean": mean if rows else None,
                "net_t": t,
                "median": nets[len(nets) // 2] if nets else None,
                "mean_without_best3": (sum(nets[:-3]) / (len(nets) - 3)) if len(nets) > 3 else None,
                "slip_0.5_net_mean": (slip.get("0.5") or {}).get("net_mean"),
                "random_percentile": (p.get("random_time") or {}).get("event_percentile"),
                "thin": p.get("events", 0) < 40,
            }
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
    table = []
    for body, periods in variants():
        rid = body["id"]
        options = study.Options(
            periods=periods,
            mode="exploratory",
            workers=args.workers,
            tries=1,
            progress=lambda m, rid=rid: print(f"[{rid}] {m}", flush=True),
        )
        text = yaml.safe_dump({"rule": body}, sort_keys=False)
        result = study.run_test(root, from_dict(body), text, options, frame=frame)
        (OUT / f"{rid}.json").write_text(json.dumps(result, indent=1, default=str))
        table += rows_of(rid, result)
        for row in table[-len(periods) :]:
            print(json.dumps(row, default=str), flush=True)
    with (OUT / "summary.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(table[0]))
        writer.writeheader()
        writer.writerows(table)
    print(f"wrote {OUT}/summary.csv")
    return 0


if __name__ == "__main__":
    sys.exit(main())
