"""BL-222: judge the registered rule on out/table.json."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
TABLE = json.loads((HERE / "out" / "table.json").read_text())
DAYS, T = TABLE["days"], TABLE["table"]
N = len(DAYS)
SEED, DRAWS, PRIMARY = 20261115, 2000, 50


def arm(name):
    return np.array([T[d]["arms"][name]["net"] for d in DAYS])


def count(name, key):
    return int(sum(T[d]["arms"][name][key] for d in DAYS))


state = np.array([T[d]["state"] for d in DAYS])
up = state > 0


def trend_side(x):  # the leg that rises with the trend: up -> CE, down -> PE
    return np.where(up, arm(f"WCE{x}"), arm(f"WPE{x}"))


def counter_side(x):
    return np.where(up, arm(f"WPE{x}"), arm(f"WCE{x}"))


def stats(v):
    cum = np.cumsum(v)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    n5 = np.convolve(v, np.ones(5), "valid")
    return {"mean": v.mean(), "total": v.sum(), "max_dd": float((peak - cum).max()), "worst_day": v.min(), "worst_5d": n5.min()}


def boot(diff, block=5):
    rng = np.random.default_rng(SEED)
    n = len(diff)
    k = -(-n // block)
    starts = rng.integers(0, n, size=(DRAWS, k))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n
    means = diff[idx.reshape(DRAWS, -1)[:, :n]].mean(axis=1)
    return float(np.percentile(means, 5)), float(np.percentile(means, 95))


def main():
    a0 = arm("A0")
    print(f"{N} Dir pick-days; up-trend {up.sum()} ({up.mean() * 100:.0f}%), down {(~up).sum()}; picks: "
          + ", ".join(f"{n}:{c}" for n, c in sorted({(T[d]['name'].split('_')[0] + '_' + T[d]['name'].split('_')[1].split('-')[0]) for d in DAYS} and
                                                     __import__('collections').Counter(T[d]['name'].rsplit('_', 1)[0] for d in DAYS).items())))
    print(f"control mismatches vs stored T1 results: {len(TABLE['control_mismatch'])}")
    s0 = stats(a0)
    print(f"\nA0 (the picks as they are, ₹23.6/order, 0.5% slippage): ₹/day {s0['mean']:.0f}, total {s0['total']:.0f}, maxDD {s0['max_dd']:.0f}, "
          f"worst day {s0['worst_day']:.0f}, worst 5d {s0['worst_5d']:.0f}, orders {count('A0', 'orders')}, stops {count('A0', 'stops')}\n")
    print(f"{'arm':22}{'₹/day':>7}{'vs A0 [5%,95%]':>22}{'maxDD':>9}{'worst':>8}{'worst5d':>9}{'orders':>8}{'stops':>7}")
    rows = {}
    for x in (30, 40, 50):
        for nm, v in ((f"S({x}) both legs", arm(f"S{x}")), (f"W({x}) trend-side leg", trend_side(x)),
                      (f"M({x}) counter-trend leg", counter_side(x))):
            st = stats(v)
            lo, hi = boot(v - a0)
            key = nm.split()[0]
            orders = int(sum(T[d]["arms"][(f"S{x}" if key[0] == "S" else (f"WCE{x}" if (key[0] == "W") == bool(up[i]) else f"WPE{x}"))]["orders"] for i, d in enumerate(DAYS)))
            stops = int(sum(T[d]["arms"][(f"S{x}" if key[0] == "S" else (f"WCE{x}" if (key[0] == "W") == bool(up[i]) else f"WPE{x}"))]["stops"] for i, d in enumerate(DAYS)))
            print(f"{('*' if (x == PRIMARY and key[0] == 'W') else ' ')}{nm:21}{st['mean']:>7.0f}{(v - a0).mean():>9.0f} [{lo:>5.0f},{hi:>5.0f}]{st['max_dd']:>9.0f}{st['worst_day']:>8.0f}{st['worst_5d']:>9.0f}{orders:>8}{stops:>7}")
            rows[nm] = (st, (v - a0).mean(), lo, hi)
    x = PRIMARY
    w, s, a = trend_side(x), arm(f"S{x}"), a0
    lo_a0, _ = boot(w - a)
    lo_s, hi_s = boot(w - s)
    p_up = float(up.mean())
    rng = np.random.default_rng(SEED)
    pl = np.array([np.where(rng.random(N) < p_up, arm(f"WCE{x}"), arm(f"WPE{x}")).mean() for _ in range(DRAWS)])
    pct = float((pl < w.mean()).mean())
    edges = np.linspace(0, N, 5).astype(int)
    blocks = [(float(w[a_:b].mean()), float(a[a_:b].mean())) for a_, b in zip(edges[:-1], edges[1:], strict=True)]
    q_ok = sum(1 for wv, av in blocks if wv > av)
    print(f"\nPRIMARY W({x}) vs S({x}): {(w - s).mean():.0f} [{lo_s:.0f}, {hi_s:.0f}]; placebo trend mean {pl.mean():.0f} "
          f"(5-95% {np.percentile(pl, 5):.0f}..{np.percentile(pl, 95):.0f}); W beats {pct * 100:.1f}% of draws")
    print("four blocks (W ₹/day, A0 ₹/day):", [(round(p), round(q)) for p, q in blocks])
    sw, sa = stats(w), stats(a)
    rule = {"i_beats_A0": lo_a0 > 0, "i_beats_S": lo_s > 0, "ii_placebo_95": pct >= 0.95, "iii_blocks_3_of_4": q_ok >= 3,
            "iv_dd_and_worst5d_le_A0": sw["max_dd"] <= sa["max_dd"] and sw["worst_5d"] >= sa["worst_5d"]}
    print("\nREGISTERED RULE (primary X = 50):")
    for k, v in rule.items():
        print(f"  {k}: {'PASS' if v else 'FAIL'}")
    print("VERDICT:", "ADVANCE to confirmation" if all(rule.values()) else "KILLED (no candidate)")
    # splits by state, primary
    for nm, m in (("up-trend days (CE wide)", up), ("down-trend days (PE wide)", ~up)):
        print(f"  {nm}: {m.sum()} days, W(50) minus A0 {(w - a)[m].mean():.0f}/day, A0 {a[m].mean():.0f}/day, W {w[m].mean():.0f}/day")
    with open(HERE / "out" / "verdict.json", "w") as fh:
        json.dump({"rule": rule, "placebo_pct": pct}, fh, default=float)


if __name__ == "__main__":
    main()
