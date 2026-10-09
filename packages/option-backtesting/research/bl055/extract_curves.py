"""BL-055: re-run one live strategy and keep each day's per-minute MTM curve + final P&L."""

import pickle
import sys
from datetime import date
from pathlib import Path

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import run_legwise
from option_backtesting.legwise.schema import load_legwise

path = Path(sys.argv[1])
s = load_legwise(path)
days = run_legwise(s, data_dir(), date(2024, 10, 9), date(2026, 10, 8), skipped={})
out = {
    d.day: {"curve": d.mtm, "gross": d.gross, "costs": d.costs, "stopped_by": d.stopped_by}
    for d in days
}
with open(Path(__file__).parent / f"curves_{path.stem}.pkl", "wb") as f:
    pickle.dump(out, f)
print(path.stem, len(out), "days", flush=True)
