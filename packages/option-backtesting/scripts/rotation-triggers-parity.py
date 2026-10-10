"""The nightly trigger module against the BL-083 research table: same stamps on the same days.

    TRADING_DATA_ROOT=... uv run python scripts/rotation-triggers-parity.py [--from 2026-08-01] \
        [--research /path/to/research/bl083/out/triggers.csv]

Prints PARITY OK when every (index, day, trigger) the research found in the window is found at the
same stamp, and no extra event appears. The module loads with strict_open=True here: the study
dropped every session that has a bar before 09:15 (about a dozen days since 2025, Angel One
collections), the production default keeps them. RSI is seeded from 700 sessions here, 2020-09
in the research; the difference is far below any threshold crossing.
"""

from __future__ import annotations

import csv
import sys
from datetime import date
from pathlib import Path

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import triggers as T


def main() -> int:
    argv = sys.argv[1:]
    start = argv[argv.index("--from") + 1] if "--from" in argv else "2026-08-01"
    path = Path(
        argv[argv.index("--research") + 1]
        if "--research" in argv
        else "research/bl083/out/triggers.csv"
    )
    research: dict[tuple, int] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            if r["day"] >= start and r["set"] == "explore":
                research[(r["underlying"], r["day"], r["trigger"])] = int(r["stamp"])
    last = max(d for _, d, _ in research)
    root = data_dir()
    vix = T.load_grid(root, "INDIAVIX", date.fromisoformat(last), sessions=700, strict_open=True)
    mine: dict[tuple, int] = {}
    for und in ("NIFTY", "SENSEX"):
        grid = T.load_grid(root, und, date.fromisoformat(last), sessions=700, strict_open=True)
        prep = T.prepare(grid, vix)
        for k, d in enumerate(grid.days):
            if d < start or d > last or k < 253:  # T3 needs 252 sessions before a session
                continue
            for trig, (j, _detail) in T.session_firings(root, und, grid, vix, prep, k).items():
                mine[(und, d, trig)] = j
    missing = sorted(set(research) - set(mine))
    extra = sorted(set(mine) - set(research))
    moved = sorted(k for k in set(mine) & set(research) if mine[k] != research[k])
    print(f"window {start} .. {last}: research {len(research)} events, module {len(mine)}")
    for label, items in (("missing", missing), ("extra", extra), ("moved", moved)):
        for k in items[:8]:
            print(f"  {label}: {k} research={research.get(k)} module={mine.get(k)}")
    ok = not (missing or extra or moved)
    print(
        "PARITY OK"
        if ok
        else f"PARITY FAILED: {len(missing)} missing, {len(extra)} extra, {len(moved)} moved"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
