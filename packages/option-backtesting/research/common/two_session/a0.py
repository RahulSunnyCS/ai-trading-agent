"""BL-185 comparator A0: Core-298 and T1's 223 extra variants re-simulated with the same engine,
sizing and charges as the sweep (rows: day, gross, charges, net, worst_mtm, stopped_by, n_trades,
orders), one CSV a variant under research/bl185/a0/. Resumable; run after Stage A (the cores are busy).

    uv run python research/common/two_session/a0.py [--smoke]
"""

from __future__ import annotations

import csv
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
import split_replay as sr  # noqa: E402

OUT = HERE.parents[1] / "bl185" / "a0"


def main() -> None:
    smoke = "--smoke" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    files = {p.stem: p for p in sorted(sr.ROTATION.glob("*.yaml"))}
    files |= {p.stem: p for p in sorted((sr.ROTATION.parent / "rotation_t1").glob("*.yaml"))}
    for u, prefix in (("NIFTY", "N_"), ("SENSEX", "S_")):
        todo = {
            n: p
            for n, p in files.items()
            if n.startswith(prefix) and not (OUT / f"{n}.csv").exists()
        }
        if smoke:
            todo = dict(list(todo.items())[:3])
        if not todo:
            continue
        print(f"{u}: {len(todo)} variants", flush=True)
        res = sr.simulate(u, todo, sr.START, date(2024, 10, 16) if smoke else sr.END)
        for n, rows in res.items():
            with open(OUT / f"{n}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(sr.COLUMNS)
                w.writerows(rows)


if __name__ == "__main__":
    main()
