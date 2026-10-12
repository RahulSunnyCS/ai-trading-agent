"""BL-096 enriched diagnostics for the registered Directional shortlist.

This deliberately runs the generic engine so the diagnostics come from the same
trade ledger as the production simulation.  It writes a new summary file and
does not modify strategy YAMLs or the earlier primary/secondary summaries.
"""

from __future__ import annotations

import argparse
import csv
import math
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from typing import Any

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import ReEntry, TrailSL, load_legwise
from option_backtesting.rotation.lists import SIZING_DATE

HERE = Path(__file__).parent
PACKAGE = HERE.parent.parent
STRATEGIES = PACKAGE / "strategies" / "rotation"
RESULTS = HERE / "results"
FROM = date(2024, 10, 9)
TO = date(2026, 10, 9)
FIT_END = date(2025, 10, 8)

PRIMARY = (
    (21, 3000, "15:28"),
    (25, 4000, "15:28"),
    (30, 4000, "15:28"),
    (25, 3500, "15:28"),
)

ALL_PRIMARY = tuple(
    (sl, mtm, exit_time)
    for sl in (10, 15, 21, 25, 30, 35)
    for mtm in (2000, 2500, 3000, 3500, 4000)
    for exit_time in ("14:50", "15:00", "15:10", "15:20", "15:28")
)

# The core sweep already covers every secondary variant.  Exact trade-ledger
# diagnostics are run on the decision shortlist: the original baseline plus
# the strongest secondary alternatives for each primary cell.
DIAGNOSTIC_VARIANTS = {
    (21, 3000, "15:28"): (("cost1", None, None), ("cost2", None, None), ("cost1", None, (10, 5))),
    (25, 4000, "15:28"): (("cost1", None, None), ("cost2", None, None), ("cost1", None, (15, 5))),
    (30, 4000, "15:28"): (("cost1", None, None), ("cost2", None, None), ("cost1", None, (10, 5))),
    (25, 3500, "15:28"): (("cost1", None, None), ("cost2", None, None), ("cost1", None, (15, 5))),
}


def base_paths() -> list[Path]:
    patterns = ("N_dir_*.yaml", "N_ditm1_*.yaml", "S_dir_*.yaml", "S_ditm1_*.yaml")
    return sorted(p for pattern in patterns for p in STRATEGIES.glob(pattern))


def strike_type(strategy: Any) -> str:
    values = {leg.strike.strike_type for leg in strategy.legs}
    return next(iter(values)) if len(values) == 1 else "+".join(sorted(str(v) for v in values))


def variants() -> list[tuple[str, str | None, tuple[int, int] | None]]:
    out = []
    for mode, count in (("none", 0), ("cost", 1), ("cost", 2), ("asap", 1), ("asap", 2)):
        out.append((f"{mode}{count or ''}", None, None))
    for cutoff in ("11:00", "12:00", "13:00"):
        out.append(("cost1", cutoff, None))
    for trail in ((5, 5), (10, 5), (15, 5)):
        out.append(("cost1", None, trail))
    return out


def diagnostic_variants(primary: tuple[int, int, str]) -> tuple[tuple[str, str | None, tuple[int, int] | None], ...]:
    return DIAGNOSTIC_VARIANTS[primary]


STT_SELL = ((date(2000, 1, 1), 0.0010), (date(2026, 4, 1), 0.0015))
EXCHANGE = {"N": 0.0003503, "S": 0.000325}
SEBI = 0.000001
IPFT_NSE = 0.000005
STAMP_BUY = 0.00003
GST = 0.18
BROKERAGE_PER_ORDER = 20.0


def stt_rate(day: date) -> float:
    return [rate for start, rate in STT_SELL if day >= start][-1]


def trade_charges(underlying: str, day: date, trade: Any) -> dict[str, float]:
    """Apply the registered Indian option-charge model to one completed trade."""
    if trade.exit_price is None:
        return {key: 0.0 for key in ("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst")}
    is_nse = underlying == "NIFTY"
    index = "N" if is_nse else "S"
    sell = (trade.entry_price if trade.position == "sell" else trade.exit_price) * trade.qty
    buy = (trade.exit_price if trade.position == "sell" else trade.entry_price) * trade.qty
    both = sell + buy
    brokerage = 2.0 * BROKERAGE_PER_ORDER
    stt = stt_rate(day) * sell
    exchange = EXCHANGE[index] * both
    sebi = SEBI * both
    ipft = IPFT_NSE * both if is_nse else 0.0
    stamp = STAMP_BUY * buy
    gst = GST * (brokerage + exchange + sebi + ipft)
    return {
        "brokerage": brokerage,
        "stt": stt,
        "exchange": exchange,
        "sebi_ipft": sebi + ipft,
        "stamp": stamp,
        "gst": gst,
    }


