"""BL-166: simulate the variants in research/bl166/variants over the collected days.

    uv run python research/bl166/run_batch.py [--smoke] [--only SUBSTR]

One index at a time: each day is loaded once and every variant of that index is simulated on it
(the method of `obt rotation update`). Writes results/<variant>.csv with the columns of
research/bl080/run_batch.py (day, net, gross, costs, worst_mtm, stopped_by, n_trades). NIFTY and
SENSEX 2024-10-09 -> the last collected day. Lot sizing is 'current' (today's lot on every day) via
the same research-only reference override as BL-080/BL-071. `--smoke` runs 6 days and prints only
counts and timing. A variant's finished file is never re-run (delete it to redo).
"""

from __future__ import annotations

import csv
import sys
import time
from datetime import date
from pathlib import Path

from option_backtesting.data.reference.loader import (
    MissingReferenceData,
    ReferenceData,
    default_reference_data,
)
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import load_legwise

HERE = Path(__file__).parent
VARIANTS = HERE / "variants"
SIZING = date(2026, 10, 12)
START = date(2024, 10, 9)
COLUMNS = ["day", "net", "gross", "costs", "worst_mtm", "stopped_by", "n_trades"]


class EarliestRowReference:
    def __init__(self, ref: ReferenceData):
        self._ref = ref

    def __getattr__(self, name):
        return getattr(self._ref, name)

    def _early(self, call, underlying, when):
        try:
            return call(underlying, when)
        except MissingReferenceData:
            return call(underlying, date(2024, 10, 3))

    def lot_size(self, underlying, expiry):
        return self._early(self._ref.lot_size, underlying, expiry)

    def strike_step(self, underlying, as_of):
        return self._early(self._ref.strike_step, underlying, as_of)


def simulate(files: list[Path], underlying: str, start: date, end: date, report=print):
    root = data_dir()
    ref = EarliestRowReference(default_reference_data())
    strategies = {f.stem: load_legwise(f) for f in files}
    days, _ = backtest_days(root, underlying, start, end)
    out: dict[str, list[list]] = {n: [] for n in strategies}
    missing = dict.fromkeys(strategies, 0)
    t0 = time.time()
    for i, d in enumerate(days):
        try:
            data = load_day(root, underlying, d)
        except FileNotFoundError:
            continue
        for name, strat in strategies.items():
            try:
                r = simulate_day(strat, data, ref, SIZING)
            except MissingReferenceData:
                missing[name] += 1
                continue
            out[name].append(
                [d, round(r.gross - r.costs, 2), round(r.gross, 2), round(r.costs, 2),
                 round(r.worst_mtm, 2), r.stopped_by or "", len(r.trades)]
            )  # fmt: skip
        if (i + 1) % 25 == 0:
            report(f"  {underlying} {i + 1}/{len(days)} days, {time.time() - t0:.0f} s", flush=True)
    return out, len(days), missing


def main() -> None:
    smoke = "--smoke" in sys.argv
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
    out = HERE / ("results_smoke" if smoke else "results")
    out.mkdir(exist_ok=True)
    root = data_dir()
    for underlying, prefix in (("NIFTY", "N_"), ("SENSEX", "S_")):
        files = sorted(
            f
            for f in VARIANTS.glob(f"{prefix}*.yaml")
            if only in f.stem and not (out / f"{f.stem}.csv").exists()
        )
        if not files:
            continue
        end = max(d for d in backtest_days(root, underlying, START, date(2026, 12, 31))[0])
        lo, hi = (START, date(2024, 10, 16)) if smoke else (START, end)
        print(f"{underlying}: {len(files)} variants, {lo} -> {hi}", flush=True)
        results, n_days, missing = simulate(files, underlying, lo, hi)
        for name, rows in results.items():
            with open(out / f"{name}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
        counts = sorted({len(r) for r in results.values()})
        print(f"{underlying}: done, {n_days} days in window, rows per variant {counts}, "
              f"days lacking reference data {sum(missing.values())}", flush=True)  # fmt: skip


if __name__ == "__main__":
    main()
