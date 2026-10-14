"""BL-102: run the registered grid (or a listed set of cells) over the collected days.

A job is one cohort (family, index, slot): its template is loaded once, every cell is built
in memory (`grid.build`; strategy YAMLs are never written), and each day is loaded ONCE and run
through every cell. The worker returns one summary row per cell and the cell x day matrix of
daily net after charges; the parent writes the matrix (`series/<cohort>.npy` + `.json`) BEFORE the
checkpoint part (`parts/<cohort>.csv`), so a part on disk always has its series. A job whose part
exists is skipped, which makes the run resumable. At the end the parts are concatenated into
`<family>_summary.csv`.

Charges are the registered BL-096 model (date-aware STT); `net_current_rates_inr` re-prices the
same trades at today's STT. Slippage and lot sizing are 0 / `current` unless `--slippage` /
`--lot-sizing` say otherwise (Stage 3 sensitivity).

    uv run python research/bl102/run_grid.py --family W --workers 3
    uv run python research/bl102/run_grid.py --cells results/stage2/cells.json --tag stage2
    uv run python research/bl102/run_grid.py --family all --slots all25 --cells finalists.json ...
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import resource
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

from option_backtesting.data.reference.loader import (  # noqa: E402
    MissingReferenceData,
    default_reference_data,
)
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import DayResult, simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.legwise.schema import Execution  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402

RESULTS = HERE / "results"
FROM = date(2024, 10, 9)
TO = date(2026, 10, 9)
TRADING_DAYS_PER_YEAR = 252
EXIT_REASONS = ("SL", "TARGET", "OVERALL_SL", "EXIT_TIME", "SQUARE_OFF")

# The registered charge model (BL-096; copied from research/bl097/run_family_sweep.py).
STT_SELL = ((date(2000, 1, 1), 0.0010), (date(2026, 4, 1), 0.0015))
EXCHANGE = {"NIFTY": 0.0003503, "SENSEX": 0.000325}
SEBI = 0.000001
IPFT_NSE = 0.000005
STAMP_BUY = 0.00003
GST = 0.18
BROKERAGE_PER_ORDER = 20.0
ORDERS_PER_TRADE = 2  # entry + exit, what the brokerage line assumes


def stt_rate(day: date) -> float:
    return [rate for start, rate in STT_SELL if day >= start][-1]


STT_TODAY = STT_SELL[-1][1]


def trade_charges(underlying: str, day: date, trade: Any) -> tuple[float, float]:
    """(charges at the day's rates, charges at today's STT) for one closed trade."""
    if trade.exit_price is None:
        return 0.0, 0.0
    is_nse = underlying == "NIFTY"
    sell = (trade.entry_price if trade.position == "sell" else trade.exit_price) * trade.qty
    buy = (trade.exit_price if trade.position == "sell" else trade.entry_price) * trade.qty
    both = sell + buy
    brokerage = ORDERS_PER_TRADE * BROKERAGE_PER_ORDER
    exchange = EXCHANGE[underlying] * both
    sebi = SEBI * both
    ipft = IPFT_NSE * both if is_nse else 0.0
    fixed = (
        brokerage
        + exchange
        + sebi
        + ipft
        + STAMP_BUY * buy
        + GST * (brokerage + exchange + sebi + ipft)
    )
    return fixed + stt_rate(day) * sell, fixed + STT_TODAY * sell


def max_drawdown(values: list[float]) -> tuple[float, int, int | None]:
    """(depth <= 0, trough index, index of the first day back at the peak or None)."""
    equity = peak = 0.0
    worst = 0.0
    trough = 0
    peak_at_trough = 0.0
    for i, value in enumerate(values):
        equity += value
        peak = max(peak, equity)
        if equity - peak < worst:
            worst, trough, peak_at_trough = equity - peak, i, peak
    recovered: int | None = None
    if worst < 0:
        equity = sum(values[: trough + 1])
        for j in range(trough + 1, len(values)):
            equity += values[j]
            if equity >= peak_at_trough:
                recovered = j
                break
    return worst, trough, recovered


def ulcer_index(values: list[float]) -> float:
    equity = peak = 0.0
    squared = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        squared += min(0.0, equity - peak) ** 2
    return math.sqrt(squared / len(values)) if values else float("nan")


def cvar95(values: list[float]) -> float:
    n = max(1, math.ceil(len(values) * 0.05))
    return sum(sorted(values)[:n]) / n if values else float("nan")


def losing_streak(values: list[float]) -> int:
    longest = run = 0
    for value in values:
        run = run + 1 if value < 0 else 0
        longest = max(longest, run)
    return longest


def ratio(a: float, b: float) -> float:
    return a / b if b else float("nan")


class Stats:
    """Scalar accumulators plus the daily net series for one cell."""

    def __init__(self, underlying: str) -> None:
        self.underlying = underlying
        self.values: list[float] = []
        self.gross_sum = self.charges_sum = self.charges_today_sum = 0.0
        self.positive_gross = 0.0
        self.n_trades = self.n_win = self.n_loss = 0
        self.sum_win = self.sum_loss = 0.0
        self.hold_sum = self.hold_n = 0
        self.entry_days = self.no_entry_days = 0
        self.ce_entries = self.pe_entries = 0
        self.ce_net = self.pe_net = 0.0
        self.reentry_count = 0
        self.reentry_net = 0.0  # net after charges of the re-entry trades (D secondary)
        self.one_leg_sl_days = self.both_leg_sl_days = 0
        self.mtm_stop_days = 0
        self.exit_counts = dict.fromkeys(EXIT_REASONS, 0)
        self.outlay_sum = self.outlay_peak = 0.0  # long premium paid per entry day (Buy)

    def add(self, result: DayResult) -> None:
        charges = charges_today = outlay = 0.0
        sl_legs: set[str] = set()
        seen: set[str] = set()
        if result.trades:
            self.entry_days += 1
        else:
            self.no_entry_days += 1
        for trade in result.trades:
            c, c_today = trade_charges(self.underlying, result.day, trade)
            charges += c
            charges_today += c_today
            net = trade.pnl - c
            self.n_trades += 1
            if net > 0:
                self.n_win += 1
                self.sum_win += net
            elif net < 0:
                self.n_loss += 1
                self.sum_loss += net
            if trade.leg_id == "ce":
                self.ce_entries += 1
                self.ce_net += net
            elif trade.leg_id == "pe":
                self.pe_entries += 1
                self.pe_net += net
            if trade.leg_id in seen:
                self.reentry_count += 1
                self.reentry_net += net
            seen.add(trade.leg_id)
            if trade.exit_min is not None:
                self.hold_sum += trade.exit_min - trade.entry_min
                self.hold_n += 1
            if trade.exit_reason in self.exit_counts:
                self.exit_counts[trade.exit_reason] += 1
            if trade.exit_reason == "SL":
                sl_legs.add(trade.leg_id)
            if trade.position == "buy":
                outlay += trade.entry_price * trade.qty
        self.one_leg_sl_days += len(sl_legs) == 1
        self.both_leg_sl_days += len(sl_legs) >= 2
        self.mtm_stop_days += "overall sl" in (result.stopped_by or "").lower()
        self.gross_sum += result.gross
        self.positive_gross += max(0.0, result.gross)
        self.charges_sum += charges
        self.charges_today_sum += charges_today
        self.outlay_sum += outlay
        self.outlay_peak = max(self.outlay_peak, outlay)
        self.values.append(result.gross - charges)

    def finish(self, capital_inr: float | None) -> dict[str, Any]:
        v = self.values
        n = len(v)
        if n == 0:
            return {"n_days": 0}
        net = sum(v)
        annual = net / n * TRADING_DAYS_PER_YEAR
        dd, trough, recovered = max_drawdown(v)
        ulcer = ulcer_index(v)
        avg_win = ratio(self.sum_win, self.n_win)
        avg_loss = ratio(self.sum_loss, self.n_loss)
        if capital_inr is None:  # Buy: capital is the premium paid, averaged over entry days
            capital_inr = ratio(self.outlay_sum, self.entry_days)
        return {
            "n_days": n,
            "gross_inr": self.gross_sum,
            "charges_inr": self.charges_sum,
            "net_inr": net,
            "net_current_rates_inr": self.gross_sum - self.charges_today_sum,
            "avg_day_inr": net / n,
            "median_day_inr": statistics.median(v),
            "win_rate": sum(x > 0 for x in v) / n,
            "worst_day_inr": min(v),
            "max_drawdown_inr": dd,
            "dd_trough_day_index": trough,
            "recovery_days": (recovered - trough) if recovered is not None else (n - 1 - trough),
            "dd_recovered": recovered is not None,
            "ulcer_index_inr": ulcer,
            "cvar95_day_inr": cvar95(v),
            "losing_streak_days": losing_streak(v),
            "annual_net_inr": annual,
            "calmar": ratio(annual, abs(dd)) if dd < 0 else float("inf"),
            "martin": ratio(annual, ulcer) if ulcer > 0 else float("inf"),
            "capital_inr": capital_inr,
            "return_on_capital_pct": ratio(annual, capital_inr) * 100
            if capital_inr
            else float("nan"),
            "mtm_stop_days": self.mtm_stop_days,
            "mtm_stop_frequency": self.mtm_stop_days / n,
            "n_trades": self.n_trades,
            "orders_per_day": ORDERS_PER_TRADE * self.n_trades / n,
            "charges_per_day_inr": self.charges_sum / n,
            "charge_drag": ratio(self.charges_sum, self.positive_gross),
            "trade_expectancy_inr": ratio(self.sum_win + self.sum_loss, self.n_trades),
            "trade_win_rate": ratio(self.n_win, self.n_trades),
            "profit_factor": ratio(self.sum_win, abs(self.sum_loss))
            if self.sum_loss
            else float("inf"),
            "avg_winner_inr": avg_win,
            "avg_loser_inr": avg_loss,
            "payoff_ratio": ratio(avg_win, abs(avg_loss))
            if self.n_loss and self.n_win
            else float("nan"),
            "entry_days": self.entry_days,
            "no_entry_days": self.no_entry_days,
            "entry_hit_rate": self.entry_days / n,
            "avg_hold_minutes": ratio(self.hold_sum, self.hold_n),
            "ce_entries": self.ce_entries,
            "pe_entries": self.pe_entries,
            "ce_net_inr": self.ce_net,
            "pe_net_inr": self.pe_net,
            "reentry_count": self.reentry_count,
            "reentry_net_inr": self.reentry_net,
            "one_leg_sl_days": self.one_leg_sl_days,
            "both_leg_sl_days": self.both_leg_sl_days,
            "premium_outlay_peak_inr": self.outlay_peak,
            **{f"exit_{k.lower()}_count": c for k, c in self.exit_counts.items()},
        }


def execution_for(slippage: float, lot_sizing: str) -> Execution | None:
    if slippage == 0 and lot_sizing == "current":
        return None
    return Execution(slippage_pct=slippage, lot_sizing=lot_sizing)


def run_cohort(
    family: str,
    index: str,
    slot: str,
    params_list: list[dict[str, Any] | None],
    days: list[date],
    root: str,
    slippage: float,
    lot_sizing: str,
    run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    started = time.monotonic()
    reference = default_reference_data()
    sizing_date = date.fromisoformat(SIZING_DATE)
    underlying = grid.INDICES[index]
    template = grid.load_template(family, index, slot)
    execution = execution_for(slippage, lot_sizing)
    cells = [grid.Cell(family, index, slot, p) for p in params_list]
    strategies = [grid.build(c, template, execution=execution) for c in cells]
    stats = [Stats(underlying) for _ in cells]
    # Owner (2026-10-15): the unit is rupees per lot; no return-on-margin view. The capital
    # column is kept only where a margin row happens to exist, never required.
    capital = None
    if family in ("W", "D"):
        try:
            capital = reference.margin_per_lot(underlying, "short-straddle", sizing_date)
        except ValueError:
            capital = None
    used: list[date] = []
    skipped: dict[str, str] = {}
    for day in days:
        try:
            data = load_day(Path(root), underlying, day)
        except FileNotFoundError:
            skipped[day.isoformat()] = "no index or option file"
            continue
        except MissingReferenceData as error:
            skipped[day.isoformat()] = f"reference: {error}"
            continue
        used.append(day)
        for strategy, stat in zip(strategies, stats, strict=True):
            stat.add(simulate_day(strategy, data, reference, sizing_date))
    rows = []
    for cell, stat in zip(cells, stats, strict=True):
        row: dict[str, Any] = {
            "cohort": cell.cohort,
            "family": family,
            "index": index,
            "underlying": underlying,
            "slot": slot,
            "band": grid.band(slot),
            "label": cell.label,
            **grid.params_to_row(family, cell.params),
            "slippage_pct": slippage,
            "lot_sizing": lot_sizing,
            "grid_version": grid.GRID_VERSION,
        }
        row.update(stat.finish(capital))
        rows.append(row)
    matrix = np.array([s.values for s in stats], dtype=np.float32).T  # days x cells
    seconds = time.monotonic() - started
    return {
        "rows": rows,
        "matrix": matrix,
        "labels": [c.label for c in cells],
        "days": [d.isoformat() for d in used],
        "skipped": skipped,
        "run": run,
        "seconds": seconds,
        "ms_per_cell_day": 1000 * seconds / max(1, len(cells) * len(used)),
        "rss_mb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6,
    }


def cohort_days(
    root: Path, underlying: str, start: date, end: date, weekends: bool = False
) -> list[date]:
    """Backtest days in [start, end]; weekend sessions (the Budget Saturday) left out as in the
    rotation unless `weekends` (the BL-096/097/098 sweeps kept them — the regression check)."""
    days, _ = backtest_days(root, underlying, start, end)
    return [d for d in days if weekends or d.weekday() < 5]


def load_cells_file(path: Path) -> dict[tuple[str, str, str], list[dict[str, Any] | None]]:
    """A JSON list of {family, index, slot, params} (params null = the template cell) -> jobs."""
    jobs: dict[tuple[str, str, str], list[dict[str, Any] | None]] = {}
    for item in json.loads(path.read_text()):
        params = item["params"]
        if params is not None:
            params = {k: tuple(v) if isinstance(v, list) else v for k, v in params.items()}
        jobs.setdefault((item["family"], item["index"], item["slot"]), []).append(params)
    return jobs


def signature(args: argparse.Namespace, job: tuple[Any, ...]) -> dict[str, Any]:
    """What a part was run with; a part on disk is reused only when this matches (review of
    PR #218: a smoke part left under a tag must not be mistaken for a whole cohort)."""
    return {
        "grid": grid.grid_sha(),
        "from": args.start,
        "to": args.end,
        "weekends": bool(args.weekends),
        "n_cells": len(job[3]),
        "slippage": job[6],
        "lot_sizing": job[7],
    }


def part_matches(out_dir: Path, name: str, expected: dict[str, Any]) -> bool:
    part = out_dir / "parts" / f"{name}.csv"
    meta = out_dir / "series" / f"{name}.json"
    if not part.exists() or not meta.exists():
        return False
    run = json.loads(meta.read_text()).get("run")
    if run is None:  # written before signatures existed (the 2026-10-14 Stage-1 run)
        print(f"{name}: unsigned part kept (pre-signature run)", flush=True)
        return True
    if run != expected:
        print(
            f"{name}: part on disk was run with {run}, expected {expected}; rerunning", flush=True
        )
        return False
    return True


def write_part(out_dir: Path, name: str, result: dict[str, Any]) -> None:
    series_dir = out_dir / "series"
    parts_dir = out_dir / "parts"
    series_dir.mkdir(parents=True, exist_ok=True)
    parts_dir.mkdir(parents=True, exist_ok=True)
    np.save(series_dir / f"{name}.npy", result["matrix"])
    (series_dir / f"{name}.json").write_text(
        json.dumps(
            {
                "labels": result["labels"],
                "days": result["days"],
                "skipped": result["skipped"],
                "run": result["run"],
            }
        )
    )
    part = parts_dir / f"{name}.csv"
    temporary = part.with_suffix(".tmp")
    with temporary.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(result["rows"][0]))
        writer.writeheader()
        writer.writerows(result["rows"])
    temporary.replace(part)