def mutate(base: Any, primary: tuple[int, int, str], secondary: tuple[str, str | None, tuple[int, int] | None]) -> Any:
    sl, mtm, exit_time = primary
    reentry, cutoff, trail = secondary
    strategy = base.model_copy(deep=True)
    strategy.exit_time = exit_time
    strategy.no_reentry_after = cutoff
    strategy.overall.stop_loss_inr = mtm
    mode = None if reentry == "none" else reentry.rstrip("12")
    count = 0 if mode is None else int(reentry[-1])
    for leg in strategy.legs:
        leg.stop_loss = leg.stop_loss.model_copy(update={"percent": sl, "points": None})
        leg.reentry_on_sl = None if mode is None else ReEntry(mode=mode, count=count)
        leg.trail_sl = None if trail is None else TrailSL(percent=trail)
    return strategy


def cvar95(values: list[float]) -> float:
    if not values:
        return float("nan")
    n = max(1, math.ceil(len(values) * 0.05))
    return sum(sorted(values)[:n]) / n


def max_drawdown(values: list[float]) -> float:
    equity = 0.0
    peak = 0.0
    worst = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return worst


def ulcer_index(values: list[float]) -> float:
    if not values:
        return float("nan")
    equity = 0.0
    peak = 0.0
    squared_drawdowns = []
    for value in values:
        equity += value
        peak = max(peak, equity)
        squared_drawdowns.append(min(0.0, equity - peak) ** 2)
    return math.sqrt(sum(squared_drawdowns) / len(squared_drawdowns))


