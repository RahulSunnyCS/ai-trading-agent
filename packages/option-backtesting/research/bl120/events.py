"""BL-120 Phase 1, step 1: the rule's first event (if any) on every judged day.

    uv run --with pandas python research/bl120/events.py [--workers 6]

Writes out/events.csv: one row per cell-day (status ok / no_data), with the fire, entry and hold
minutes, the low and high, the rolling straddle's strike switches and unpriced minutes inside the
window, and days to expiry. Opens only the cells in periods.CELLS.
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from periods import CELLS, assert_day, cell_days
from rule import M_1430, RISE, detect

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from straddle_series import first_priced, level, load_chain_day, rolling_straddle  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402


def day_row(task: tuple[str, str, str]) -> dict:
    period, und, day_s = task
    day = date.fromisoformat(day_s)
    assert_day(und, day)
    base = {"period": period, "underlying": und, "day": day_s}
    try:
        chain = load_chain_day(data_dir(), und, day)
    except (FileNotFoundError, LookupError):
        return {**base, "status": "no_data"}
    rolling = rolling_straddle(chain)
    if first_priced(rolling) is None:
        return {**base, "status": "no_priced"}
    lv = level(rolling)
    ev = detect(lv.x, RISE[und])
    row = {
        **base,
        "status": "ok",
        "dte": (chain.expiry - day).days,
        "x1430": round(lv.x[M_1430], 2),
    }
    if ev is not None:
        row.update(
            fire=ev.fire, entry=ev.entry, held=ev.held, low=round(ev.low, 2),
            high=round(ev.high, 2), x_fire=round(ev.x_fire, 2), tradable=int(ev.tradable),
            switches=sum(lv.switch[M_1430 : ev.fire + 1]),
            missing=sum(lv.missing[M_1430 : ev.fire + 1]),
        )  # fmt: skip
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    root = data_dir()
    tasks = []
    for period, und in CELLS:
        days, skipped = cell_days(root, und, period)
        print(
            f"{period} {und}: {len(days)} weekday sessions, {len(skipped)} skipped by data_quality"
        )
        tasks += [(period, und, d.isoformat()) for d in days]
    with ProcessPoolExecutor(a.workers) as ex:
        rows = list(ex.map(day_row, tasks, chunksize=8))
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_csv(out / "events.csv", index=False)
    ok = df[df.status == "ok"]
    ev = ok[ok.fire.notna()]
    print(ok.groupby(["period", "underlying"]).size().rename("days_ok").to_string())
    print(
        ev.groupby(["period", "underlying"])
        .agg(events=("day", "size"), tradable=("tradable", "sum"))
        .to_string()
    )
    print("status counts:", df.status.value_counts().to_dict())
    return 0


if __name__ == "__main__":
    sys.exit(main())
