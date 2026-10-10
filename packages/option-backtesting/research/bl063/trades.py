"""BL-063: re-run picked (variant, day) pairs one day at a time and record every trade.

    uv run python research/bl063/trades.py <pairs.txt> <out.jsonl>

Each pairs line is "<variant> <YYYY-MM-DD>" (variant like N_wide_0917). One JSON line per pair:
the engine's gross P&L for the day and each trade's [position, qty, entry_price, exit_price, leg].
Resumable: pairs already in the output file are skipped."""

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
            result = run_legwise(
                strategies[name],
                data_dir(),
                date.fromisoformat(day_s),
                date.fromisoformat(day_s),
                skipped={},
            )
            record = {"v": name, "day": day_s, "gross": None, "trades": []}
            if result:
                day = result[0]
                record["gross"] = day.gross
                record["trades"] = [
                    [t.position, t.qty, t.entry_price, t.exit_price, t.leg_id]
                    for t in day.trades
                    if t.exit_price is not None
                ]
            out.write(json.dumps(record) + "\n")
            out.flush()


if __name__ == "__main__":
    main()
