"""BL-091 Phase 1: replay R0 (the owner's re-entry habit) on every census episode.

    uv run --with pandas python research/bl091/replay_r0.py [--workers 4]

Reads out/episodes.csv, loads each index-day once, runs the ladder per episode and appends one row
per attempt to results/r0_attempts.csv. Resumable: an episode already present (without an ERR row)
is skipped. Late-trigger episodes (trigger at or after 15:12) get no attempt and no row.
"""

from __future__ import annotations

import argparse
import csv
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from periods import assert_learning_day
from r0 import ATTEMPT_COLUMNS, ladder

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import load_day

HERE = Path(__file__).parent
EPISODES = HERE / "out" / "episodes.csv"
RESULTS = HERE / "results" / "r0_attempts.csv"
# trigger_min is part of the key: a re-run census with another definition must not reuse old ladders
KEY = ["period", "underlying", "day", "episode_idx", "trigger_min"]
COLUMNS = [*KEY, *ATTEMPT_COLUMNS]


def _early_reference():
    sys.path.insert(0, str(HERE.parent / "common"))
    from early_ref import early_reference

    return early_reference()


def work(task: tuple[str, str, str, list[tuple[int, int]]]) -> list[dict]:
    period, underlying, day_s, episodes = task
    day = date.fromisoformat(day_s)
    assert_learning_day(underlying, day)
    ref = _early_reference()
    try:
        data = load_day(data_dir(), underlying, day)
    except FileNotFoundError as e:
        return [{"period": period, "underlying": underlying, "day": day_s, "episode_idx": idx,
                 "trigger_min": trig, "attempt": 0, "outcome": "ERR", "notes": str(e)}
                for idx, trig in episodes]  # fmt: skip
    out: list[dict] = []
    for idx, trig in episodes:
        base = {"period": period, "underlying": underlying, "day": day_s, "episode_idx": idx,
                "trigger_min": trig}  # fmt: skip
        try:
            for row in ladder(data, underlying, trig, ref):
                out.append({**base, **row})
        except Exception as e:  # noqa: BLE001 -- recorded as an ERR row and re-run next time
            out.append(
                {**base, "attempt": 0, "outcome": "ERR", "notes": f"{type(e).__name__}: {e}"}
            )
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    eps = pd.read_csv(EPISODES)
    eps = eps[~eps.late_trigger.astype(bool)]
    done: set[tuple] = set()
    if RESULTS.exists():
        prev = pd.read_csv(RESULTS)
        ok = prev[prev.outcome != "ERR"]
        done = {tuple(r) for r in ok[KEY].astype(str).itertuples(index=False)}
    by_day: dict[tuple[str, str, str], list[tuple[int, int]]] = {}
    for r in eps.itertuples(index=False):
        if (
            str(r.period),
            str(r.underlying),
            str(r.day),
            str(r.episode_idx),
            str(r.trigger_min),
        ) in done:
            continue
        by_day.setdefault((r.period, r.underlying, r.day), []).append(
            (int(r.episode_idx), int(r.trigger_min))
        )
    todo = [(p, u, d, e) for (p, u, d), e in sorted(by_day.items())]
    n_eps = sum(len(t[3]) for t in todo)
    print(
        f"{n_eps} episodes on {len(todo)} index-days to replay ({len(done)} done)", file=sys.stderr
    )
    RESULTS.parent.mkdir(exist_ok=True)
    new = not RESULTS.exists()
    with open(RESULTS, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        if new:
            w.writeheader()
        with ProcessPoolExecutor(max_workers=a.workers) as pool:
            for i, rows in enumerate(pool.map(work, todo, chunksize=2)):
                w.writerows(rows)
                if (i + 1) % 50 == 0:
                    f.flush()
                    print(f"  {i + 1}/{len(todo)} days", file=sys.stderr)
    allrows = pd.read_csv(RESULTS)
    keys = allrows[KEY].astype(str).apply(tuple, axis=1)
    ok_keys = set(keys[allrows.outcome != "ERR"])
    open_errs = {k for k in keys[allrows.outcome == "ERR"] if k not in ok_keys}
    print(f"done; {len(open_errs)} episodes still in error")
    return 0 if not open_errs else 1


if __name__ == "__main__":
    sys.exit(main())
