"""BL-186 Amendment 1: a cheaper (about ₹50) long, the long's stop, and a re-sale toggle. Rules:
backlog/BL-186-dir-stop-and-reverse.md, "Amendment 1" (pre-registered 2026-10-29, before any run).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl186/amend1.py simulate --period main
    ... amend1.py best                         # the best L50 cell on the MAIN period, written once
    ... amend1.py simulate --period main --cells R            # the toggle cells (R-<best>, R-C1_T30)
    ... amend1.py simulate --period holdout                   # every amendment cell, hold-out days
    ... amend1.py report --period main|holdout|full

Reads BL-186's stored simulations (out/sims.jsonl, out/picks.json; the reference cells A5, C1_T30,
C1_HOLD and the carried Widesl / Buy picks are not re-run) and writes out/amend1.jsonl. One worker.
Filter C1 only, the ₹5,000 overall stop, 1 lot, the long's stop and exit as the cell name says.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import run as R  # noqa: E402
import sar  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import SIZING_DATE

OUT = R.OUT
PERIODS = {**R.PERIODS, "full": (R.START, R.END)}
L50_CELLS = ["L50_S30_T30", "L50_S30_HOLD", "L50_S50_T30", "L50_S50_HOLD"]
TOGGLE_FIXED = "R-C1_T30"
REFERENCE = ["A5", "C1_T30", "C1_HOLD", "C2_T30", "C3_T30"]  # BL-186's stored cells
ORIGINAL_PRIMARY = ["C1_T30", "C2_T30", "C3_T30"]
PREMIUM = 50.0


def cell_spec(cell: str) -> dict:
    """The `reverse_on_sl` block of an amendment cell."""
    resell = cell.startswith("R-")
    base = cell.removeprefix("R-")
    if base == "C1_T30":  # BL-186's same-contract C1 cell, re-run with the re-sale
        return {"stop_loss_percent": 30, "time_stop_minutes": 30, "resell_after_reverse": resell}
    _, s, e = base.split("_")
    spec = {"stop_loss_percent": int(s.removeprefix("S")), "strike_premium": PREMIUM}
    if e == "T30":
        spec["time_stop_minutes"] = 30
    if resell:
        spec["resell_after_reverse"] = True
    return spec


def variant(strategy: LegwiseStrategy, cell: str) -> LegwiseStrategy:
    d = strategy.model_dump()
    d["overall"]["stop_loss_inr"] = sar.MAIN_STOP
    for leg in d["legs"]:
        leg["reverse_on_sl"] = {"lots_ratio": 1.0, **cell_spec(cell)}
    return LegwiseStrategy.model_validate(d)


# --- the cache ---------------------------------------------------------------------------------

CACHE = OUT / "amend1.jsonl"


def read_cache() -> dict[tuple[str, str], dict]:
    out = {}
    if CACHE.exists():
        for line in CACHE.read_text().splitlines():
            if line.strip():
                e = json.loads(line)
                out[(e["day"], e["cell"])] = e["rows"]
    return out


def reference_sims() -> dict[date, dict]:
    sims = {}
    for line in (OUT / "sims.jsonl").read_text().splitlines():
        if line.strip():
            e = json.loads(line)
            sims[date.fromisoformat(e["day"])] = e["rows"]
    return sims


def picks_all() -> dict[date, list[str]]:
    return {
        date.fromisoformat(d): n for d, n in json.loads((OUT / "picks.json").read_text()).items()
    }


def best_cell() -> str:
    f = OUT / "amend1_best.json"
    if not f.exists():
        raise SystemExit("the best L50 cell is not chosen yet: run `amend1.py best`")
    return json.loads(f.read_text())["cell"]


def toggle_cells() -> list[str]:
    return [f"R-{best_cell()}", TOGGLE_FIXED]


def new_cells() -> list[str]:
    f = OUT / "amend1_best.json"
    return L50_CELLS + ([f"R-{best_cell()}", TOGGLE_FIXED] if f.exists() else [TOGGLE_FIXED])


# --- simulate ----------------------------------------------------------------------------------


def sim_day_cell(root, d: date, cell: str, dir_names: list[str], ref, sizing, data, feats) -> dict:
    rows = {}
    for name in dir_names:
        s = _load(name)
        und = s.underlying
        if und not in data:
            try:
                data[und] = load_day(root, und, d)
            except FileNotFoundError as e:
                data[und] = e
        if isinstance(data[und], Exception):
            rows[name] = {"error": str(data[und])}
            continue
        if und not in feats:
            feats[und] = sar.DayFeatures(data[und], {})
        sim = sar.FilterSim(variant(s, cell), data[und], ref, sizing, filt="C1", feats=feats[und])
        result = sim.run()
        row = R.record(result, und, d.isoformat(), sim)
        row["allowed"] = sum(1 for _, _, ok in sim.decisions if ok)
        row["skips"] = sum("reverse skipped" in n for n in result.notes)
        rows[name] = row
    return rows


_S: dict = {}


def _load(name: str):
    from adaptive_picks import strategy_path

    if name not in _S:
        _S[name] = load_legwise(strategy_path(name))
    return _S[name]


def cmd_simulate(args) -> None:
    sys.path.insert(0, str(Path(__file__).parent.parent / "common"))
    root = data_dir()
    lo, hi = PERIODS[args.period]
    picks = picks_all()
    ref_sims = reference_sims()
    cells = (
        args.cells.split(",")
        if args.cells and args.cells != "R"
        else toggle_cells()
        if args.cells == "R"
        else new_cells()
    )
    cache = read_cache()
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    days = [d for d in sorted(picks) if lo <= d <= hi]
    todo = [(d, c) for d in days for c in cells if (d.isoformat(), c) not in cache]
    print(f"{args.period}: {len(days)} days x {cells}: {len(todo)} (day, cell) runs", flush=True)
    t0 = time.time()
    by_day = defaultdict(list)
    for d, c in todo:
        by_day[d].append(c)
    with CACHE.open("a") as f:
        for k, (d, cs) in enumerate(sorted(by_day.items())):
            dir_names = [n for n in picks[d] if R.is_dir(n) and "error" not in ref_sims[d][n]]
            data: dict = {}
            feats: dict = {}
            for c in cs:
                rows = sim_day_cell(root, d, c, dir_names, ref, sizing, data, feats)
                f.write(json.dumps({"day": d.isoformat(), "cell": c, "rows": rows}) + "\n")
            f.flush()
            if k % 25 == 0:
                print(f"  {k}/{len(by_day)} {d}  {time.time() - t0:.0f}s", flush=True)
    print(f"done in {time.time() - t0:.0f}s wall (one worker)", flush=True)


# --- the report --------------------------------------------------------------------------------


def book_arrays(period: str, cells: list[str]):
    lo, hi = PERIODS[period]
    picks, ref_sims, cache = picks_all(), reference_sims(), read_cache()
    days = [d for d in sorted(picks) if lo <= d <= hi]
    attrs = store.read_days(data_dir(), "weekdays")
    book = {c: [] for c in cells}
    stat = {c: [] for c in cells}
    slip = {c: [] for c in cells}
    revs = defaultdict(list)  # cell -> net of each long
    rev_pick = defaultdict(float)
    counts = defaultdict(lambda: defaultdict(int))
    expiry_day = []
    dir_picks = 0
    for d in days:
        tot, st, sl = (dict.fromkeys(cells, 0.0) for _ in range(3))
        exp = False
        for name in picks[d]:
            r = ref_sims[d][name]
            if "error" in r:
                continue
            base = r["cells"]["A3"]
            if not R.is_dir(name):
                for c in cells:
                    tot[c] += R.net(base)
                    st[c] += base["stat"]
                continue
            dir_picks += 1
            label = attrs.get(d, {}).get("dte_n" if name.startswith("N_") else "dte_s")
            exp = exp or label == "0"
            for c in cells:
                if c in REFERENCE:
                    x = r["cells"][c]
                else:
                    key = (d.isoformat(), c)
                    if key not in cache:
                        raise SystemExit(f"{c} not simulated for {d}: run `simulate` first")
                    x = cache[key][name]
                tot[c] += R.net(x)
                st[c] += x["stat"]
                counts[c]["mtm_stops"] += x["mtm_stop"]
                counts[c]["leg_stops"] += x["stops"] or 0
                counts[c]["allowed"] += x.get("allowed", 0)
                counts[c]["skips"] += x.get("skips", 0)
                for pnl, value, _reason, _m in x["rev"]:
                    rn = pnl - R.BROKERAGE_ORDER * 2
                    revs[c].append(rn)
                    rev_pick[c] += rn
                    sl[c] += R.SLIP_BUY * value
        expiry_day.append(exp)
        for c in cells:
            book[c].append(tot[c])
            stat[c].append(tot[c] - st[c])
            slip[c].append(tot[c] - sl[c])
    arr = {c: np.array(v) for c, v in book.items()}
    return (
        days,
        arr,
        {c: np.array(v) for c, v in stat.items()},
        {c: np.array(v) for c, v in slip.items()},
        revs,
        rev_pick,
        counts,
        np.array(expiry_day),
        dir_picks,
    )


def cell_stats(x, revs, rev_pick, counts, dir_picks, c, stat, slip, keep) -> dict:
    rv = np.array(revs[c]) if revs[c] else np.array([0.0])
    return {
        "net_day": float(x.mean()),
        "total": float(x.sum()),
        "worst_day": float(x.min()),
        "max_dd": R.max_dd(x),
        "cvar95": R.cvar95(x),
        "ulcer": R.ulcer(x),
        "mtm_stop_rate": counts[c]["mtm_stops"] / dir_picks if dir_picks else 0.0,
        "leg_stops": counts[c]["leg_stops"],
        "c1_allowed": counts[c]["allowed"],
        "skipped_no_strike": counts[c]["skips"],
        "reversals": len(revs[c]),
        "rev_net_per_pick": rev_pick[c] / dir_picks if dir_picks else 0.0,
        "rev_net_per_trade": float(rv.mean()) if revs[c] else None,
        "rev_win_rate": float((rv > 0).mean()) if revs[c] else None,
        "net_day_statutory": float(stat.mean()),
        "net_day_slip1": float(slip.mean()),
        "net_day_ex_expiry": float(x[keep].mean()) if keep.any() else None,
    }


def report(period: str) -> dict:
    cells = REFERENCE + new_cells()
    days, arr, stat, slip, revs, rev_pick, counts, expiry, dir_picks = book_arrays(period, cells)
    keep = ~expiry
    out = {
        "period": period,
        "from": days[0].isoformat(),
        "to": days[-1].isoformat(),
        "days": len(days),
        "dir_pick_days": dir_picks,
        "cells": {
            c: cell_stats(arr[c], revs, rev_pick, counts, dir_picks, c, stat[c], slip[c], keep)
            for c in cells
        },
    }
    rng = np.random.default_rng(R.SEED)
    family = ORIGINAL_PRIMARY + new_cells()
    vs = {}
    for c in family:
        v = R.compare(arr[c] - arr["A5"], rng)
        v["statutory"] = R.compare(stat[c] - stat["A5"], rng)
        v["slip1"] = R.compare(slip[c] - slip["A5"], rng)
        v["ex_expiry"] = R.compare(arr[c][keep] - arr["A5"][keep], rng)
        vs[c] = v
    passed = R.holm({c: v["p"] for c, v in vs.items()}, R.ALPHA)
    for c, v in vs.items():
        v["holm_significant"] = passed[c]
    out["vs_A5"] = vs
    out["family"] = family
    return out


def kill_table(full: dict, holdout: dict) -> dict:
    """The four registered clauses per amendment cell, on the full period."""
    a5 = full["cells"]["A5"]
    out = {}
    for c in new_cells():
        f, v, h = full["cells"][c], full["vs_A5"][c], holdout["vs_A5"][c]
        clauses = {
            "1_long_net_positive": f["rev_net_per_pick"] > 0,
            "2_beats_A5_holm": bool(v["holm_significant"] and v["mean"] > 0),
            "3_drawdown_shallower": f["max_dd"] > a5["max_dd"],
            "4_holdout_not_opposite_sign": h["mean"] >= 0 if v["mean"] > 0 else h["mean"] <= 0,
        }
        out[c] = {**clauses, "survives": all(clauses.values())}
    return out


def print_report(r: dict) -> None:
    print(
        f"== {r['period']} {r['from']} -> {r['to']}: {r['days']} days, {r['dir_pick_days']} Dir pick-days"
    )
    print(
        f"  {'cell':14s} {'net/day':>8s} {'worst':>8s} {'maxDD':>9s} {'CVaR':>8s} {'ulcer':>7s} "
        f"{'stop%':>6s} {'allow':>5s} {'skip':>5s} {'revs':>5s} {'rev/pick':>8s} {'rev/trd':>8s} "
        f"{'win%':>5s} {'stat':>7s} {'slip1':>7s} {'ex-exp':>7s}"
    )
    for c, v in r["cells"].items():
        rt = v["rev_net_per_trade"]
        wr = v["rev_win_rate"]
        print(
            f"  {c:14s} {v['net_day']:+8.0f} {v['worst_day']:+8.0f} {v['max_dd']:+9.0f} "
            f"{v['cvar95']:+8.0f} {v['ulcer']:7.0f} {100 * v['mtm_stop_rate']:5.1f}% "
            f"{v['c1_allowed']:5d} {v['skipped_no_strike']:5d} {v['reversals']:5d} "
            f"{v['rev_net_per_pick']:+8.0f} {(f'{rt:+8.0f}' if rt is not None else '       -')} "
            f"{(f'{100 * wr:4.0f}%' if wr is not None else '    -')} "
            f"{v['net_day_statutory']:+7.0f} {v['net_day_slip1']:+7.0f} "
            f"{(v['net_day_ex_expiry'] or 0):+7.0f}"
        )
    print("  vs A5 (mean daily difference, 90% block-bootstrap interval, Holm over the family):")
    for c, v in r["vs_A5"].items():
        print(
            f"    {c:14s} {v['mean']:+6.0f} [{v['ci90'][0]:+6.0f}, {v['ci90'][1]:+6.0f}] "
            f"p {v['p']:.3f} Holm {'yes' if v['holm_significant'] else 'no '}  "
            f"stat {v['statutory']['mean']:+.0f}  slip1 {v['slip1']['mean']:+.0f}  "
            f"ex-exp {v['ex_expiry']['mean']:+.0f}"
        )


def cmd_parity(args) -> None:
    """The engine after Amendment 1, same-contract cell C1_T30 (no new option set), against BL-186's
    stored C1_T30 and A5-with-the-option-off results: byte-identical behaviour."""
    sys.path.insert(0, str(Path(__file__).parent.parent / "common"))
    root, picks, ref_sims = data_dir(), picks_all(), reference_sims()
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    bad = n = 0
    for d in sorted(picks)[:: max(1, len(picks) // args.days)]:
        names = [x for x in picks[d] if R.is_dir(x) and "error" not in ref_sims[d][x]]
        rows = sim_day_cell(root, d, "C1_T30", names, ref, sizing, {}, {})
        for name, row in rows.items():
            old = ref_sims[d][name]["cells"]["C1_T30"]
            n += 1
            same = (row["gross"], row["n"], row["rev"], row["mtm_stop"]) == (
                old["gross"],
                old["n"],
                old["rev"],
                old["mtm_stop"],
            )
            bad += not same
    print(f"parity vs BL-186's stored C1_T30: {n} Dir pick-days checked, {bad} differ")


def cmd_best(args) -> None:
    f = OUT / "amend1_best.json"
    if f.exists():
        raise SystemExit(f"already chosen: {f.read_text()}")
    days, arr, *_ = book_arrays("main", ["A5", *L50_CELLS])
    diffs = {c: float((arr[c] - arr["A5"]).mean()) for c in L50_CELLS}
    best = max(diffs, key=diffs.get)
    f.write_text(json.dumps({"cell": best, "main_diff_vs_A5": diffs, "period": "main"}, indent=2))
    print("main-period diff vs A5 (₹/day):", {c: round(v) for c, v in diffs.items()})
    print("best:", best)


def cmd_report(args) -> None:
    if args.period in ("holdout", "full") and not (OUT / "amend1_main.json").exists():
        raise SystemExit(
            "report --period main first (the best cell and the toggle are fixed on it)"
        )
    r = report(args.period)
    (OUT / f"amend1_{args.period}.json").write_text(json.dumps(r, indent=2))
    print_report(r)
    if args.period == "full":
        h = json.loads((OUT / "amend1_holdout.json").read_text())
        k = kill_table(r, h)
        (OUT / "amend1_kill.json").write_text(json.dumps(k, indent=2))
        print("  KILL RULE (full period; a cell survives only if all four hold):")
        for c, v in k.items():
            print(f"    {c:14s} {v}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("simulate")
    s.add_argument("--period", choices=sorted(PERIODS), required=True)
    s.add_argument("--cells", help="comma list, or R for the two toggle cells; default all")
    s.set_defaults(fn=cmd_simulate)
    p = sub.add_parser("parity")
    p.add_argument("--days", type=int, default=40)
    p.set_defaults(fn=cmd_parity)
    b = sub.add_parser("best")
    b.set_defaults(fn=cmd_best)
    r = sub.add_parser("report")
    r.add_argument("--period", choices=sorted(PERIODS), required=True)
    r.set_defaults(fn=cmd_report)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
