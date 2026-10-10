"""Serve the rotation daily log over a SYNTHETIC store, to look at the dashboard widget before the
journal has real entries (the first one is Monday 12 October 2026, 09:16).

    uv run python scripts/rotation-daylog-demo.py            # build in a temp dir, serve on :8123
    uv run python scripts/rotation-daylog-demo.py --root /tmp/rot --port 8124 --no-serve

It writes only under --root (never TRADING_DATA_ROOT), builds the 298-variant universe with random
results and genuine hash-chained entries through `pick.record` (so every state a day can be in is
there: scored, late, not recorded, waiting, a VIX read from Angel One, a holiday), pins the API's
clock to 22 Oct 2026 12:00 IST, and serves the same routes `obt-api` does. Point the dashboard at
it with `OBT_DIRECT=1 OBT_DIRECT_API_URL=http://127.0.0.1:8123`. The numbers mean nothing.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "unit"))


def build(root: Path, history: int) -> dict:
    import rotation_synth as syn

    from option_backtesting.rotation import placements
    from option_backtesting.rotation.variants import variant_names

    names = variant_names()
    scenario = syn.forward_scenario(root, history=history, names=names)
    day = lambda d: d.isoformat()  # noqa: E731
    fwd = scenario["forward"]
    at = lambda d, m: datetime(d.year, d.month, d.day, 9, m, tzinfo=syn.IST)  # noqa: E731
    placements.append(day(fwd[0]), "A", "placed", "", root, at(fwd[0], 31))
    placements.append(day(fwd[0]), "B", "placed", "", root, at(fwd[0], 31))
    placements.append(day(fwd[0]), "C", "not_placed", "AlgoTest was slow", root, at(fwd[0], 33))
    placements.append(day(fwd[1]), "A", "changed", "dropped the Buy leg", root, at(fwd[1], 29))
    return scenario


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=None, help="where to build (default: temp)")
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument(
        "--history", type=int, default=130, help="weekdays of results before 12 Oct"
    )
    parser.add_argument("--no-serve", action="store_true")
    args = parser.parse_args()

    root = args.root or Path(tempfile.mkdtemp(prefix="rotation-daylog-demo-"))
    root.mkdir(parents=True, exist_ok=True)
    os.environ["TRADING_DATA_ROOT"] = str(root)
    import rotation_synth as syn

    if (root / "rotation" / "journal.jsonl").exists():
        print(f"synthetic store (already built): {root}")
    else:
        scenario = build(root, args.history)
        print(f"synthetic store: {root}")
        print(f"  {len(scenario['entries'])} journal entries")
    print(f"  clock pinned to {syn.NOW}")
    if args.no_serve:
        return

    import uvicorn

    from option_backtesting.api.app import create_app
    from option_backtesting.rotation import daylog

    daylog.now_ist = lambda: syn.NOW
    uvicorn.run(create_app(root / "cache"), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
