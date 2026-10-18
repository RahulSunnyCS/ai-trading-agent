"""BL-124 Phase 1, step 1: each arm's first event (if any) on every judged day. No P&L here.

    uv run --with pandas python research/bl124/events.py [--workers 6]

Writes out/events.csv: one row per cell-day (status ok / no_data / no_priced), with S0, H, the fire and
entry minutes of each arm, strike switches inside the window and days to expiry.
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from periods import PERIODS, UNDERLYING, assert_day, cell_days
from rule import ARMS, M_0917, M_0930, detect

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from straddle_series import first_priced, level, load_chain_day, rolling_straddle  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402


def day_row(task: tuple[str, str]) -> dict:
    period, day_s = task
    day = date.fromisoformat(day_s)
    assert_day(UNDERLYING, day)
    base = {"period": period, "day": day_s}
    try:
        chain = load_chain_day(data_dir(), UNDERLYING, day)
    except (FileNotFoundError, LookupError):
        return {**base, "status": "no_data"}
    rolling = rolling_straddle(chain)
    fp = first_priced(rolling, start=M_0917)
    if fp is None or fp > M_0930:
        return {**base, "status": "no_priced_by_0930"}
    lv = level(rolling, start=M_0917)
    x = lv.x
    s0, high = x[M_0917], max(x[M_0917 : M_0930 + 1])
    row = {
        **base,
        "status": "ok",
        "dte": (chain.expiry - day).days,
        "s0": round(s0, 2),
        "high": round(high, 2),
        "high_minus_s0": round(high - s0, 2),
        "late_priced": int(fp > M_0917),
    }
    for arm in ARMS:
        ev = detect(x, arm)
        k = arm.lower()
        if ev is not None:
            row[f"{k}_fire"] = ev.fire
            row[f"{k}_entry"] = ev.entry
            row[f"{k}_x"] = round(ev.x_fire, 2)
            row[f"{k}_switches"] = sum(lv.switch[M_0917 : ev.fire + 1])
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    root = data_dir()
    tasks = []
    for period in PERIODS:
        days, skipped = cell_days(root, period)
        print(f"{period}: {len(days)} weekday sessions, {len(skipped)} skipped by data_quality")
        tasks += [(period, d.isoformat()) for d in days]
    with ProcessPoolExecutor(a.workers) as ex:
        rows = list(ex.map(day_row, tasks, chunksize=8))
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    df = pd.DataFrame(rows)
    df.to_csv(out / "events.csv", index=False)
    ok = df[df.status == "ok"]
    print("status counts:", df.status.value_counts().to_dict())
    print("late priced (first priced minute after 09:17):", int(ok.late_priced.sum()))
    for arm in ARMS:
        k = arm.lower()
        ev = ok[ok[f"{k}_fire"].notna()]
        print(
            arm,
            ev.groupby("period").size().rename("events").to_dict(),
            "of",
            ok.groupby("period").size().to_dict(),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
