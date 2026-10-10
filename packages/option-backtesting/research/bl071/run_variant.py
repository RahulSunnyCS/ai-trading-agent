"""BL-071 part B: run one NIFTY variant YAML over the imported 2022-01 -> 2024-10-08 days.

    uv run python research/bl071/run_variant.py research/bl054/variants/wide_0917.yaml [FROM] [TO]

Writes research/bl071/results/<stem>.csv with the columns of research/bl054/run_variant.py. The
variant files are the same ones the 2024-10-09 -> 2026-10-08 results came from, so the early and late
days are one series per variant. Resumable (an existing result file is kept).

Reference data: lot_sizes.csv / strike_step.csv / rates.csv start in 2024-10, so the engine would skip
every earlier day at its cross-check of the contract's lot size. `lot_sizing: current` (the variants'
mode) sizes every day with today's lot, so the contract's lot never enters the P&L; for dates before a
table starts this runner answers a lookup with the table's earliest row (research only: the
repository's reference CSVs are not changed, and `strike_step` / `rates` are not used by the
legwise engine's P&L)."""

import csv
import sys
from datetime import date
from pathlib import Path

from option_backtesting.data.reference.loader import (
    MissingReferenceData,
    ReferenceData,
    default_reference_data,
)
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import run_legwise
from option_backtesting.legwise.schema import load_legwise


class EarliestRowReference:
    """default_reference_data() with lookups before a table's first row answered by that row."""

    def __init__(self, ref: ReferenceData):
        self._ref = ref

    def __getattr__(self, name):
        return getattr(self._ref, name)

    def _early(self, call, underlying, when, first_date):
        try:
            return call(underlying, when)
        except MissingReferenceData:
            return call(underlying, first_date)

    def lot_size(self, underlying, expiry):
        return self._early(self._ref.lot_size, underlying, expiry, date(2024, 10, 3))

    def strike_step(self, underlying, as_of):
        return self._early(self._ref.strike_step, underlying, as_of, date(2024, 10, 3))


path = Path(sys.argv[1])
lo = date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else date(2022, 1, 3)
hi = date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else date(2024, 10, 8)
out = Path(__file__).parent / "results" / f"{path.stem}.csv"
out.parent.mkdir(exist_ok=True)
if out.exists():
    print(f"{path.stem}: done already", flush=True)
    sys.exit(0)
skipped: dict = {}
days = run_legwise(
    load_legwise(path),
    data_dir(),
    lo,
    hi,
    reference=EarliestRowReference(default_reference_data()),
    skipped=skipped,
)
tmp = out.with_suffix(".tmp")
with open(tmp, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["day", "net", "gross", "costs", "worst_mtm", "stopped_by", "n_trades"])
    for d in days:
        w.writerow(
            [d.day, round(d.gross - d.costs, 2), round(d.gross, 2), round(d.costs, 2),
             round(d.worst_mtm, 2), d.stopped_by or "", len(d.trades)]
        )
tmp.rename(out)
reasons: dict = {}
for r in skipped.values():
    key = r.split(":")[0] + ":" + r.split(":")[1].strip()[:40]
    reasons[key] = reasons.get(key, 0) + 1
print(f"{path.stem}: {len(days)} days, {len(skipped)} skipped {reasons}", flush=True)