class _Stats:
    """Compact streaming accumulator; do not retain hundreds of thousands of DayResults."""

    def __init__(self, strategy: Any) -> None:
        self.cost_per_order = float(strategy.execution.cost_per_order_inr)
        self.underlying = strategy.underlying
        self.gross_values: list[float] = []
        self.charge_values: list[float] = []
        self.values: list[float] = []
        self.trade_net: list[float] = []
        self.charge_totals = {key: 0.0 for key in ("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst")}
        self.ce_net = self.pe_net = 0.0
        self.ce_sl_hits = self.pe_sl_hits = 0
        self.ce_trade_count = self.pe_trade_count = 0
        self.mtm_stop_days = self.one_leg_sl_days = self.both_leg_sl_days = 0
        self.reentry_count = 0
        self.reentry_gross = self.reentry_net = 0.0
        self.exit_counts = {reason.lower(): 0 for reason in ("SL", "TARGET", "OVERALL_SL", "EXIT_TIME", "SQUARE_OFF")}

    def add(self, result: DayResult) -> None:
        day_charges = 0.0
        sl_legs: set[str] = set()
        seen_legs: dict[str, int] = {}
        for trade in result.trades:
            charges = trade_charges(self.underlying, result.day, trade)
            trade_charges_total = sum(charges.values())
            day_charges += trade_charges_total
            for key, value in charges.items():
                self.charge_totals[key] += value
            net = trade.pnl - trade_charges_total
            self.trade_net.append(net)
            leg_count = 0
            if trade.leg_id == "ce":
                self.ce_net += net
                self.ce_trade_count += 1
                self.ce_sl_hits += trade.exit_reason == "SL"
            elif trade.leg_id == "pe":
                self.pe_net += net
                self.pe_trade_count += 1
                self.pe_sl_hits += trade.exit_reason == "SL"
            if trade.exit_reason == "SL":
                sl_legs.add(trade.leg_id)
            if trade.exit_reason.lower() in self.exit_counts:
                self.exit_counts[trade.exit_reason.lower()] += 1
            leg_count = seen_legs.get(trade.leg_id, 0)
            if leg_count:
                self.reentry_count += 1
                self.reentry_gross += trade.pnl
                self.reentry_net += net
            seen_legs[trade.leg_id] = leg_count + 1
        self.gross_values.append(result.gross)
        self.charge_values.append(day_charges)
        self.values.append(result.gross - day_charges)
        if "overall sl" in (result.stopped_by or "").lower():
            self.mtm_stop_days += 1
        self.one_leg_sl_days += len(sl_legs) == 1
        self.both_leg_sl_days += len(sl_legs) >= 2

    def finish(self) -> dict[str, Any]:
        values = self.values
        if not values:
            return {"n_days": 0}
        winners = [value for value in self.trade_net if value > 0]
        losers = [value for value in self.trade_net if value < 0]
        n_trades = len(self.trade_net)
        ordered = sorted(values)
        middle = len(ordered) // 2
        median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2
        return {
            "n_days": len(values),
            "gross_inr": sum(self.gross_values),
            "charges_inr": sum(self.charge_values),
            **{f"charges_{key}_inr": value for key, value in self.charge_totals.items()},
            "net_inr": sum(values),
            "avg_day_inr": sum(values) / len(values),
            "median_day_inr": median,
            "win_rate": sum(value > 0 for value in values) / len(values),
            "worst_day_inr": min(values),
            "max_drawdown_inr": max_drawdown(values),
            "ulcer_index_inr": ulcer_index(values),
            "cvar95_day_inr": cvar95(values),
            "mtm_stop_days": self.mtm_stop_days,
            "mtm_stop_frequency": self.mtm_stop_days / len(values),
            "n_trades": n_trades,
            "trade_expectancy_inr": sum(self.trade_net) / n_trades if n_trades else float("nan"),
            "trade_win_rate": sum(value > 0 for value in self.trade_net) / n_trades if n_trades else float("nan"),
            "profit_factor": sum(winners) / abs(sum(losers)) if losers else float("inf") if winners else float("nan"),
            "avg_winner_inr": sum(winners) / len(winners) if winners else float("nan"),
            "avg_loser_inr": sum(losers) / len(losers) if losers else float("nan"),
            "ce_net_inr": self.ce_net,
            "pe_net_inr": self.pe_net,
            "ce_sl_hits": self.ce_sl_hits,
            "pe_sl_hits": self.pe_sl_hits,
            "ce_trade_count": self.ce_trade_count,
            "pe_trade_count": self.pe_trade_count,
            "one_leg_sl_days": self.one_leg_sl_days,
            "both_leg_sl_days": self.both_leg_sl_days,
            "reentry_count": self.reentry_count,
            "reentry_gross_inr": self.reentry_gross,
            "reentry_net_inr": self.reentry_net,
            "exit_sl_count": self.exit_counts["sl"],
            "exit_target_count": self.exit_counts["target"],
            "exit_overall_sl_count": self.exit_counts["overall_sl"],
            "exit_time_count": self.exit_counts["exit_time"],
            "exit_square_off_count": self.exit_counts["square_off"],
        }


