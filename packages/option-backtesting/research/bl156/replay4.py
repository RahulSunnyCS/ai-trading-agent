"""BL-156 Amendment 1: T1's (and Core's) Adaptive picks under the four leg-stop x MTM-stop
combinations. Rules: backlog/BL-156-mtm-stop-tick-vs-candle-close.md, Phase 0 Amendment 1.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl156/replay4.py [--workers 6]
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import replay as P  # noqa: E402
import rules as R  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import SIZING_DATE

OUT = Path(__file__).parent / "out"
COMBOS = {  # key -> (leg rule, MTM rule, overshoot)
    "1_leg_close_mtm_close": ("close", "close", 0.0),
    "2_leg_close_mtm_tick": ("close", "tick", 0.02),
    "3_leg_tick_mtm_close": ("tick", "close", 0.0),  # paper today
    "4_leg_tick_mtm_tick": ("tick", "tick", 0.02),  # Quantiply live today
    "2_os0": ("close", "tick", 0.0),
    "2_os5": ("close", "tick", 0.05),
    "4_os0": ("tick", "tick", 0.0),
    "4_os5": ("tick", "tick", 0.05),
}
MAIN = [k for k in COMBOS if k[0] in "1234" and "_os" not in k]
LIVE = "4_leg_tick_mtm_tick"
ALPHA = 0.10
_STRATS: dict = {}


def one_day(args: tuple[str, str, list[str]]) -> dict:
    root_text, day_text, names = args
    root, day = Path(root_text), date.fromisoformat(day_text)
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    data: dict = {}
    rows = {}
    for name in names:
        if name not in _STRATS:
            _STRATS[name] = load_legwise(P.strategy_path(name))
        s = _STRATS[name]
        und = "NIFTY" if name.startswith("N_") else "SENSEX"
        if und not in data:
            try:
                data[und] = load_day(root, und, day)
            except FileNotFoundError as e:
                data[und] = e
        if isinstance(data[und], Exception):
            rows[name] = {"error": str(data[und])}
            continue
        row = {"stored": store.read_net(name, root).get(day)}
        for key, (leg, mtm, os_) in COMBOS.items():
            r = R.simulate(s, data[und], ref, sizing, mtm, os_, leg)
            row[key] = round(r.gross - P.BROKERAGE_ORDER * 2 * len(r.trades), 2)
            row[key + "_gross"] = round(r.gross, 2)
        rows[name] = row
    return {"day": day_text, "rows": rows}


def boot(diff: np.ndarray, rng) -> tuple[float, float, float]:
    n = len(diff)
    means = np.empty(P.RESAMPLES)
    for k in range(P.RESAMPLES):
        starts = rng.integers(0, n, size=int(np.ceil(n / P.BLOCK)))
        ix = ((starts[:, None] + np.arange(P.BLOCK)) % n).reshape(-1)[:n]
        means[k] = diff[ix].mean()
    p = 2 * min((means <= 0).mean(), (means >= 0).mean())
    return float(np.quantile(means, 0.05)), float(np.quantile(means, 0.95)), float(min(p, 1.0))


def holm(ps: dict[str, float]) -> dict[str, bool]:
    out, stop = {}, False
    for k, key in enumerate(sorted(ps, key=ps.get)):
        ok = not stop and ps[key] <= ALPHA / (len(ps) - k)
        stop = stop or not ok
        out[key] = ok
    return out


def summarise(book: str, picks: dict, sims: dict, rng) -> dict:
    days = sorted(picks)
    per = {k: [] for k in COMBOS}
    parity_bad = errors = 0
    for d in days:
        rows = sims[d.isoformat()]["rows"]
        tot = dict.fromkeys(COMBOS, 0.0)
        for name in picks[d]:
            r = rows[name]
            if "error" in r:
                errors += 1
                continue
            if r["stored"] is not None and abs(r["3_leg_tick_mtm_close_gross"] - r["stored"]) > 1:
                parity_bad += 1
            for k in COMBOS:
                tot[k] += r[k]
        for k in COMBOS:
            per[k].append(tot[k])
    a = {k: np.array(v) for k, v in per.items()}
    out = {
        "book": book,
        "days": len(days),
        "pick_errors": errors,
        "parity_mismatches": parity_bad,
        "combos": {
            k: {
                "mean": float(v.mean()),
                "total": float(v.sum()),
                "worst_day": float(v.min()),
                "max_dd": P.max_dd(v),
            }
            for k, v in a.items()
        },
    }
    out["vs_live"] = {}
    for k in MAIN:
        if k == LIVE:
            continue
        lo, hi, p = boot(a[k] - a[LIVE], rng)
        out["vs_live"][k] = {"mean": float((a[k] - a[LIVE]).mean()), "ci90": [lo, hi], "p": p}
    passed = holm({k: v["p"] for k, v in out["vs_live"].items()})
    for k, ok in passed.items():
        out["vs_live"][k]["holm_pass"] = ok
    out["pairwise"] = {}
    for x, y in itertools.combinations(MAIN, 2):
        lo, hi, p = boot(a[x] - a[y], rng)
        out["pairwise"][f"{x} - {y}"] = {
            "mean": float((a[x] - a[y]).mean()),
            "ci90": [lo, hi],
            "p": p,
        }
    c1, c2, c3, c4 = (a[k] for k in MAIN)
    for name, d in (
        ("leg: close - tick", ((c1 - c3) + (c2 - c4)) / 2),
        ("mtm: close - tick", ((c1 - c2) + (c3 - c4)) / 2),
    ):
        lo, hi, p = boot(d, rng)
        out.setdefault("main_effects", {})[name] = {
            "mean": float(d.mean()),
            "ci90": [lo, hi],
            "p": p,
        }
    halves = defaultdict(lambda: defaultdict(list))
    for i, d in enumerate(days):
        for k in MAIN:
            halves[f"{d.year}H{1 if d.month <= 6 else 2}"][k].append(a[k][i] - a[LIVE][i])
    out["vs_live_by_half"] = {
        h: {k: float(np.mean(v)) for k, v in m.items() if k != LIVE} for h, m in halves.items()
    }
    out["sensitivity"] = {k: float(a[k].mean()) for k in COMBOS if "_os" in k}
    sig = {k: v["mean"] for k, v in out["vs_live"].items() if v["holm_pass"]}
    parts = []
    better = [k for k, m in sig.items() if m > 0]
    worse = [k for k, m in sig.items() if m < 0]
    if better:
        parts.append(
            "significant edge over live: " + ", ".join(f"{k} ({sig[k]:+.0f}/day)" for k in better)
        )
    if worse:
        parts.append(
            "significantly worse than live: " + ", ".join(f"{k} ({sig[k]:+.0f}/day)" for k in worse)
        )
    out["verdict"] = (
        "; ".join(parts) if parts else "no significant difference from today's live setting"
    )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    root = data_dir()
    books = {b: P.picks_for(b, root) for b in ("t1", "core")}
    need: dict[str, set[str]] = defaultdict(set)
    for picks in books.values():
        for d, names in picks.items():
            need[d.isoformat()].update(names)
    cache = OUT / "sims4.json"
    sims = json.loads(cache.read_text()) if cache.exists() else {}
    todo = [
        (str(root), d, sorted(n))
        for d, n in sorted(need.items())
        if d not in sims or set(n) - set(sims[d]["rows"])
    ]
    print(f"{len(need)} days; {len(todo)} to simulate", flush=True)
    with ProcessPoolExecutor(args.workers) as ex:
        for k, res in enumerate(ex.map(one_day, todo, chunksize=4)):
            sims.setdefault(res["day"], {"day": res["day"], "rows": {}})["rows"].update(res["rows"])
            if k % 100 == 0:
                cache.write_text(json.dumps(sims))
    cache.write_text(json.dumps(sims))
    rng = np.random.default_rng(P.SEED + 1)
    result = {b: summarise(b, p, sims, rng) for b, p in books.items()}
    (OUT / "result4.json").write_text(json.dumps(result, indent=2))
    for b, r in result.items():
        print(
            f"\n== {b.upper()} ({r['days']} days; pick errors {r['pick_errors']}; paper-vs-stored mismatches {r['parity_mismatches']})"
        )
        for k, v in r["combos"].items():
            print(
                f"  {k:24s} {v['mean']:+7.0f}/day  total {v['total']:+11,.0f}  worst {v['worst_day']:+8,.0f}  max DD {v['max_dd']:+9,.0f}"
            )
        print("  vs live (4):")
        for k, v in r["vs_live"].items():
            print(
                f"    {k:24s} {v['mean']:+6.0f}/day  90% [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}]  p {v['p']:.3f}  Holm {'PASS' if v['holm_pass'] else '-'}"
            )
        for k, v in r["main_effects"].items():
            print(
                f"  main effect {k}: {v['mean']:+.0f}/day  90% [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}]  p {v['p']:.3f}"
            )
        for k, v in r["pairwise"].items():
            print(f"    pair {k}: {v['mean']:+.0f}  [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}]")
        for h, m in r["vs_live_by_half"].items():
            print(f"  {h}: " + ", ".join(f"{k[:1]} {v:+.0f}" for k, v in m.items()))
        print(f"  VERDICT: {r['verdict']}")


if __name__ == "__main__":
    main()
