"""BL-062: run one variant YAML over the window; per-day net P&L to results/<name>.csv.

Same as research/bl061/run_variant.py with the output folder next to this file."""

import csv
import sys
from datetime import date
from pathlib import Path

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import run_legwise
from option_backtesting.legwise.schema import load_legwise

path = Path(sys.argv[1])
out = Path(__file__).parent / "results" / f"{path.stem}.csv"
out.parent.mkdir(exist_ok=True)
strategy = load_legwise(path)
skipped: dict = {}
days = run_legwise(strategy, data_dir(), date(2024, 10, 9), date(2026, 10, 8), skipped=skipped)
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["day", "net", "gross", "costs", "worst_mtm", "stopped_by", "n_trades"])
    for d in days:
        w.writerow(
            [
                d.day,
                round(d.gross - d.costs, 2),
                round(d.gross, 2),
                round(d.costs, 2),
                round(d.worst_mtm, 2),
                d.stopped_by or "",
                len(d.trades),
            ]
        )
print(f"{path.stem}: {len(days)} days, {len(skipped)} skipped", flush=True)