def run_job(
    paths: list[str], underlying: str, days: list[date], root: str, full_primary: bool
) -> list[dict[str, Any]]:
    reference = default_reference_data()
    sizing_date = date.fromisoformat(SIZING_DATE)
    picked = [Path(p) for p in paths if load_legwise(Path(p)).underlying == underlying]
    primary_cells = ALL_PRIMARY if full_primary else PRIMARY
    secondary_cells = (("cost1", None, None),) if full_primary else None
    configs = [
        (p, load_legwise(p), primary, secondary)
        for p in picked
        for primary in primary_cells
        for secondary in (secondary_cells or diagnostic_variants(primary))
    ]
    keys = [(p.stem, primary, secondary) for p, _base, primary, secondary in configs]
    stats = {
        key: {"fit": _Stats(mutate(base, primary, secondary)), "holdout": _Stats(mutate(base, primary, secondary)), "full": _Stats(mutate(base, primary, secondary))}
        for (path, base, primary, secondary), key in zip(configs, keys, strict=True)
    }
    for day in days:
        data = load_day(Path(root), underlying, day)
        for path, base, primary, secondary in configs:
            strategy = mutate(base, primary, secondary)
            result = simulate_day(strategy, data, reference, sizing_date)
            key = (path.stem, primary, secondary)
            stats[key]["full"].add(result)
            stats[key]["fit" if day <= FIT_END else "holdout"].add(result)

    rows: list[dict[str, Any]] = []
    for path, base, primary, secondary in configs:
        strategy = mutate(base, primary, secondary)
        row: dict[str, Any] = {
            "base": path.stem,
            "underlying": strategy.underlying,
            "strike_type": strike_type(strategy),
            "entry_time": strategy.entry_time,
            "primary_sl_percent": primary[0],
            "primary_mtm_sl_inr": primary[1],
            "primary_exit_time": primary[2],
            "reentry": secondary[0],
            "cutoff": secondary[1] or "none",
            "trailing": "none" if secondary[2] is None else f"{secondary[2][0]}%,{secondary[2][1]}%",
            "valid": True,
            "error": "",
        }
        for name in ("fit", "holdout", "full"):
            row.update({f"{name}_{key}": value for key, value in stats[(path.stem, primary, secondary)][name].finish().items()})
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=data_dir())
    parser.add_argument("--output", type=Path, default=RESULTS / "secondary_metrics.csv")
    parser.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument(
        "--full-primary",
        action="store_true",
        help="run all 15,000 primary cells with the baseline secondary setting",
    )
    parser.add_argument(
        "--checkpoint-dir",
        type=Path,
        default=None,
        help="write resumable completed-job CSV parts here",
    )
    parser.add_argument(
        "--checkpoint-rows",
        type=int,
        default=1000,
        help="target maximum rows per checkpoint part",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    n_days, _ = backtest_days(root, "NIFTY", FROM, TO)
    s_days, _ = backtest_days(root, "SENSEX", FROM, TO)
    days = sorted(set(n_days) & set(s_days))
    paths = [str(p) for p in base_paths()]
    if args.checkpoint_dir is None:
        chunks = [paths[i::2] for i in range(2)]
        jobs = [
            (chunk, underlying, days, str(root), args.full_primary)
            for underlying in ("NIFTY", "SENSEX")
            for chunk in chunks
        ]
        rows: list[dict[str, Any]] = []
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            for future in [pool.submit(run_job, *job) for job in jobs]:
                rows.extend(future.result())
    else:
        args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        rows_per_base = len(ALL_PRIMARY if args.full_primary else PRIMARY)
        base_chunk = max(1, args.checkpoint_rows // rows_per_base)
        jobs_with_ids: list[tuple[str, tuple[Any, ...], Path]] = []
        for underlying in ("NIFTY", "SENSEX"):
            prefix = "N_" if underlying == "NIFTY" else "S_"
            underlying_paths = [p for p in paths if Path(p).stem.startswith(prefix)]
            for index in range(0, len(underlying_paths), base_chunk):
                chunk_id = f"{underlying.lower()}_{index // base_chunk:03d}"
                part = args.checkpoint_dir / f"{chunk_id}.csv"
                chunk = underlying_paths[index : index + base_chunk]
                jobs_with_ids.append(
                    (chunk_id, (chunk, underlying, days, str(root), args.full_primary), part)
                )
        pending = [(job_id, job, part) for job_id, job, part in jobs_with_ids if not part.exists()]
        print(
            f"checkpoint mode: {len(jobs_with_ids) - len(pending)} completed parts, "
            f"{len(pending)} pending, target_rows={args.checkpoint_rows}, bases_per_part={base_chunk}",
            flush=True,
        )
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(run_job, *job): (job_id, part)
                for job_id, job, part in pending
            }
            for future in as_completed(futures):
                job_id, part = futures[future]
                part_rows = future.result()
                temporary = part.with_suffix(".tmp")
                with temporary.open("w", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=list(part_rows[0]))
                    writer.writeheader()
                    writer.writerows(part_rows)
                temporary.replace(part)
                print(f"checkpointed {job_id}: {len(part_rows)} rows", flush=True)
        rows = []
        for _job_id, _job, part in jobs_with_ids:
            with part.open(newline="") as handle:
                rows.extend(csv.DictReader(handle))
    rows.sort(key=lambda r: (r["base"], r["primary_sl_percent"], r["primary_mtm_sl_inr"], r["reentry"], r["cutoff"], r["trailing"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(
        f"wrote {len(rows)} rows to {args.output}; days={len(days)} bases={len(paths)} "
        f"full_primary={args.full_primary} primary={len(ALL_PRIMARY if args.full_primary else PRIMARY)}"
    )


if __name__ == "__main__":
    main()
