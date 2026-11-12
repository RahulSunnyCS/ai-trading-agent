"""BL-214 anchor: every NIFTY variant's rows in the _bl214 root against the live store's, day by day, row by row
(and the 0.5% slippage copies). Reads both, writes nothing."""

import csv
import sys
from datetime import date
from pathlib import Path

from option_backtesting.rotation import store
from option_backtesting.rotation.variants import track_names, variant_names

LIVE = Path("/Volumes/TradingData")
NEW = Path("/Volumes/TradingData/_bl214")
FROM, TO = date.fromisoformat(sys.argv[1]), date.fromisoformat(sys.argv[2])


def rows(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        return {r["day"]: r for r in csv.DictReader(f)}


names = [n for n in [*variant_names(), *track_names("t1")] if n.startswith("N_")]
checked = bad = missing = 0
examples = []
for kind, mapper in (("stored", lambda p: p), ("slip-0.5", lambda p: store.slip_path(p, 0.5))):
    for n in names:
        a = rows(mapper(store.result_path(n, LIVE)))
        b = rows(mapper(store.result_path(n, NEW)))
        for d in sorted(x for x in b if FROM <= date.fromisoformat(x) <= TO):
            if d not in a:
                missing += 1
                continue
            checked += 1
            if any(a[d][c] != b[d][c] for c in a[d]):
                bad += 1
                if len(examples) < 5:
                    examples.append((kind, n, d, a[d], b[d]))
print(
    f"{len(names)} variants; {checked} variant-days compared (stored + slippage copies); "
    f"{bad} differ; {missing} not in the live store"
)
for e in examples:
    print(e)
