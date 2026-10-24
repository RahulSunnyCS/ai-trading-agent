"""BL-156 Phase 2: T1's (and Core's) Adaptive picks under the two overall-stop rules. Rules:
backlog/BL-156-mtm-stop-tick-vs-candle-close.md, Phase 0. Read-only on the data; writes out/ only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl156/replay.py [--workers 6] [--until D]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import rules as R  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import journal, store
from option_backtesting.rotation.lists import SIZING_DATE, WARMUP
from option_backtesting.rotation.pick import History, score_history
from option_backtesting.rotation.variants import (
    STRATEGIES_DIR,
    TRACK_DIRS,
    track_names,
    track_of,
    variant_names,
)

OUT = Path(__file__).parent / "out"
START, END = date(2025, 1, 10), date(2026, 10, 22)
JOURNAL_FROM = {"t1": date(2026, 10, 19), "core": date(2026, 10, 12)}
BROKERAGE_ORDER = 20.0 * 1.18
VARIANTS = {  # name -> (rule, overshoot)
    "close": ("close", 0.0),
    "tick": ("tick", 0.02),
    "tick_os0": ("tick", 0.0),
    "tick_os5": ("tick", 0.05),
    "tick_pess": ("tick_pess", 0.02),
    "close5": ("close5", 0.0),
}
BLOCK, RESAMPLES, SEED = 5, 2000, 20261023


def strategy_path(name: str) -> Path:
    track = track_of(name)
    return (TRACK_DIRS[track] if track else STRATEGIES_DIR) / f"{name}.yaml"


def picks_for(book: str, root: Path, until: date | None = None) -> dict[date, list[str]]:
    names = variant_names() + (track_names("t1") if book == "t1" else [])
    m = store.load_matrix(names, root)
    attrs = store.read_days(root, "weekdays")
    keep = [i for i, d in enumerate(m.days) if d in attrs and (until is None or d <= until)]
    days = [m.days[i] for i in keep]
    values = m.values[keep]
    recorded = {
        date.fromisoformat(e["day"]): e["lists"]["C"]
        for e in journal.read(store.journal_path(root, "t1" if book == "t1" else None))
    }
    out = {}
    for i, d in enumerate(days):
        if not (START <= d <= END) or i < WARMUP:
            continue
        if d >= JOURNAL_FROM[book] and d in recorded:
            c = recorded[d]
        else:
            a = attrs[d]
            hist = History(
                days[:i],
                list(m.names),
                values[:i],
                [attrs[x]["weekday"] for x in days[:i]],
                [attrs[x]["vix_band"] for x in days[:i]],
                [attrs[x]["dte_n"] for x in days[:i]],
                [attrs[x]["dte_s"] for x in days[:i]],
                "",
            )
            vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "") else None
            c = score_history(hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]})["C"]
        out[d] = list(c["core"]) + list(c.get("buy") or [])
    return out


_STRATS: dict = {}


def one_day(args: tuple[str, str, list[str]]) -> dict:
    root_text, day_text, names = args
    root, day = Path(root_text), date.fromisoformat(day_text)
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    stored = {
        n: g for n in names for d0, g in [(day, store.read_net(n, root).get(day))] if g is not None
    }
    data: dict = {}
    rows = {}
    for name in names:
        if name not in _STRATS:
            _STRATS[name] = load_legwise(strategy_path(name))
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
        row = {"has_stop": s.overall.stop_loss_inr is not None, "stored_net": stored.get(name)}
        for key, (rule, os_) in VARIANTS.items():
            r = R.simulate(s, data[und], ref, sizing, rule, os_)
            row[key] = round(r.gross - BROKERAGE_ORDER * 2 * len(r.trades), 2)
            row[key + "_gross"] = round(r.gross, 2)
            row[key + "_stop"] = r.stopped_by or ""
        rows[name] = row
    return {"day": day_text, "rows": rows}


def block_ci(diff: np.ndarray, rng) -> tuple[float, float]:
    n = len(diff)
    means = np.empty(RESAMPLES)
    for k in range(RESAMPLES):
        starts = rng.integers(0, n, size=int(np.ceil(n / BLOCK)))
        ix = ((starts[:, None] + np.arange(BLOCK)) % n).reshape(-1)[:n]  # circular blocks
        means[k] = diff[ix].mean()
    return float(np.quantile(means, 0.05)), float(np.quantile(means, 0.95))


def max_dd(x: np.ndarray) -> float:
    c = np.cumsum(x)
    return float((c - np.maximum.accumulate(np.r_[0.0, c])[1:]).min())


def summarise(book: str, picks: dict[date, list[str]], sims: dict[str, dict], rng) -> dict:
    days = sorted(picks)
    per = {k: [] for k in VARIANTS}
    differ = errors = parity_bad = 0
    for d in days:
        rows = sims[d.isoformat()]["rows"]
        tot = dict.fromkeys(VARIANTS, 0.0)
        for name in picks[d]:
            r = rows[name]
            if "error" in r:
                errors += 1
                continue
            if r["stored_net"] is not None and abs(r["close_gross"] - r["stored_net"]) > 1:
                parity_bad += 1
            for k in VARIANTS:
                tot[k] += r[k]
        differ += abs(tot["close"] - tot["tick"]) > 0.5
        for k in VARIANTS:
            per[k].append(tot[k])
    arr = {k: np.array(v) for k, v in per.items()}
    out = {
        "book": book,
        "days": len(days),
        "days_rules_differ": differ,
        "pick_errors": errors,
        "parity_mismatches": parity_bad,
        "rules": {},
    }
    for k, x in arr.items():
        out["rules"][k] = {
            "mean": float(x.mean()),
            "total": float(x.sum()),
            "worst_day": float(x.min()),
            "max_dd": max_dd(x),
        }
    for k in ("tick", "tick_os0", "tick_os5", "tick_pess", "close5"):
        d = arr["close"] - arr[k]
        lo, hi = block_ci(d, rng)
        out[f"close_minus_{k}"] = {"mean": float(d.mean()), "ci90": [lo, hi]}
    halves = defaultdict(list)
    for d, c, t in zip(days, arr["close"], arr["tick"], strict=True):
        halves[f"{d.year}H{1 if d.month <= 6 else 2}"].append(c - t)
    out["close_minus_tick_by_half"] = {
        h: {"days": len(v), "mean": float(np.mean(v))} for h, v in halves.items()
    }
    lo, hi = out["close_minus_tick"]["ci90"]
    out["verdict"] = (
        "candle close better" if lo > 0 else "tick better" if hi < 0 else "no meaningful difference"
    )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument(
        "--until", type=date.fromisoformat, help="last day (2026-10-22 = the registered run)"
    )
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    root = data_dir()
    books = {b: picks_for(b, root, args.until) for b in ("t1", "core")}
    need: dict[str, set[str]] = defaultdict(set)
    for picks in books.values():
        for d, names in picks.items():
            need[d.isoformat()].update(names)
    print(
        f"{len(need)} days, {sum(len(v) for v in need.values())} strategy-days to simulate",
        flush=True,
    )
    cache = OUT / "sims.json"
    sims = json.loads(cache.read_text()) if cache.exists() else {}
    todo = [
        (str(root), d, sorted(n))
        for d, n in sorted(need.items())
        if d not in sims or set(n) - set(sims[d]["rows"])
    ]
    with ProcessPoolExecutor(args.workers) as ex:
        for k, res in enumerate(ex.map(one_day, todo, chunksize=4)):
            prev = sims.get(res["day"], {"day": res["day"], "rows": {}})
            prev["rows"].update(res["rows"])
            sims[res["day"]] = prev
            if k % 50 == 0:
                print(f"  {k}/{len(todo)} {res['day']}", flush=True)
                cache.write_text(json.dumps(sims))
    cache.write_text(json.dumps(sims))
    rng = np.random.default_rng(SEED)
    result = {b: summarise(b, p, sims, rng) for b, p in books.items()}
    (OUT / "result.json").write_text(json.dumps(result, indent=2))
    for b, r in result.items():
        print(
            f"\n== {b.upper()} ({r['days']} days; rules differ on {r['days_rules_differ']}; "
            f"pick errors {r['pick_errors']}; close-vs-stored mismatches {r['parity_mismatches']})"
        )
        for k, v in r["rules"].items():
            print(
                f"  {k:10s} mean {v['mean']:+8.0f}/day  total {v['total']:+11,.0f}  worst {v['worst_day']:+8,.0f}  max DD {v['max_dd']:+10,.0f}"
            )
        for k in ("tick", "tick_os0", "tick_os5", "tick_pess", "close5"):
            v = r[f"close_minus_{k}"]
            print(
                f"  close - {k:9s}: {v['mean']:+7.0f}/day  90% [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}]"
            )
        print(
            "  close - tick by half: "
            + ", ".join(
                f"{h} {v['mean']:+.0f} ({v['days']}d)"
                for h, v in r["close_minus_tick_by_half"].items()
            )
        )
        print(f"  VERDICT: {r['verdict']}")


if __name__ == "__main__":
    main()
