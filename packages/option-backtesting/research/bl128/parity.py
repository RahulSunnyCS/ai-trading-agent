"""BL-128 parity check: Core S_p250_0917 and S_p320_0917 simulated through this folder's path must
equal the live store's stored gross and net on every day (read-only on the store)."""

from __future__ import annotations

import csv
import json
from datetime import date

from common import PARITY, RESULTS

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store


def main() -> None:
    root = data_dir()
    out = {}
    for name in PARITY:
        mine = {}
        with (RESULTS / "parity_core" / f"{name}.csv").open() as f:
            for r in csv.DictReader(f):
                mine[date.fromisoformat(r["day"])] = (float(r["gross"]), float(r["net"]))
        gross, net = {}, {}
        with store.result_path(name, root).open() as f:
            for r in csv.DictReader(f):
                gross[date.fromisoformat(r["day"])] = float(r["gross"])
                net[date.fromisoformat(r["day"])] = float(r["net"])
        days = sorted(set(net) | set(mine))
        equal = [d for d in days if d in mine and d in net and mine[d] == (gross[d], net[d])]
        diffs = [
            (d.isoformat(), mine.get(d), gross.get(d), net.get(d)) for d in days if d not in equal
        ]
        out[name] = {"days": len(days), "equal_days": len(equal), "differing": diffs[:10]}
        print(name, out[name])
        assert len(equal) == len(days), f"parity failed for {name}"
    (RESULTS / "parity.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
