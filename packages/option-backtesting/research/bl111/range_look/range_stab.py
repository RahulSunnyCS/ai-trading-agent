import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

from option_backtesting.rotation import store, variants

F = json.loads(Path(sys.argv[1]).read_text())
names = [n for n in variants.variant_names()]


def fam(n):
    idx, rest = n.split("_", 1)
    return idx, rest.split("_")[0]


periods = [
    (
        "2021-11-01",
        "2023-10-31",
        "_bl214",
        "NIFTY 2021-11 -> 2023-10 (older, never looked at for this)",
    ),
    ("2023-11-01", "2024-10-31", "_bl214", "NIFTY 2023-11 -> 2024-10"),
    ("2024-11-01", "2025-10-31", "live", "2024-11 -> 2025-10"),
    ("2025-11-01", "2026-11-06", "live", "2025-11 -> 2026-11"),
]
sym = {"N": "NIFTY", "S": "SENSEX"}
for lo, hi, src, lab in periods:
    root = Path("/Volumes/TradingData") / ("_bl214" if src == "_bl214" else "")
    agg = defaultdict(lambda: defaultdict(list))
    with store.slipped(0.5):
        for n in names:
            idx, f = fam(n)
            if src == "_bl214" and idx != "N":
                continue
            try:
                r = store.read_net(n, root)
            except Exception:
                continue
            for d, v in r.items():
                if lo <= str(d) <= hi:
                    agg[(idx, f)][str(d)].append(v)
    print("\n==", lab)
    for idx in ("N", "S"):
        x = np.array([F[sym[idx]][d]["prev5"] for d in F[sym[idx]] if lo <= d <= hi])
        if not len(x):
            continue
        cuts = np.quantile(x, [1 / 3, 2 / 3])
        for (i, f), days in sorted(agg.items()):
            if i != idx:
                continue
            out = []
            for k in range(3):
                v = [
                    np.mean(z)
                    for d, z in days.items()
                    if d in F[sym[idx]]
                    and [
                        F[sym[idx]][d]["prev5"] <= cuts[0],
                        cuts[0] < F[sym[idx]][d]["prev5"] <= cuts[1],
                        F[sym[idx]][d]["prev5"] > cuts[1],
                    ][k]
                ]
                out.append(
                    f"{np.mean(v):+5.0f} ({100 * np.mean(np.array(v) > 0):.0f}%)" if v else "  -  "
                )
            print(
                f"  {sym[idx][:1]} {f:6s} low {out[0]} | mid {out[1]} | high {out[2]}   cuts {cuts[0]:.2f}/{cuts[1]:.2f}"
            )
