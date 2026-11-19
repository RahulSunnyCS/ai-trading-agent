"""BL-237: judge the registered rule on results/trades.csv (written by sim.py).

Rule (backlog/BL-237, Phase 0 + amendment 1): per window (fit eve <= 2025-10-08, test after), the two streams pooled
and ordered by eve date; mean net per trade at 0.5% slippage with a 90% two-sided circular block bootstrap (blocks of
5 trades, 2,000 resamples, seed 20261120). Pass only if the pooled lower bound is above zero in BOTH windows and each
stream's mean net is above zero in both windows. Everything else printed is descriptive.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SEED, DRAWS, BLOCK = 20261120, 2000, 5


def load():
    with open(HERE / "results" / "trades.csv") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["eve"] = date.fromisoformat(r["eve"])
        for k, v in r.items():
            if k not in ("eve", "expiry_day", "sold", "bought", "sold_expiry", "bought_expiry", "kind", "window"):
                r[k] = float(v) if v not in ("", None) else float("nan")
    return sorted(rows, key=lambda r: (r["eve"], r["sold"]))


def boot(v: np.ndarray) -> tuple[float, float]:
    n = len(v)
    if n < 2:
        return float("nan"), float("nan")
    rng = np.random.default_rng(SEED)
    k = -(-n // BLOCK)
    starts = rng.integers(0, n, size=(DRAWS, k))
    idx = (starts[:, :, None] + np.arange(BLOCK)[None, None, :]) % n
    means = v[idx.reshape(DRAWS, -1)[:, :n]].mean(axis=1)
    return float(np.percentile(means, 5)), float(np.percentile(means, 95))


def max_dd(v: np.ndarray) -> float:
    if not len(v):
        return 0.0
    cum = np.cumsum(v)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    return float((peak - cum).max())


def line(label: str, v: np.ndarray, with_ci: bool = False) -> str:
    if not len(v):
        return f"  {label:<34} n=0"
    s = f"  {label:<34} n={len(v):>3}  mean {v.mean():>9.0f}  total {v.sum():>10.0f}  worst {v.min():>9.0f}  maxDD {max_dd(v):>9.0f}  win {100 * (v > 0).mean():>3.0f}%"
    if with_ci:
        lo, hi = boot(v)
        s += f"  90% [{lo:.0f}, {hi:.0f}]"
    return s


def main():
    rows = load()
    eve = [r for r in rows if r["kind"] == "eve"]
    placebo = [r for r in rows if r["kind"] == "placebo"]
    skipped = list(csv.reader(open(HERE / "results" / "skipped.csv")))[1:]
    print(f"trades: {len(eve)} eves, {len(placebo)} placebo; skipped {len(skipped)}")
    by_reason = defaultdict(int)
    for _, stream, reason in skipped:
        by_reason[(stream.split("/")[-1] if stream else "-", reason.split(":")[0] if reason.startswith("data_quality") else reason)] += 1
    for k, n in sorted(by_reason.items(), key=lambda kv: -kv[1])[:12]:
        print(f"    skipped {n:>3}: {k[0]} {k[1]}")
    print(f"stale legs (last real bar before 15:20) among eve trades: {int(sum(r['stale_legs'] for r in eve))} of {4 * len(eve) * 2}")

    verdict = {}
    for window in ("fit", "test"):
        w = [r for r in eve if r["window"] == window]
        print(f"\n=== {window.upper()} window: eves {w[0]['eve']} -> {w[-1]['eve']}" if w else f"\n=== {window.upper()}: none")
        pooled = np.array([r["pair_net"] for r in w])
        print(line("PRIMARY pooled net (0.5% slip)", pooled, True))
        for sold in ("NIFTY", "SENSEX"):
            s = np.array([r["pair_net"] for r in w if r["sold"] == sold])
            print(line(f"  {sold}-eve (sell {sold})", s, True))
        lo, _ = boot(pooled)
        stream_means = {sd: float(np.mean([r["pair_net"] for r in w if r["sold"] == sd] or [float('nan')])) for sd in ("NIFTY", "SENSEX")}
        verdict[window] = (lo > 0, all(m > 0 for m in stream_means.values()))
        print(f"  lower bound {lo:.0f} -> {'above zero' if lo > 0 else 'NOT above zero'}; stream means {stream_means}")

    print("\n=== RULE")
    ok = all(a and b for a, b in verdict.values())
    for window, (a, b) in verdict.items():
        print(f"  {window}: pooled lower bound > 0: {a};  both streams' means > 0: {b}")
    print(f"  => {'PASS' if ok else 'KILLED'} on the registered rule")

    print("\n=== DESCRIPTIVE (not rules)")
    for window in ("fit", "test", "all"):
        w = eve if window == "all" else [r for r in eve if r["window"] == window]
        if not w:
            continue
        print(f"-- {window}")
        for label, key in (("pair net, 0.5% slippage", "pair_net"), ("pair net, no slippage", "pair_net_noslip"),
                           ("pair gross, no slippage", "pair_g"), ("sold straddle alone, net 0.5%", "sold_net"),
                           ("bought straddle alone, net 0.5%", "bought_net")):
            print(line(label, np.array([r[key] for r in w])))
        for sd in ("NIFTY", "SENSEX"):
            s = [r for r in w if r["sold"] == sd]
            print(line(f"  sold {sd}: sold leg net", np.array([r["sold_net"] for r in s])))
            print(line(f"  sold {sd}: bought leg net", np.array([r["bought_net"] for r in s])))
    print("-- placebo: the same structure on sessions that are not an eve (sold index's weekly is >1 session away)")
    for window in ("fit", "test"):
        for sd in ("NIFTY", "SENSEX"):
            s = np.array([r["pair_net"] for r in placebo if r["window"] == window and r["sold"] == sd])
            print(line(f"  {window} sell {sd}", s))
    print("-- eve trades by weekday of the eve")
    for wd in range(5):
        s = np.array([r["pair_net"] for r in eve if r["eve"].weekday() == wd])
        if len(s):
            print(line(f"  {['Mon','Tue','Wed','Thu','Fri'][wd]}", s))
    print("-- eve trades by |overnight gap| in the sold index")
    gaps = np.array([abs(r["sold_gap_pct"]) for r in eve])
    nets = np.array([r["pair_net"] for r in eve])
    for lo, hi, name in ((0, 0.25, "0-0.25%"), (0.25, 0.5, "0.25-0.5%"), (0.5, 99, ">0.5%")):
        m = (gaps >= lo) & (gaps < hi) & ~np.isnan(gaps)
        print(line(f"  {name}", nets[m]))
    sp = np.array([(r["sold_CE_in"] + r["sold_PE_in"]) * r["sold_lot"] for r in eve])
    bp = np.array([(r["bought_CE_in"] + r["bought_PE_in"]) * r["bought_lot"] for r in eve])
    print(f"-- mean premium sold Rs {sp.mean():.0f}, bought Rs {bp.mean():.0f} (one straddle, one lot)")
    worst = sorted(eve, key=lambda r: r["pair_net"])[:5]
    print("-- the five worst eve trades: " + "; ".join(f"{r['eve']} sell {r['sold']} {r['pair_net']:.0f} (gap {r['sold_gap_pct']:.2f}%)" for r in worst))


if __name__ == "__main__":
    main()