def summarise(out_dir: Path) -> None:
    by_family: dict[str, list[dict[str, str]]] = {}
    for part in sorted((out_dir / "parts").glob("*.csv")):
        with part.open(newline="") as handle:
            for row in csv.DictReader(handle):
                by_family.setdefault(row["family"], []).append(row)
    for family, rows in by_family.items():
        path = out_dir / f"{family}_summary.csv"
        with path.open("w", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        print(f"wrote {len(rows)} rows to {path}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--family", default="all", help="W | D | B | all")
    parser.add_argument("--index", default="all", help="N | S | all")
    parser.add_argument(
        "--slots", default="grid", help="comma list of HH:MM, 'grid' (the 7), or 'all25'"
    )
    parser.add_argument("--cells", type=Path, help="JSON list of cells to run instead of the grid")
    parser.add_argument("--from", dest="start", default=FROM.isoformat())
    parser.add_argument("--to", dest="end", default=TO.isoformat())
    parser.add_argument("--tag", default="stage1", help="results/<tag>/")
    parser.add_argument("--root", type=Path, default=None, help="TRADING_DATA_ROOT override")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--slippage", type=float, default=0.0, help="execution.slippage_pct")
    parser.add_argument("--lot-sizing", default="current", choices=("current", "historical"))
    parser.add_argument(
        "--limit", type=int, default=0, help="first N cells per cohort (smoke runs)"
    )
    parser.add_argument(
        "--weekends",
        action="store_true",
        help="keep weekend sessions (regression vs BL-096/097/098)",
    )
    parser.add_argument("--summarise-only", action="store_true")
    args = parser.parse_args()

    out_dir = RESULTS / args.tag
    if args.summarise_only:
        summarise(out_dir)
        return
    root = args.root or data_dir()
    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    families = grid.FAMILIES if args.family == "all" else tuple(args.family.split(","))
    indices = tuple(grid.INDICES) if args.index == "all" else tuple(args.index.split(","))
    if args.slots == "grid":
        slots: tuple[str, ...] = grid.SLOTS
    elif args.slots == "all25":
        slots = tuple(
            sorted(
                {p.stem[-4:][:2] + ":" + p.stem[-2:] for p in grid.ROTATION.glob("N_wide_*.yaml")}
            )
        )
    else:
        slots = tuple(args.slots.split(","))

    if args.cells:
        jobs = load_cells_file(args.cells)
        jobs = {
            k: v
            for k, v in jobs.items()
            if k[0] in families and k[1] in indices and (args.slots == "grid" or k[2] in slots)
        }
    else:
        jobs = {}
        for family in families:
            for index in indices:
                for slot in slots:
                    if not grid.template_path(family, index, slot).exists():
                        print(f"no template for {family} {index} {slot}; skipped", flush=True)
                        continue
                    jobs[(family, index, slot)] = [
                        c.params for c in grid.cells(family, index, slot)
                    ]
    if args.limit:
        jobs = {k: v[: args.limit] for k, v in jobs.items()}

    days_cache: dict[str, list[date]] = {}
    submissions: list[tuple[str, tuple[Any, ...]]] = []
    for (family, index, slot), params_list in jobs.items():
        underlying = grid.INDICES[index]
        if underlying not in days_cache:
            days_cache[underlying] = cohort_days(root, underlying, start, end, args.weekends)
        cohort = grid.Cell(family, index, slot, None).cohort
        submissions.append(
            (
                cohort,
                (
                    family,
                    index,
                    slot,
                    params_list,
                    days_cache[underlying],
                    str(root),
                    args.slippage,
                    args.lot_sizing,
                ),
            )
        )
    pending = [(n, a) for n, a in submissions if not part_matches(out_dir, n, signature(args, a))]
    n_cells = sum(len(a[3]) for _, a in submissions)
    print(
        f"tag={args.tag} jobs={len(submissions)} pending={len(pending)} cells={n_cells} "
        f"days={ {u: len(d) for u, d in days_cache.items()} } workers={args.workers} grid={grid.grid_sha()}",
        flush=True,
    )
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_cohort, *a, signature(args, a)): n for n, a in pending}
        for future in as_completed(futures):
            name = futures[future]
            result = future.result()
            write_part(out_dir, name, result)
            print(
                f"done {name}: {len(result['rows'])} cells x {len(result['days'])} days in "
                f"{result['seconds']:.0f}s ({result['ms_per_cell_day']:.2f} ms/cell-day, "
                f"rss {result['rss_mb']:.0f} MB, skipped {len(result['skipped'])})",
                flush=True,
            )
    summarise(out_dir)


if __name__ == "__main__":
    main()
