"""BL-080: run the 100 new closest-premium variants (strategies/rotation_ext) over the collected days.

    uv run python research/bl080/run_batch.py [--validate]

Loads each index's day once and simulates that index's 50 variants (the method of
`obt rotation update`), writes research/bl080/results/<variant>.csv in the columns of
research/bl054/run_variant.py. NIFTY 2022-01-03 -> 2026-10-09, SENSEX 2024-10-09 -> 2026-10-09; a
research-only reference override answers lot-size / strike-step lookups before the tables start
(lot_sizing current: the contract's lot never enters the P&L), as research/bl071/run_variant.py.
`--validate` re-runs three existing variants over 30 days and compares them with their stored files.
"""

from __future__ import annotations

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
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import load_legwise

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
EXT = ROOT / "strategies" / "rotation_ext"
CORE = ROOT / "strategies" / "rotation"
SIZING = date(2026, 10, 12)
WINDOWS = {"NIFTY": (date(2022, 1, 3), date(2026, 10, 9)), "SENSEX": (date(2024, 10, 9), date(2026, 10, 9))}
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


def simulate(files: list[Path], underlying: str, start: date, end: date) -> dict[str, list[list]]:
    root = data_dir()
    ref = EarliestRowReference(default_reference_data())
    strategies = {f.stem: load_legwise(f) for f in files}
    days, _ = backtest_days(root, underlying, start, end)
    out: dict[str, list[list]] = {n: [] for n in strategies}
    for d in days:
        try:
            data = load_day(root, underlying, d)
        except FileNotFoundError:
            continue
        for name, strat in strategies.items():
            try:
                r = simulate_day(strat, data, ref, SIZING)
            except MissingReferenceData:
                continue
            out[name].append(
                [d, round(r.gross - r.costs, 2), round(r.gross, 2), round(r.costs, 2),
                 round(r.worst_mtm, 2), r.stopped_by or "", len(r.trades)]
            )
    return out


def validate() -> int:
    bad = 0
    for name, underlying, lo, hi in (
        ("N_p80_1117", "NIFTY", date(2025, 11, 3), date(2025, 12, 12)),
        ("N_p100_0932", "NIFTY", date(2024, 11, 4), date(2024, 12, 13)),
        ("S_p250_1117", "SENSEX", date(2025, 11, 3), date(2025, 12, 12)),
    ):
        got = simulate([CORE / f"{name}.yaml"], underlying, lo, hi)[name]
        sys.path.insert(0, str(ROOT / "research" / "common"))
        import varlib

        with open(varlib.variant_file(name, "results")) as f:
            stored = {r["day"]: float(r["net"]) for r in csv.DictReader(f)}
        diffs = [(str(r[0]), r[1], stored.get(str(r[0]))) for r in got if stored.get(str(r[0])) != r[1]]
        print(f"{name}: {len(got)} days, {len(diffs)} differ {diffs[:3]}")
        bad += len(diffs) + (len(got) == 0)
    return bad


def main() -> None:
    if "--validate" in sys.argv:
        sys.exit(1 if validate() else 0)
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    for underlying, prefix in (("NIFTY", "N_"), ("SENSEX", "S_")):
        files = sorted(f for f in EXT.glob(f"{prefix}*.yaml") if not (out / f"{f.stem}.csv").exists())
        if not files:
            continue
        lo, hi = WINDOWS[underlying]
        print(f"{underlying}: {len(files)} variants, {lo} -> {hi}", flush=True)
        for name, rows in simulate(files, underlying, lo, hi).items():
            with open(out / f"{name}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
        print(f"{underlying}: done", flush=True)


if __name__ == "__main__":
    main()
