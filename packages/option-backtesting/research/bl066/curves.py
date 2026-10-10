"""BL-066: re-run picked (variant, day) pairs one day at a time and record each minute's mark-to-market.

    uv run python research/bl066/curves.py <pairs.txt> <out.jsonl>

One JSON line per pair: the engine's gross P&L and the [minute, mtm] points of the day (the minute is an
index on the 375-minute grid). Resumable; blank lines are skipped."""

import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import run_legwise  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402


def main() -> None:
    pairs_file, out_file = Path(sys.argv[1]), Path(sys.argv[2])
    done = set()
    if out_file.exists():
        done = {(r["v"], r["day"]) for r in map(json.loads, out_file.read_text().splitlines())}
    strategies: dict = {}
    with pairs_file.open() as pairs, out_file.open("a") as out:
        for line in pairs:
            if not line.strip():
                continue
            name, day_s = line.split()
            if (name, day_s) in done:
                continue
            if name not in strategies:
                strategies[name] = load_legwise(varlib.variant_file(name, "variants"))
            day = date.fromisoformat(day_s)
            result = run_legwise(strategies[name], data_dir(), day, day, skipped={})
            record = {"v": name, "day": day_s, "gross": None, "curve": []}
            if result:
                record["gross"] = result[0].gross
                record["curve"] = [[m, round(v, 2)] for m, v in result[0].mtm]
            out.write(json.dumps(record) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
