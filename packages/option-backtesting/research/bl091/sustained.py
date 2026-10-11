"""BL-091 Phase 1 exploration (owner, 2026-10-11): spikes that hold for 5 minutes, per-index sizes.

    uv run --with pandas python research/bl091/sustained.py [--workers 6]

Owner's definitions, P2 + P3 only (descriptive; no rule chosen):
- A spike is tradable only if the rolling ATM straddle stays at least the threshold above its low for
  HOLD_MINUTES consecutive minutes. It is known at the end of that run (`held_min`), so a live rule
  could act at held_min + 1.
- Thresholds per index: NIFTY 25 points, SENSEX 90 points. The pause/decay level used to split
  episodes scales with them (15 and 54 points).
- Size for the top-10 % cut: the straddle 5 minutes after the episode's peak, minus its low. This uses
  the peak, so it describes spikes after the fact; a live rule would need a level known at the time.
Writes out/sustained.csv (one row per episode with the hold flag and sizes).
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from episodes import scan_episodes
from periods import M_1528, UNDERLYINGS, assert_learning_day, learning_days
from series import first_priced, level, load_chain_day, rolling_straddle

from option_backtesting.fyers.daily import data_dir

HERE = Path(__file__).parent
HOLD_MINUTES = 5
RISE = {"NIFTY": 25.0, "SENSEX": 90.0}
DECAY = {"NIFTY": 15.0, "SENSEX": 54.0}


def held_minute(x: list[float], low: float, start: int, end: int, rise: float) -> int | None:
    """The first minute that completes HOLD_MINUTES consecutive minutes with x - low >= rise."""
    run = 0
    for m in range(start, end + 1):
        run = run + 1 if x[m] - low >= rise else 0
        if run >= HOLD_MINUTES:
            return m
    return None


def day_rows(task: tuple[str, str, str]) -> list[dict]:
    period, und, day_s = task
    day = date.fromisoformat(day_s)
    assert_learning_day(und, day)
    if day.weekday() >= 5:
        return []
    try:
        chain = load_chain_day(data_dir(), und, day)
    except (FileNotFoundError, LookupError):
        return []
    rolling = rolling_straddle(chain)
    start = first_priced(rolling)
    if start is None:
        return []
    x = level(rolling).x
    rows = []
    for i, ep in enumerate(scan_episodes(x, start=start, rise=RISE[und], decay=DECAY[und])):
        hm = held_minute(x, ep.low_x, ep.trigger_min, ep.end_min, RISE[und])
        post = min(ep.high_min + 5, M_1528)
        rows.append({
            "period": period, "underlying": und, "day": day_s, "episode_idx": i,
            "dte": (chain.expiry - day).days, "start_min": ep.start_min, "trigger_min": ep.trigger_min,
            "held_min": hm, "high_min": ep.high_min, "low_x": round(ep.low_x, 2),
            "rise": round(ep.high_x - ep.low_x, 2), "post5": round(x[post] - ep.low_x, 2),
            "at_held": round(x[hm] - ep.low_x, 2) if hm is not None else None,
            "outcome": ep.outcome, "straddle_low": round(ep.low_x, 2),
        })  # fmt: skip
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    root = data_dir()
    todo = [(p, u, d.isoformat()) for p, us in UNDERLYINGS.items() for u in us
            for d in learning_days(root, u, p)[0]]  # fmt: skip
    rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for r in pool.map(day_rows, todo, chunksize=4):
            rows += r
    pd.DataFrame(rows).to_csv(HERE / "out" / "sustained.csv", index=False)
    print(f"{len(todo)} index-days, {len(rows)} episodes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
