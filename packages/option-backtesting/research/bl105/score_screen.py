"""BL-105 Phase 1 scoring: every variant against its own base, per slot, then across slots.

Registered rule (backlog/BL-105 Phase 0), per index x slot x base x variant, the variant's daily
net minus the base's daily net:
  r1  5-day block bootstrap 90 % lower bound of the mean difference > 0
  r2  max drawdown and Ulcer no worse than the base's by more than 10 %
  r3  worst day and sum of the five worst days within 1.5 x the base's (magnitudes floored at
      3,000 / 15,000 as in BL-104's tail gate)
  r4  at least 3 of 4 half-years with a mean not below the base's
A variant passes a slot when r1..r4 hold. An idea setting passes an index when it passes in at
least 4 of the 7 slots for one base (the same parameters in every slot).

    python research/bl105/score_screen.py --tag phase1
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bl104"))
import bl105_grid as g  # noqa: E402
from robust import cscv_pbo  # noqa: E402

from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402

HALVES = (
    (date(2024, 10, 9), date(2025, 3, 31)),
    (date(2025, 4, 1), date(2025, 9, 30)),
    (date(2025, 10, 1), date(2026, 3, 31)),
    (date(2026, 4, 1), date(2026, 10, 9)),
)
FLOORS = {"day": 3000.0, "five": 15000.0}


def ulcer(v: np.ndarray) -> float:
    eq = np.cumsum(v)
    under = eq - np.maximum.accumulate(np.maximum(eq, 0.0))
    return float(np.sqrt((np.minimum(under, 0.0) ** 2).mean())) if v.size else float("nan")


def martin(v: np.ndarray) -> float:
    """Annualised net per lot over the Ulcer index, the BL-104 ranking measure."""
    u = max(1.0, ulcer(v))
    return float(v.mean() * 252 / u)


def neighbours(v: g.Variant, spec: dict[str, g.Variant]) -> list[str]:
    """Registered neighbours: the adjacent registered level / decay, every other setting equal."""

    def adjacent(order: list, value) -> list:
        i = order.index(value)
        return [order[j] for j in (i - 1, i + 1) if 0 <= j < len(order)]

    out: list[str] = []
    if v.kind in ("target", "lock", "locktrail"):
        for lv in adjacent(list(g.LEVELS), v.level):
            out += [x.id for x in spec.values() if x.kind == v.kind and x.level == lv]
    elif v.kind in ("restart_target", "restart_lock"):
        order = list(g.RESTART_LEVELS if v.kind == "restart_target" else g.RESTART_LOCK_LEVELS)
        for lv in adjacent(order, v.level):
            out += [
                x.id
                for x in spec.values()
                if x.kind == v.kind and x.level == lv and x.restarts == v.restarts
            ]
    elif v.kind == "roll":
        decays = list(g.ROLL_REGISTERED["decay"])
        for d in adjacent(decays, v.roll[0]):
            out += [
                x.id
                for x in spec.values()
                if x.kind == "roll" and x.idea == v.idea and x.roll == (d, *v.roll[1:])
            ]
    return out


def five(v: np.ndarray) -> float:
    return float(np.sort(v)[:5].sum())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="phase1")
    args = ap.parse_args()
    out = HERE / "results" / args.tag
    with (out / "summary.csv").open(newline="") as handle:
        summary = {
            (r["index"], r["slot"], r["base"], r["variant"]): r for r in csv.DictReader(handle)
        }
    spec = {v.id: v for v in g.all_variants()}
    rows = []
    pbo_rows = []
    for idx in g.INDICES:
        for slot in g.SLOTS:
            name = f"{idx}_{slot.replace(':', '')}"
            m = np.load(out / "series" / f"{name}.npy").astype(float)
            meta = json.loads((out / "series" / f"{name}.json").read_text())
            col = {lab: i for i, lab in enumerate(meta["labels"])}
            days = np.array([date.fromisoformat(d) for d in meta["days"]])
            for base in sorted({k.split("|")[0] for k in col}):
                for idea in ("B", "B2", "C1"):  # ideas with enough cells for a PBO (>= 6)
                    ids = [i for i, x in spec.items() if x.idea == idea and f"{base}|{i}" in col]
                    if len(ids) >= 6:
                        mat = m[:, [col[f"{base}|{i}"] for i in ids]]
                        pbo_rows.append(
                            {
                                "index": idx,
                                "slot": slot,
                                "base": base,
                                "idea": idea,
                                "cells": len(ids),
                                "pbo8": cscv_pbo(mat, 8)[0],
                            }
                        )
                b = m[:, col[f"{base}|base"]]
                dd_b, ul_b, wd_b, w5_b = max_drawdown(b), ulcer(b), b.min(), five(b)
                for vid in spec:
                    if vid == "base" or f"{base}|{vid}" not in col:
                        continue
                    v = m[:, col[f"{base}|{vid}"]]
                    diff = v - b
                    mean, lo, hi = block_bootstrap_mean(diff)
                    dd_v, ul_v = max_drawdown(v), ulcer(v)
                    r1 = lo > 0
                    r2 = dd_v >= 1.1 * dd_b - 1e-9 and ul_v <= 1.1 * ul_b + 1e-9
                    r3 = v.min() >= -1.5 * max(abs(wd_b), FLOORS["day"]) and five(v) >= -1.5 * max(
                        abs(w5_b), FLOORS["five"]
                    )
                    halves_ok = sum(
                        v[(days >= lo_d) & (days <= hi_d)].mean()
                        >= b[(days >= lo_d) & (days <= hi_d)].mean()
                        for lo_d, hi_d in HALVES
                    )
                    r4 = halves_ok >= 3
                    srow = summary[(idx, slot, base, vid)]
                    rows.append(
                        {
                            "index": idx,
                            "slot": slot,
                            "band": g.band(slot),
                            "base": base,
                            "variant": vid,
                            "idea": spec[vid].idea,
                            "level": spec[vid].level,
                            "restarts": spec[vid].restarts,
                            "base_avg_inr": b.mean(),
                            "var_avg_inr": v.mean(),
                            "diff_mean_inr": mean,
                            "diff_lo90": lo,
                            "diff_hi90": hi,
                            "base_dd": dd_b,
                            "var_dd": dd_v,
                            "base_worst": wd_b,
                            "var_worst": v.min(),
                            "base_worst5": w5_b,
                            "var_worst5": five(v),
                            "martin": martin(v),
                            "base_martin": martin(b),
                            "halves_ok": halves_ok,
                            "cut_rate": float(srow["cut_rate"]),
                            "restarts_made": int(srow["restarts_made"]),
                            "r1": r1,
                            "r2": r2,
                            "r3": r3,
                            "r4": r4,
                            "pass": r1 and r2 and r3 and r4,
                        }
                    )
    fields = list(rows[0])
    with (out / "screen_scored.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} rows to {out / 'screen_scored.csv'}")
    aggregate(rows, pbo_rows, spec, out)


def aggregate(
    rows: list[dict], pbo_rows: list[dict], spec: dict[str, g.Variant], out: Path
) -> None:
    """The registered cross-slot rule: a setting passes an index when, for one base, it passes the
    four per-slot conditions in >= 4 of the 7 slots, its mean gain is >= 25 per lot-day (the kill
    rule), its neighbours' mean Martin is >= 70 % of its own, and the idea's PBO is <= 0.5 where it
    has enough cells to compute one (otherwise 'n/a'). The restart-vs-later-slot comparator of
    Phase 0 is not computed here."""
    by: dict[tuple, list[dict]] = {}
    for r in rows:
        by.setdefault((r["index"], r["base"], r["variant"]), []).append(r)
    mean_martin = {k: float(np.mean([r["martin"] for r in v])) for k, v in by.items()}
    pbo: dict[tuple, float] = {}
    for key in {(p["index"], p["base"], p["idea"]) for p in pbo_rows}:
        pbo[key] = float(
            np.mean([p["pbo8"] for p in pbo_rows if (p["index"], p["base"], p["idea"]) == key])
        )
    out_rows = []
    for (idx, base, vid), rs in sorted(by.items()):
        v = spec[vid]
        slots_pass = sum(bool(r["pass"]) for r in rs)
        gain = float(np.mean([r["diff_mean_inr"] for r in rs]))
        own = mean_martin[(idx, base, vid)]
        nb = [
            mean_martin[(idx, base, n)]
            for n in neighbours(v, spec)
            if (idx, base, n) in mean_martin
        ]
        plateau = bool(nb) and own > 0 and float(np.mean(nb)) >= 0.7 * own
        p = pbo.get((idx, base, v.idea))
        verdict = slots_pass >= 4 and gain >= 25 and plateau and (p is None or p <= 0.5)
        out_rows.append(
            {
                "index": idx,
                "base": base,
                "variant": vid,
                "idea": v.idea,
                "slots_pass": slots_pass,
                "mean_gain_inr": gain,
                "mean_martin": own,
                "neighbour_mean_martin": float(np.mean(nb)) if nb else float("nan"),
                "plateau": plateau,
                "pbo8": "n/a" if p is None else p,
                "passes_rule": verdict,
            }
        )
    with (out / "idea_verdict.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(out_rows[0]))
        w.writeheader()
        w.writerows(out_rows)
    ok = [r for r in out_rows if r["passes_rule"]]
    print(f"registered rule: {len(ok)} of {len(out_rows)} index x base x setting cases pass")
    for r in sorted(out_rows, key=lambda r: (-r["slots_pass"], -r["mean_gain_inr"]))[:6]:
        print(
            f"  {r['index']} {r['base']:14s} {r['variant']:18s} slots {r['slots_pass']}/7 "
            f"gain {r['mean_gain_inr']:6.0f} plateau {r['plateau']} pbo {r['pbo8']}"
        )


if __name__ == "__main__":
    main()
