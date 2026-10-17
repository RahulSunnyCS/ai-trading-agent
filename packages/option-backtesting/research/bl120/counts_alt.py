"""BL-120: COUNTS ONLY. How many tradable events would other readings of the owner's sentence give?

    uv run --with pandas python research/bl120/counts_alt.py [--workers 6]

No P&L is computed or read here. Each variant is a count of days on which the rule would fire with an
entry by 15:12, so the owner can choose a reading by what is testable, not by how it performed. Every
variant counted is listed in the item's Log. Writes out/counts_alt.csv.

Variants (A is the registered rule; the others are not registered and are not judged):
  A     registered: observation, low and high from 14:30; rise 20 / 50; hold 5; give-back 15
  A1330 as A with observation starting at 13:30
  A1300 as A with observation starting at 13:00
  Ahalf as A with the rise halved (10 NIFTY / 25 SENSEX)
  B     the rise is measured from the day's running low since 09:20 and may hold before 14:30;
        the give-back must first cross 15 points at or after 14:30 (a new low starts a new epoch)
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from periods import CELLS, assert_day, cell_days
from rule import RISE, detect, detect_b

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from straddle_series import first_priced, level, load_chain_day, rolling_straddle  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402


def day_counts(task: tuple[str, str, str]) -> dict:
    period, und, day_s = task
    day = date.fromisoformat(day_s)
    assert_day(und, day)
    row = {"period": period, "underlying": und, "day": day_s}
    try:
        chain = load_chain_day(data_dir(), und, day)
    except (FileNotFoundError, LookupError):
        return row
    rolling = rolling_straddle(chain)
    if first_priced(rolling) is None:
        return row
    x = level(rolling).x
    r = RISE[und]
    for name, ev in (
        ("A", detect(x, r)),
        ("A1330", detect(x, r, start=255)),
        ("A1300", detect(x, r, start=225)),
        ("Ahalf", detect(x, r / 2)),
    ):
        row[name] = None if ev is None else int(ev.tradable)
    fb = detect_b(x, r)
    row["B"] = None if fb is None else int(fb.tradable)
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    root = data_dir()
    tasks = []
    for period, und in CELLS:
        days, _ = cell_days(root, und, period)
        tasks += [(period, und, d.isoformat()) for d in days]
    with ProcessPoolExecutor(a.workers) as ex:
        rows = list(ex.map(day_counts, tasks, chunksize=8))
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "out" / "counts_alt.csv", index=False)
    out = []
    for (period, und), g in df.groupby(["period", "underlying"]):
        rec = {"cell": f"{und} {period}", "days": len(g)}
        for v in ("A", "A1330", "A1300", "Ahalf", "B"):
            rec[v + "_fires"] = int(g[v].notna().sum())
            rec[v + "_tradable"] = int((g[v] == 1).sum())
        out.append(rec)
    print(pd.DataFrame(out).to_string(index=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
