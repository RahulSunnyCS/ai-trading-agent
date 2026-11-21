import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store, variants

root = data_dir()
F = json.loads(Path(sys.argv[1]).read_text())
names = variants.variant_names()


def fam(n):
    idx, rest = n.split("_", 1)
    parts = rest.split("_")
    b = parts[0]
    sub = parts[1] if len(parts) > 2 else ""
    if b == "widesl":
        b = "widesl_p" if sub.startswith("p") else "widesl_strike"
    return idx, b


print(Counter(fam(n) for n in names))
agg = defaultdict(lambda: defaultdict(list))  # (idx,fam) -> day -> nets
with store.slipped(0.5):
    for n in names:
        idx, f = fam(n)
        for d, v in store.read_net(n, root).items():
            ds = str(d)
            if ds >= "2024-11-01":
                agg[(idx, f)][ds].append(v)
sym = {"N": "NIFTY", "S": "SENSEX"}
print(
    "\n== C. Average one-lot net per strategy, by family and the index's LAST-5-DAY range (known before 09:17), 2024-11 -> 2026-11"
)
for idx in ("N", "S"):
    allx = np.array([F[sym[idx]][d]["prev5"] for d in F[sym[idx]] if d >= "2024-11-01"])
    cuts = np.quantile(allx, [1 / 3, 2 / 3])
    print(f" {sym[idx]} cuts {cuts[0]:.2f}% / {cuts[1]:.2f}%")
    for (i, f), days in sorted(agg.items()):
        if i != idx:
            continue
        row = []
        for k in range(3):
            v = [
                np.mean(x)
                for d, x in days.items()
                if d in F[sym[idx]]
                and (
                    k == 0
                    and F[sym[idx]][d]["prev5"] <= cuts[0]
                    or k == 1
                    and cuts[0] < F[sym[idx]][d]["prev5"] <= cuts[1]
                    or k == 2
                    and F[sym[idx]][d]["prev5"] > cuts[1]
                )
            ]
            row.append(f"{np.mean(v):+5.0f} win {100 * np.mean(np.array(v) > 0):3.0f}% n{len(v)}")
        print(f"   {f:14s} low: {row[0]} | mid: {row[1]} | high: {row[2]}")
