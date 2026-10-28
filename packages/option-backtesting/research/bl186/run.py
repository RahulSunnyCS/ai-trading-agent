"""BL-186 Phase 2: T1's Adaptive picks with every Dir pick under each arm x exit cell. Rules:
backlog/BL-186-dir-stop-and-reverse.md, Phase 0. Read-only on the data; writes out/ only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl186/run.py simulate [--until D]
    ... run.py report --period main        # 2025-01-10 -> 2026-07-22
    ... run.py report --period holdout     # 2026-07-23 -> 2026-10-22; refused until out/main.json exists

One worker process (owner, 2026-10-28). Simulations are cached in out/sims.jsonl (resumable). Widesl
and Buy picks are run once as their files are (A3) and carried unchanged into every cell.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "common"))
import sar  # noqa: E402
from adaptive_picks import picks_for, strategy_path  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import SIZING_DATE
from option_backtesting.ruletest.charges import EXCHANGE, GST, IPFT_NSE, SEBI, STAMP_BUY, stt_rate

OUT = Path(__file__).parent / "out"
START, END = date(2025, 1, 10), date(2026, 10, 22)
PERIODS = {
    "main": (START, date(2026, 7, 22)),
    "holdout": (date(2026, 7, 23), END),
}
BROKERAGE_ORDER = 20.0 * 1.18  # BL-135 / BL-156: ₹20 + 18% GST an order
BLOCK, RESAMPLES, SEED, ALPHA = 5, 2000, 20261028, 0.10
SLIP_BUY = 0.01


def is_dir(name: str) -> bool:
    family = name.split("_")[1].split("-")[0]
    return family in ("dir", "ditm1")


def statutory(underlying: str, day: str, trades) -> float:
    """BL-063's statutory charges (STT, exchange, SEBI + IPFT, stamp, GST on those), without the
    brokerage, which the ₹20 + GST an order already covers."""
    buy = sell = 0.0
    for t in trades:
        if t.exit_price is None:
            continue
        entry, exit_ = t.entry_price * t.qty, t.exit_price * t.qty
        if t.position == "buy":
            buy, sell = buy + entry, sell + exit_
        else:
            sell, buy = sell + entry, buy + exit_
    both = buy + sell
    exchange = EXCHANGE[underlying] * both
    sebi = SEBI * both + (IPFT_NSE * both if underlying != "SENSEX" else 0.0)
    return stt_rate(day) * sell + exchange + sebi + STAMP_BUY * buy + GST * (exchange + sebi)


def record(result, underlying: str, day: str, sim=None) -> dict:
    rev = [t for t in result.trades if t.leg_id.endswith("_rev")]
    return {
        "gross": round(result.gross, 2),
        "n": len(result.trades),
        "stat": round(statutory(underlying, day, result.trades), 2),
        "mtm_stop": "overall sl" in (result.stopped_by or "").lower(),
        "rev": [
            [round(t.pnl, 2), round(t.entry_price * t.qty, 2), t.exit_reason, t.entry_min]
            for t in rev
        ],
        "stops": len(sim.decisions) if sim is not None else None,
    }


_STRATS: dict = {}


def simulate_day(root: Path, day: date, names: list[str]) -> dict:
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    data: dict = {}
    feats: dict = {}
    rows = {}
    for name in names:
        if name not in _STRATS:
            _STRATS[name] = load_legwise(strategy_path(name))
        s = _STRATS[name]
        und = s.underlying
        if und not in data:
            try:
                data[und] = load_day(root, und, day)
            except FileNotFoundError as e:
                data[und] = e
        if isinstance(data[und], Exception):
            rows[name] = {"error": str(data[und])}
            continue
        row = {"stored": store.read_net(name, root).get(day), "cells": {}}
        if not is_dir(name):
            r = sar.FilterSim(s, data[und], ref, sizing).run()
            row["cells"]["A3"] = record(r, und, day.isoformat())
            rows[name] = row
            continue
        if und not in feats:
            feats[und] = sar.DayFeatures(data[und], sar.chain_volume(root, und, day))
        for cell in sar.cell_names():
            v = sar.variant(s, cell)
            filt = "B" if cell in ("A3", "A5") else sar.parse_cell(cell)[0]
            sim = sar.FilterSim(v, data[und], ref, sizing, filt=filt, feats=feats[und])
            row["cells"][cell] = record(sim.run(), und, day.isoformat(), sim)
        rows[name] = row
    return rows


def cmd_simulate(args) -> None:
    OUT.mkdir(exist_ok=True)
    root = data_dir()
    picks = picks_for("t1", root, START, END, args.until)
    (OUT / "picks.json").write_text(
        json.dumps({d.isoformat(): n for d, n in sorted(picks.items())}, indent=0)
    )
    cache = OUT / "sims.jsonl"
    done = set()
    if cache.exists():
        for line in cache.read_text().splitlines():
            if line.strip():
                done.add(json.loads(line)["day"])
    todo = [d for d in sorted(picks) if d.isoformat() not in done]
    n_dir = sum(is_dir(n) for d in picks for n in picks[d])
    print(f"{len(picks)} days, {n_dir} Dir pick-days; {len(todo)} days to simulate", flush=True)
    with cache.open("a") as f:
        for k, d in enumerate(todo):
            rows = simulate_day(root, d, picks[d])
            f.write(json.dumps({"day": d.isoformat(), "rows": rows}) + "\n")
            f.flush()
            if k % 20 == 0:
                print(f"  {k}/{len(todo)} {d}", flush=True)


# --- the report --------------------------------------------------------------------------------


def net(c: dict) -> float:
    return c["gross"] - BROKERAGE_ORDER * 2 * c["n"]


def max_dd(x: np.ndarray) -> float:
    c = np.cumsum(x)
    return float((c - np.maximum.accumulate(np.r_[0.0, c])[1:]).min())


def cvar95(x: np.ndarray) -> float:
    n = max(1, math.ceil(len(x) * 0.05))
    return float(np.sort(x)[:n].mean())


def ulcer(x: np.ndarray) -> float:
    c = np.cumsum(x)
    under = np.minimum(0.0, c - np.maximum.accumulate(np.r_[0.0, c])[1:])
    return float(math.sqrt((under**2).mean()))


def boot_means(diff: np.ndarray, rng) -> np.ndarray:
    n = len(diff)
    means = np.empty(RESAMPLES)
    for k in range(RESAMPLES):
        starts = rng.integers(0, n, size=int(np.ceil(n / BLOCK)))
        ix = ((starts[:, None] + np.arange(BLOCK)) % n).reshape(-1)[:n]  # circular blocks
        means[k] = diff[ix].mean()
    return means


def compare(diff: np.ndarray, rng) -> dict:
    means = boot_means(diff, rng)
    p = 2 * min((means <= 0).mean(), (means >= 0).mean())
    return {
        "mean": float(diff.mean()),
        "ci90": [float(np.quantile(means, 0.05)), float(np.quantile(means, 0.95))],
        "p": float(min(1.0, p)),
    }


def holm(ps: dict[str, float], alpha: float) -> dict[str, bool]:
    order = sorted(ps, key=ps.get)
    out, still = {}, True
    for i, k in enumerate(order):
        still = still and ps[k] <= alpha / (len(order) - i)
        out[k] = still
    return out


def load(period: str) -> tuple[list[date], dict, dict]:
    lo, hi = PERIODS[period]
    picks = {
        date.fromisoformat(d): n for d, n in json.loads((OUT / "picks.json").read_text()).items()
    }
    sims = {}
    for line in (OUT / "sims.jsonl").read_text().splitlines():
        if line.strip():
            e = json.loads(line)
            sims[date.fromisoformat(e["day"])] = e["rows"]
    days = sorted(d for d in picks if lo <= d <= hi)
    missing = [d for d in days if d not in sims]
    if missing:
        raise SystemExit(f"{len(missing)} days not simulated yet (first {missing[0]})")
    return days, picks, sims


def report(period: str) -> dict:
    days, picks, sims = load(period)
    attrs = store.read_days(data_dir(), "weekdays")
    cells = sar.cell_names()
    book = {c: [] for c in cells}
    book_stat = {c: [] for c in cells}
    book_slip = {c: [] for c in cells}
    rev_net = defaultdict(list)  # cell -> net of each reversal trade
    per_pick_rev = defaultdict(float)
    dir_picks = 0
    mtm_stops = defaultdict(int)
    stops_seen = defaultdict(int)
    errors = parity_bad = parity_n = 0
    expiry_day = []
    for d in days:
        rows = sims[d]
        tot = dict.fromkeys(cells, 0.0)
        stat = dict.fromkeys(cells, 0.0)
        slip = dict.fromkeys(cells, 0.0)
        exp = False
        for name in picks[d]:
            r = rows[name]
            if "error" in r:
                errors += 1
                continue
            base = r["cells"]["A3"]
            if r["stored"] is not None:
                parity_n += 1
                parity_bad += abs(base["gross"] - r["stored"]) > 1
            if not is_dir(name):
                for c in cells:
                    tot[c] += net(base)
                    stat[c] += base["stat"]
                continue
            dir_picks += 1
            label = attrs.get(d, {}).get("dte_n" if name.startswith("N_") else "dte_s")
            exp = exp or label == "0"
            for c in cells:
                x = r["cells"][c]
                tot[c] += net(x)
                stat[c] += x["stat"]
                mtm_stops[c] += x["mtm_stop"]
                stops_seen[c] += x["stops"] or 0
                for pnl, value, _reason, _m in x["rev"]:
                    rn = pnl - BROKERAGE_ORDER * 2
                    rev_net[c].append(rn)
                    per_pick_rev[c] += rn
                    slip[c] += SLIP_BUY * value
        expiry_day.append(exp)
        for c in cells:
            book[c].append(tot[c])
            book_stat[c].append(tot[c] - stat[c])
            book_slip[c].append(tot[c] - slip[c])
    arr = {c: np.array(v) for c, v in book.items()}
    arr_stat = {c: np.array(v) for c, v in book_stat.items()}
    arr_slip = {c: np.array(v) for c, v in book_slip.items()}
    keep = ~np.array(expiry_day)
    out = {
        "period": period,
        "from": days[0].isoformat(),
        "to": days[-1].isoformat(),
        "days": len(days),
        "dir_pick_days": dir_picks,
        "expiry_days_with_dir": int((~keep).sum()),
        "pick_errors": errors,
        "parity": {"checked": parity_n, "mismatches": parity_bad},
        "cells": {},
    }
    for c in cells:
        x = arr[c]
        revs = np.array(rev_net[c]) if rev_net[c] else np.array([0.0])
        out["cells"][c] = {
            "net_day": float(x.mean()),
            "total": float(x.sum()),
            "worst_day": float(x.min()),
            "max_dd": max_dd(x),
            "cvar95": cvar95(x),
            "ulcer": ulcer(x),
            "mtm_stop_rate": mtm_stops[c] / dir_picks if dir_picks else 0.0,
            "leg_stops": stops_seen[c],
            "reversals": len(rev_net[c]),
            "rev_net_per_pick": per_pick_rev[c] / dir_picks if dir_picks else 0.0,
            "rev_net_per_trade": float(revs.mean()) if rev_net[c] else None,
            "rev_win_rate": float((revs > 0).mean()) if rev_net[c] else None,
            "net_day_statutory": float(arr_stat[c].mean()),
            "net_day_slip1": float(arr_slip[c].mean()),
            "net_day_ex_expiry": float(x[keep].mean()) if keep.any() else None,
        }
    rng = np.random.default_rng(SEED)
    prim = {}
    for c in sar.PRIMARY:
        prim[c] = compare(arr[c] - arr["A5"], rng)
    passed = holm({c: v["p"] for c, v in prim.items()}, ALPHA)
    for c, v in prim.items():
        cell = out["cells"][c]
        v["holm_significant"] = passed[c]
        v["beats_net"] = passed[c] and v["mean"] > 0
        v["beats_dd"] = cell["max_dd"] > out["cells"]["A5"]["max_dd"]
        v["rev_positive"] = cell["rev_net_per_pick"] > 0
        v["verdict"] = (
            "kill: the reversal leg nets <= 0 a pick"
            if not v["rev_positive"]
            else "pass"
            if v["beats_net"] and v["beats_dd"]
            else "kill: does not beat A5 on both net a day and max drawdown"
        )
        v["statutory"] = compare(arr_stat[c] - arr_stat["A5"], rng)
        v["slip1"] = compare(arr_slip[c] - arr_slip["A5"], rng)
        v["ex_expiry"] = compare(arr[c][keep] - arr["A5"][keep], rng)
    out["primary"] = prim
    second = {}
    for c in cells:
        if c in ("A5",) or c in sar.PRIMARY:
            continue
        second[c] = compare(arr[c] - arr["A5"], rng)
    out["secondary_vs_A5"] = second
    halves = defaultdict(lambda: defaultdict(list))
    for i, d in enumerate(days):
        h = f"{d.year}H{1 if d.month <= 6 else 2}"
        for c in ("A3", "A5", *sar.PRIMARY, "B_T30"):
            halves[h][c].append(arr[c][i])
    out["by_half"] = {
        h: {c: {"days": len(v), "net_day": float(np.mean(v))} for c, v in hv.items()}
        for h, hv in halves.items()
    }
    return out


def print_report(r: dict) -> None:
    print(
        f"== {r['period']} {r['from']} -> {r['to']}: {r['days']} days, {r['dir_pick_days']} Dir "
        f"pick-days ({r['expiry_days_with_dir']} days with a Dir pick on its expiry); pick errors "
        f"{r['pick_errors']}; A3 vs stored mismatches {r['parity']['mismatches']} of "
        f"{r['parity']['checked']}"
    )
    print(
        f"  {'cell':12s} {'net/day':>8s} {'worst':>8s} {'maxDD':>9s} {'CVaR':>8s} {'ulcer':>8s} "
        f"{'stop%':>6s} {'revs':>5s} {'rev/pick':>9s} {'rev/trade':>9s} {'stat':>8s} {'slip1':>8s} "
        f"{'ex-exp':>8s}"
    )
    for c, v in r["cells"].items():
        rt = v["rev_net_per_trade"]
        print(
            f"  {c:12s} {v['net_day']:+8.0f} {v['worst_day']:+8.0f} {v['max_dd']:+9.0f} "
            f"{v['cvar95']:+8.0f} {v['ulcer']:8.0f} {100 * v['mtm_stop_rate']:5.1f}% "
            f"{v['reversals']:5d} {v['rev_net_per_pick']:+9.0f} "
            f"{(f'{rt:+9.0f}' if rt is not None else '        -')} {v['net_day_statutory']:+8.0f} "
            f"{v['net_day_slip1']:+8.0f} {v['net_day_ex_expiry']:+8.0f}"
        )
    print("  PRIMARY (vs A5, mean daily net of the T1 book, Holm over three at 0.10):")
    for c, v in r["primary"].items():
        print(
            f"    {c}: {v['mean']:+.0f}/day 90% [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}] "
            f"p {v['p']:.3f} Holm {'yes' if v['holm_significant'] else 'no'}; DD better "
            f"{v['beats_dd']}; rev>0 {v['rev_positive']} -> {v['verdict']}"
        )
        for k in ("statutory", "slip1", "ex_expiry"):
            w = v[k]
            print(
                f"      {k:9s} {w['mean']:+.0f} [{w['ci90'][0]:+.0f}, {w['ci90'][1]:+.0f}] "
                f"p {w['p']:.3f}"
            )


def cmd_report(args) -> None:
    if args.period == "holdout" and not (OUT / "main.json").exists():
        raise SystemExit("the hold-out is read only after the main report (out/main.json)")
    r = report(args.period)
    (OUT / f"{args.period}.json").write_text(json.dumps(r, indent=2))
    print_report(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("simulate")
    s.add_argument("--until", type=date.fromisoformat)
    s.set_defaults(fn=cmd_simulate)
    r = sub.add_parser("report")
    r.add_argument("--period", choices=sorted(PERIODS), required=True)
    r.set_defaults(fn=cmd_report)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
