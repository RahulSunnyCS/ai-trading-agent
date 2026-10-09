"""BL-070: run one no-stop variant over the rotation window; per-day net P&L to results/<name>.csv.

    uv run python research/bl070/run_variant.py research/bl070/variants/N_wide_0917.yaml

Same columns as research/bl054/run_variant.py; window 2025-09-01 -> 2026-10-08 (the rotation window,
not BL-054's two years). Skipped if the result file already exists (resumable)."""

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
if out.exists():
    print(f"{path.stem}: done already", flush=True)
    sys.exit(0)
strategy = load_legwise(path)
skipped: dict = {}
days = run_legwise(strategy, data_dir(), date(2025, 9, 1), date(2026, 10, 8), skipped=skipped)
tmp = out.with_suffix(".tmp")
with open(tmp, "w", newline="") as f:
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
tmp.rename(out)
print(f"{path.stem}: {len(days)} days, {len(skipped)} skipped", flush=True)
