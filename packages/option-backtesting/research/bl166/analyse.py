"""BL-166: stop rates, matched stops and the pre-registered comparisons.

    uv run python research/bl166/analyse.py [--out research/bl166/results/analysis.json]

Reads research/bl166/results/*.csv (from run_batch.py). Every rule is the one in the backlog item's
Phase 0; nothing here is tuned. Needs numpy only.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.rotation import lot_plans, readout

HERE = Path(__file__).parent
FIT_END = date(2025, 10, 8)
STOPS = (3000, 4000, 5000, 6000, 8000, 10000)
SEED, RESAMPLES, BLOCK, LEVEL = 20261026, 2000, 5, 0.90
NAME = re.compile(r"^(?P<i>[NS])_(?P<fam>dir|ditm1|ditm2|ditm3)_s(?P<stop>\d+)_(?P<slot>\d{4})$")


def load() -> dict[tuple, dict[date, dict]]:
    out: dict[tuple, dict[date, dict]] = {}
    for path in sorted((HERE / "results").glob("*.csv")):
        m = NAME.match(path.stem)
        if not m:
            continue
        rows: dict[date, dict] = {}
        with path.open() as f:
            for r in csv.DictReader(f):
                n = int(float(r["n_trades"] or 0))
                gross = float(r["gross"])
                rows[date.fromisoformat(r["day"])] = {
                    "traded": n > 0,
                    "net": gross - lot_plans.brokerage(n),
                    "gross": gross,
                    "worst": float(r["worst_mtm"] or 0.0),
                    "stop": (r["stopped_by"] or "").lower().startswith("overall sl"),
                }
        out[(m["i"], m["fam"], int(m["stop"]), m["slot"])] = rows
    return out


def in_period(day: date, period: str) -> bool:
    return {"fit": day <= FIT_END, "hold": day > FIT_END, "all": True}[period]


def stop_rate(data, idx, fam, stop, period) -> tuple[float, int]:
    hits = total = 0
    for (i, f, s, _), rows in data.items():
        if (i, f, s) != (idx, fam, stop):
            continue
        for d, r in rows.items():
            if r["traded"] and in_period(d, period):
                total += 1
                hits += r["stop"]
    return (hits / total if total else float("nan")), total


def daily_series(data, idx, fam, stop, period) -> dict[date, float]:
    by_day: dict[date, list[float]] = defaultdict(list)
    for (i, f, s, _), rows in data.items():
        if (i, f, s) != (idx, fam, stop):
            continue
        for d, r in rows.items():
            if r["traded"] and in_period(d, period):
                by_day[d].append(r["net"])
    return {d: float(np.mean(v)) for d, v in by_day.items()}


def max_drawdown(series: dict[date, float]) -> float:
    cum = np.cumsum([series[d] for d in sorted(series)])
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    return float((peak - cum).max()) if cum.size else float("nan")


def compare(data, idx, fam_a, stop_a, fam_b, stop_b, period) -> dict:
    a, b = (
        daily_series(data, idx, fam_a, stop_a, period),
        daily_series(data, idx, fam_b, stop_b, period),
    )
    days = sorted(set(a) & set(b))
    diff = np.array([a[d] - b[d] for d in days])
    if diff.size == 0:
        return {"n": 0}
    mean, lo, hi = readout.block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
    return {"n": int(diff.size), "mean": mean, "lower": lo, "upper": hi,
            "a_mean": float(np.mean([a[d] for d in days])), "b_mean": float(np.mean([b[d] for d in days])),
            "a_dd": max_drawdown({d: a[d] for d in days}), "b_dd": max_drawdown({d: b[d] for d in days})}  # fmt: skip


def slots_beating(data, idx, k, stop, period) -> tuple[int, int]:
    wins = total = 0
    slots = sorted({s for (i, f, st, s) in data if i == idx and f == f"ditm{k}" and st == stop})
    for slot in slots:
        a, b = data.get((idx, f"ditm{k}", stop, slot)), data.get((idx, "ditm1", 3000, slot))
        if not a or not b:
            continue
        days = [
            d for d in a if d in b and a[d]["traded"] and b[d]["traded"] and in_period(d, period)
        ]
        if not days:
            continue
        total += 1
        wins += np.mean([a[d]["net"] - b[d]["net"] for d in days]) > 0
    return int(wins), total


def main() -> None:
    data = load()
    out: dict = {"variants": len(data), "indices": {}}
    for idx in ("N", "S"):
        block: dict = {"stop_rates": {}, "no_trade_share": {}, "matched": {}, "primary": {},
                       "secondary_same_stop": {}, "grid_net": {}}  # fmt: skip
        fams = (("dir", 3000), ("ditm1", 3000)) + tuple(
            (f"ditm{k}", s) for k in (2, 3) for s in STOPS
        )
        for fam, stop in fams:
            block["stop_rates"][f"{fam}@{stop}"] = {
                p: stop_rate(data, idx, fam, stop, p) for p in ("fit", "hold", "all")
            }
            traded = total = 0
            for (i, f, s, _), rows in data.items():
                if (i, f, s) == (idx, fam, stop):
                    total += len(rows)
                    traded += sum(r["traded"] for r in rows.values())
            block["no_trade_share"][f"{fam}@{stop}"] = 1 - traded / total if total else None
        target = max(
            block["stop_rates"]["dir@3000"]["fit"][0], block["stop_rates"]["ditm1@3000"]["fit"][0]
        )
        for k in (2, 3):
            rates = {s: block["stop_rates"][f"ditm{k}@{s}"]["fit"][0] for s in STOPS}
            ok = [s for s in STOPS if rates[s] <= target]
            matched, flagged = (ok[0], False) if ok else (STOPS[-1], True)
            block["matched"][f"ditm{k}"] = {"target": target, "matched_stop": matched,
                                            "not_matched": flagged, "fit_rate_at_3000": rates[3000]}  # fmt: skip
            res = {
                p: compare(data, idx, f"ditm{k}", matched, "ditm1", 3000, p)
                for p in ("fit", "hold", "all")
            }
            hold, fit = res["hold"], res["fit"]
            verdict = "inconclusive"
            if hold.get("n"):
                if hold["mean"] <= 0:
                    verdict = "kill"
                elif hold["lower"] > 0 and fit["mean"] > 0 and hold["a_dd"] <= 1.25 * hold["b_dd"]:
                    verdict = "pass"
            block["primary"][f"ditm{k}"] = {**res, "verdict": verdict,
                                            "slots_beating_hold": slots_beating(data, idx, k, matched, "hold")}  # fmt: skip
            block["secondary_same_stop"][f"ditm{k}"] = {
                p: compare(data, idx, f"ditm{k}", 3000, "ditm1", 3000, p)
                for p in ("fit", "hold", "all")
            }
            block["grid_net"][f"ditm{k}"] = {
                str(s): {p: (lambda ser: float(np.mean(list(ser.values()))) if ser else None)(
                    daily_series(data, idx, f"ditm{k}", s, p)) for p in ("fit", "hold")} for s in STOPS
            }  # fmt: skip
        for fam in ("dir", "ditm1"):
            ser = {p: daily_series(data, idx, fam, 3000, p) for p in ("fit", "hold")}
            block["grid_net"][fam] = {p: float(np.mean(list(v.values()))) for p, v in ser.items()}
            block["grid_net"][f"{fam}_dd_hold"] = max_drawdown(ser["hold"])
        out["indices"][idx] = block
    path = (
        Path(sys.argv[sys.argv.index("--out") + 1])
        if "--out" in sys.argv
        else HERE / "results" / "analysis.json"
    )
    path.write_text(json.dumps(out, indent=1, default=str))
    for idx, b in out["indices"].items():
        name = {"N": "NIFTY", "S": "SENSEX"}[idx]
        print(f"=== {name}")
        print("stop rate (share of variant-days the overall stop fired), fit / hold-out:")
        for key, v in b["stop_rates"].items():
            print(
                f"  {key:14} fit {v['fit'][0]:6.1%} (n {v['fit'][1]:5})  hold {v['hold'][0]:6.1%} (n {v['hold'][1]:5})"
            )
        for k in ("ditm2", "ditm3"):
            m, p = b["matched"][k], b["primary"][k]
            print(
                f"{k}: target {m['target']:.1%}, matched stop {m['matched_stop']}{' (NOT MATCHED)' if m['not_matched'] else ''}"
            )
            for per in ("fit", "hold", "all"):
                r = p[per]
                print(f"   {per:4} vs ITM1@3000: n {r['n']}, diff {r['mean']:+.0f} [{r['lower']:+.0f}, {r['upper']:+.0f}]  "
                      f"{k} {r['a_mean']:+.0f} vs ITM1 {r['b_mean']:+.0f}, dd {r['a_dd']:.0f} vs {r['b_dd']:.0f}")  # fmt: skip
            print(
                f"   verdict {p['verdict']}; slots beating ITM1 on hold-out {p['slots_beating_hold']}"
            )


if __name__ == "__main__":
    main()
