import json
import sys
from pathlib import Path

import numpy as np

D = json.loads(Path(sys.argv[1]).read_text())
R = D["R"]
ser = D["ser"]


def feats(sym):
    ds = sorted(R[sym])
    rng = np.array([R[sym][d]["rng"] for d in ds])
    f = {}
    for i, d in enumerate(ds):
        if i < 120:
            continue
        p5 = rng[i - 5 : i].mean()
        med = np.median(rng[i - 120 : i])
        f[d] = dict(
            today=rng[i], prev1=rng[i - 1], prev5=p5, ratio=p5 / med, move=R[sym][d]["move"]
        )
    return f


F = {s: feats(s) for s in R}


def corr(a, b):
    return np.corrcoef(a, b)[0, 1]


print("== A. Is today's range predictable from previous days? (NIFTY, 09:17-15:29, % of open)")
for lo, lab in (("2016-01-01", "2016-2026"), ("2024-11-01", "last 2 years")):
    ds = [d for d in F["NIFTY"] if d >= lo]
    t = np.array([F["NIFTY"][d]["today"] for d in ds])
    p1 = np.array([F["NIFTY"][d]["prev1"] for d in ds])
    p5 = np.array([F["NIFTY"][d]["prev5"] for d in ds])
    print(
        f"{lab}: days {len(ds)} avg range {t.mean():.2f}% | corr with yesterday {corr(t, p1):.2f} | with last-5 avg {corr(t, p5):.2f}"
    )
    q = np.quantile(p5, [1 / 3, 2 / 3])
    for name, m in (
        ("calm last 5", p5 <= q[0]),
        ("normal", (p5 > q[0]) & (p5 <= q[1])),
        ("wide last 5", p5 > q[1]),
    ):
        print(
            f"   {name:12s} (last-5 {p5[m].min():.2f}-{p5[m].max():.2f}%): today avg {t[m].mean():.2f}%, today wide (top third) {100 * np.mean(t[m] > np.quantile(t, 2 / 3)):.0f}%"
        )
print()


def buckets(vals, key, sym="NIFTY", cuts=None, lo="2024-11-01"):
    ds = [d for d in vals if d in F[sym] and d >= lo]
    x = np.array([F[sym][d][key] for d in ds])
    y = np.array([vals[d] for d in ds])
    cuts = cuts if cuts is not None else np.quantile(x, [1 / 3, 2 / 3])
    res = []
    for m in (x <= cuts[0], (x > cuts[0]) & (x <= cuts[1]), x > cuts[1]):
        res.append((m.sum(), y[m].mean(), 100 * np.mean(y[m] > 0)))
    return res, cuts, corr(x, y)


print(
    "== B. Books' daily net (paper, 1 lot/strategy, 0.5% slip) by NIFTY range, 2024-11 -> 2026-11"
)
for key, lab in (
    ("today", "TODAY's range (hindsight, not usable)"),
    ("prev5", "LAST-5-DAY range (known before 09:17)"),
    ("ratio", "last-5 vs its 120-day median (known before)"),
):
    print(" ", lab)
    for b in ("core", "t1", "base"):
        res, cuts, r = buckets(ser[b], key)
        print(
            f"    {b:5s} corr {r:+.2f} | low: n={res[0][0]} avg {res[0][1]:+.0f} win {res[0][2]:.0f}% | mid: avg {res[1][1]:+.0f} win {res[1][2]:.0f}% | high: avg {res[2][1]:+.0f} win {res[2][2]:.0f}%   cuts {cuts[0]:.2f}/{cuts[1]:.2f}"
        )
Path(sys.argv[2]).write_text(json.dumps({k: {d: v for d, v in F[k].items()} for k in F}))
