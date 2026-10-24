"""BL-147 addendum: exit a directional strategy at 14:55 only if its own index is down 0.6% or more.
Rule fixed in the item's Log before this ran. Reads research/bl147/out/deltas.csv (from run.py --stage sim).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl147/conditional.py"""

from __future__ import annotations

import csv
import json
import os
from datetime import date

import numpy as np
from run import OUT, boot_mean, idx_prices, max_dd, picks_dir

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog
from option_backtesting.rotation.variants import track_names, underlying_of, variant_names

THRESHOLD = -0.6
MIN_DAYS = 15


def main() -> None:
    root = data_dir()
    rows = list(csv.DictReader((OUT / "deltas.csv").open()))
    delta = {
        (r["variant"], date.fromisoformat(r["day"])): (float(r["g1528"]), float(r["g1455"]))
        for r in rows
    }
    days = sorted({d for _, d in delta})
    prices = idx_prices(root, set(days))
    prev_close: dict[tuple[str, date], float] = {}
    for u in ("NIFTY", "SENSEX"):
        seq = [d for d in sorted(days) if (u, d) in prices]
        for a, b in zip(seq, seq[1:], strict=False):
            prev_close[(u, b)] = prices[(u, a)][2]

    def move(u: str, d: date, ref: str) -> float | None:
        if (u, d) not in prices:
            return None
        o, p, _ = prices[(u, d)]
        base = o if ref == "open" else prev_close.get((u, d))
        return None if base is None else (p / base - 1) * 100

    rec_core = daylog.reconstruction(root, variant_names())
    rec_t1 = daylog.reconstruction(root, variant_names() + track_names("t1"))
    streams = {"CORE": picks_dir(root, None, rec_core), "T1": picks_dir(root, "t1", rec_t1)}
    res: dict = {"threshold_pct": THRESHOLD}
    for ref in ("open", "prev_close"):
        trig = {
            k: (move(underlying_of(k[0]), k[1], ref) or 0) <= THRESHOLD
            and move(underlying_of(k[0]), k[1], ref) is not None
            for k in delta
        }
        # B: every Dir variant
        by_var: dict[str, list[float]] = {}
        for k, (a, b) in delta.items():
            if trig[k]:
                by_var.setdefault(k[0], []).append(b - a)
        var_means = {n: float(np.mean(v)) for n, v in by_var.items() if v}
        allb = [x for v in by_var.values() for x in v]
        fam = {
            f: [m for n, m in var_means.items() if sel(n)]
            for f, sel in {
                "N_dir": lambda n: n.startswith("N_dir_"),
                "N_ditm1": lambda n: n.startswith("N_ditm1_"),
                "S_dir": lambda n: n.startswith("S_dir_"),
                "S_ditm1": lambda n: n.startswith("S_ditm1_"),
                "T1 Dir": lambda n: "-t1s" in n,
            }.items()
        }
        out: dict = {
            "share_of_variant_days_triggered_pct": round(100 * sum(trig.values()) / len(trig), 1),
            "B": {
                "variants_with_triggered_days": len(var_means),
                "variant_days": len(allb),
                "mean_delta": round(float(np.mean(allb)), 1) if allb else None,
                "share_variants_positive_pct": round(
                    100 * float(np.mean([m > 0 for m in var_means.values()])), 1
                )
                if var_means
                else None,
                "by_family_mean_delta": {
                    f: round(float(np.mean(v)), 1) for f, v in fam.items() if v
                },
            },
        }
        # A: the picks
        pooled: dict[date, list[tuple[float, float, bool]]] = {}
        recs = []
        for key, per in streams.items():
            for d, ns in per.items():
                for n in ns:
                    if (n, d) in delta:
                        a, b = delta[(n, d)]
                        t = trig[(n, d)]
                        pooled.setdefault(d, []).append((a, b, t))
                        recs.append((key, d, n, a, b, t))
        tr = [(k, d, n, a, b) for k, d, n, a, b, t in recs if t]
        deltas_t = np.array([b - a for _, _, _, a, b in tr])
        pdays = sorted(pooled)
        per_day = [
            (sum((b - a) for a, b, t in pooled[d] if t), sum(1 for _, _, t in pooled[d] if t))
            for d in pdays
        ]
        trig_days = [(i, x) for i, x in enumerate(per_day) if x[1] > 0]
        old = np.array([sum(a for a, _, _ in pooled[d]) for d in pdays])
        new = np.array([sum((b if t else a) for a, b, t in pooled[d]) for d in pdays])
        out["A"] = {
            "pick_days": len(recs),
            "triggered_pick_days": len(tr),
            "triggered_days": len(trig_days),
            "mean_delta_triggered": round(float(deltas_t.mean()), 1) if len(deltas_t) else None,
            "share_positive_pct": round(100 * float(np.mean(deltas_t > 0)), 1)
            if len(deltas_t)
            else None,
            "best": round(float(deltas_t.max())) if len(deltas_t) else None,
            "worst": round(float(deltas_t.min())) if len(deltas_t) else None,
            "total_hold_1528": round(float(old.sum())),
            "total_conditional": round(float(new.sum())),
            "max_drawdown_hold": round(max_dd(old)),
            "max_drawdown_conditional": round(max_dd(new)),
            "by_book": {
                k: {
                    "n": int(sum(1 for x in tr if x[0] == k)),
                    "mean_delta": round(
                        float(np.mean([b - a for kk, _, _, a, b in tr if kk == k])), 1
                    ),
                }
                for k in ("CORE", "T1")
                if any(x[0] == k for x in tr)
            },
        }
        verdict: dict = {}
        if len(trig_days) >= MIN_DAYS:
            sub = [per_day[i] for i, _ in trig_days]
            point, lo, hi = boot_mean(sub)
            out["A"]["mean_delta_triggered_interval"] = [
                round(point, 1),
                round(lo, 1),
                round(hi, 1),
            ]
            c1 = lo > 0
            c2 = out["A"]["max_drawdown_conditional"] >= out["A"]["max_drawdown_hold"]
            c3 = (
                out["B"]["share_variants_positive_pct"] is not None
                and out["B"]["share_variants_positive_pct"] >= 60
            )
            verdict = {
                "conditions": {
                    "A interval above zero": bool(c1),
                    "drawdown no deeper": bool(c2),
                    "B >= 60% positive": bool(c3),
                },
                "better": bool(c1 and c2 and c3),
            }
        else:
            verdict = {"better": "too few days"}
        out["verdict"] = verdict
        res[ref] = out
    (OUT / "conditional.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps(res, indent=2, default=float))


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    main()
