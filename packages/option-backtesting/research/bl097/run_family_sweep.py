"""Run the registered Buy or Widesl one-factor sweep with post-charge metrics.

This research runner never edits strategy YAMLs.  It mutates loaded strategy
objects in memory, writes resumable checkpoint parts, then writes one summary
CSV for the requested family.
"""

from __future__ import annotations

import argparse
import csv
import math
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import (
    LegwiseStrategy,
    RangeBreakout,
    ReEntry,
    Strike,
    TrailSL,
    load_legwise,
)
from option_backtesting.rotation.lists import SIZING_DATE

HERE = Path(__file__).parent
PACKAGE = HERE.parent.parent
STRATEGIES = PACKAGE / "strategies" / "rotation"
RESULTS = HERE / "results"
FROM = date(2024, 10, 9)
TO = date(2026, 10, 9)
FIT_END = date(2025, 10, 8)

# Same registered charge model as BL-096.
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
    if trade.exit_price is None:
        return {key: 0.0 for key in ("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst")}
    is_nse = underlying == "NIFTY"
    index = "N" if is_nse else "S"
    sell = (trade.entry_price if trade.position == "sell" else trade.exit_price) * trade.qty
    buy = (trade.exit_price if trade.position == "sell" else trade.entry_price) * trade.qty
    both = sell + buy
    brokerage = 2.0 * BROKERAGE_PER_ORDER
    exchange = EXCHANGE[index] * both
    sebi = SEBI * both
    ipft = IPFT_NSE * both if is_nse else 0.0
    return {
        "brokerage": brokerage,
        "stt": stt_rate(day) * sell,
        "exchange": exchange,
        "sebi_ipft": sebi + ipft,
        "stamp": STAMP_BUY * buy,
        "gst": GST * (brokerage + exchange + sebi + ipft),
    }


def hhmm_plus(value: str, minutes: int) -> str:
    parsed = datetime.strptime(value, "%H:%M") + timedelta(minutes=minutes)
    return parsed.strftime("%H:%M")


def strike_label(leg: Any) -> str:
    if leg.strike.strike_type is not None:
        return leg.strike.strike_type
    return f"P{leg.strike.closest_premium:g}"


def family_paths(family: str) -> list[Path]:
    if family == "buy":
        patterns = ("N_buy_*.yaml", "S_buy_*.yaml")
    else:
        patterns = (
            "N_wide_*.yaml", "N_p*.yaml", "S_wide_*.yaml", "S_p*.yaml",
        )
    return sorted({path for pattern in patterns for path in STRATEGIES.glob(pattern)})


@dataclass(frozen=True)
class Variant:
    name: str
    kind: str
    value: Any = None


def buy_variants() -> list[Variant]:
    out = [Variant("baseline", "baseline")]
    out += [Variant(f"strike_{x}", "strike", x) for x in ("ATM", "OTM1", "OTM2")]
    out += [Variant(f"premium_{x:g}", "premium", x) for x in (30, 40, 60, 75, 100)]
    out += [Variant(f"leg_sl_{x:g}", "sl", x) for x in (15, 20, 30, 35, 40)]
    out += [Variant(f"mtm_{x:g}", "mtm", x) for x in (1000, 1500, 2500, 3000, 4000)]
    out += [
        Variant("trail_none", "trail", None),
        Variant("trail_0.5_0.5", "trail", ("points", (0.5, 0.5))),
        Variant("trail_2_1", "trail", ("points", (2, 1))),
        Variant("trail_3_1", "trail", ("points", (3, 1))),
    ]
    out += [Variant(f"range_plus_{x}", "range", x) for x in (5, 15, 20, 30)]
    out += [Variant(f"gap_{x:g}pct", "gap", x) for x in (0.5, 1, 2)]
    out += [Variant(f"valid_plus_{x}", "valid", x) for x in (15, 30, 60, 120)]
    out += [Variant("source_underlying", "source", "underlying")]
    out += [Variant(f"exit_{x.replace(':', '')}", "exit", x) for x in ("14:50", "15:00", "15:10", "15:20", "15:28")]
    out += [Variant("re_cost1", "reentry", ("cost", 1)), Variant("re_cost2", "reentry", ("cost", 2))]
    out += [Variant("re_asap1", "reentry", ("asap", 1)), Variant("re_asap2", "reentry", ("asap", 2))]
    out += [Variant(f"re_cost1_cutoff_{x.replace(':', '')}", "reentry_cutoff", ("cost", 1, x)) for x in ("11:00", "12:00", "13:00")]
    out += [Variant("squareoff_complete", "squareoff", "complete")]
    return out


def widesl_variants() -> list[Variant]:
    out = [Variant("baseline", "baseline")]
    out += [Variant(f"leg_sl_{x:g}", "sl", x) for x in (80, 90, 100, 110, 120, 130, 140, 150)]
    out += [Variant("mtm_none", "mtm", None)]
    out += [Variant(f"mtm_{x:g}", "mtm", x) for x in (1000, 1500, 2000, 3000, 3500, 4000)]
    out += [
        Variant("trail_none", "trail", None),
        Variant("trail_5_5", "trail", ("percent", (5, 5))),
        Variant("trail_10_5", "trail", ("percent", (10, 5))),
        Variant("trail_20_10", "trail", ("percent", (20, 10))),
        Variant("trail_20_15", "trail", ("percent", (20, 15))),
    ]
    out += [Variant(f"exit_{x.replace(':', '')}", "exit", x) for x in ("14:50", "15:00", "15:10", "15:20")]
    out += [Variant("re_cost1", "reentry", ("cost", 1)), Variant("re_cost2", "reentry", ("cost", 2))]
    out += [Variant("re_asap1", "reentry", ("asap", 1)), Variant("re_asap2", "reentry", ("asap", 2))]
    out += [Variant(f"re_cost1_cutoff_{x.replace(':', '')}", "reentry_cutoff", ("cost", 1, x)) for x in ("11:00", "12:00", "13:00")]
    out += [Variant("squareoff_complete", "squareoff", "complete")]
    return out


def set_reentry(leg: Any, value: tuple[str, int] | None) -> None:
    leg.reentry_on_sl = None if value is None else ReEntry(mode=value[0], count=value[1])


def mutate(base: Any, family: str, variant: Variant) -> Any:
    strategy = base.model_copy(deep=True)
    value = variant.value
    if variant.kind == "baseline":
        return LegwiseStrategy.model_validate(strategy.model_dump())
    if variant.kind in {"strike", "premium"}:
        for leg in strategy.legs:
            leg.strike = Strike(strike_type=value) if variant.kind == "strike" else Strike(closest_premium=value)
    elif variant.kind == "sl":
        for leg in strategy.legs:
            leg.stop_loss = leg.stop_loss.model_copy(update={"percent": value, "points": None})
    elif variant.kind == "mtm":
        strategy.overall.stop_loss_inr = value
    elif variant.kind == "trail":
        for leg in strategy.legs:
            if value is None:
                leg.trail_sl = None
            else:
                mode, pair = value
                leg.trail_sl = TrailSL(**{mode: pair})
    elif variant.kind == "range":
        for leg in strategy.legs:
            if leg.range_breakout is not None:
                leg.range_breakout = leg.range_breakout.model_copy(update={"until": hhmm_plus(strategy.entry_time, value)})
    elif variant.kind == "gap":
        for leg in strategy.legs:
            if leg.range_breakout is not None:
                leg.range_breakout = leg.range_breakout.model_copy(update={"gap_percent": value})
    elif variant.kind == "valid":
        for leg in strategy.legs:
            if leg.range_breakout is not None:
                valid_until = hhmm_plus(leg.range_breakout.until, value)
                leg.range_breakout = RangeBreakout.model_validate(
                    {**leg.range_breakout.model_dump(), "valid_until": valid_until}
                )
    elif variant.kind == "source":
        for leg in strategy.legs:
            if leg.range_breakout is not None:
                leg.range_breakout.source = value
    elif variant.kind == "exit":
        strategy.exit_time = value
    elif variant.kind == "reentry":
        for leg in strategy.legs:
            set_reentry(leg, value)
    elif variant.kind == "reentry_cutoff":
        mode, count, cutoff = value
        strategy.no_reentry_after = cutoff
        for leg in strategy.legs:
            set_reentry(leg, (mode, count))
    elif variant.kind == "squareoff":
        strategy.square_off = value
    else:
        raise ValueError(f"unknown variant {variant.kind}")
    return LegwiseStrategy.model_validate(strategy.model_dump())


def cvar95(values: list[float]) -> float:
    if not values:
        return float("nan")
    n = max(1, math.ceil(len(values) * 0.05))
    return sum(sorted(values)[:n]) / n


def max_drawdown(values: list[float]) -> float:
    equity = peak = worst = 0.0
    for value in values:
        equity += value
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return worst


def ulcer_index(values: list[float]) -> float:
    if not values:
        return float("nan")
    equity = peak = 0.0
    squared = []
    for value in values:
        equity += value
        peak = max(peak, equity)
        squared.append(min(0.0, equity - peak) ** 2)
    return math.sqrt(sum(squared) / len(squared))


class Stats:
    def __init__(self, strategy: Any) -> None:
        self.underlying = strategy.underlying
        self.gross_values: list[float] = []
        self.charge_values: list[float] = []
        self.values: list[float] = []
        self.trade_net: list[float] = []
        self.charge_totals = {key: 0.0 for key in ("brokerage", "stt", "exchange", "sebi_ipft", "stamp", "gst")}
        self.entry_days = 0
        self.no_entry_days = 0
        self.ce_entries = self.pe_entries = 0
        self.ce_net = self.pe_net = 0.0
        self.mtm_stop_days = 0
        self.exit_counts = {key: 0 for key in ("SL", "TARGET", "OVERALL_SL", "EXIT_TIME", "SQUARE_OFF")}
        self.hold_minutes: list[int] = []
        self.reentry_count = 0
        self.one_leg_sl_days = self.both_leg_sl_days = 0

    def add(self, result: DayResult) -> None:
        day_charges = 0.0
        sl_legs: set[str] = set()
        seen: set[str] = set()
        if result.trades:
            self.entry_days += 1
        else:
            self.no_entry_days += 1
        for trade in result.trades:
            charges = trade_charges(self.underlying, result.day, trade)
            total = sum(charges.values())
            day_charges += total
            for key, value in charges.items():
                self.charge_totals[key] += value
            net = trade.pnl - total
            self.trade_net.append(net)
            if trade.leg_id == "ce":
                self.ce_entries += 1
                self.ce_net += net
            elif trade.leg_id == "pe":
                self.pe_entries += 1
                self.pe_net += net
            if trade.leg_id in seen:
                self.reentry_count += 1
            seen.add(trade.leg_id)
            if trade.exit_min is not None:
                self.hold_minutes.append(trade.exit_min - trade.entry_min)
            if trade.exit_reason in self.exit_counts:
                self.exit_counts[trade.exit_reason] += 1
            if trade.exit_reason == "SL":
                sl_legs.add(trade.leg_id)
        self.one_leg_sl_days += len(sl_legs) == 1
        self.both_leg_sl_days += len(sl_legs) >= 2
        self.mtm_stop_days += "overall sl" in (result.stopped_by or "").lower()
        self.gross_values.append(result.gross)
        self.charge_values.append(day_charges)
        self.values.append(result.gross - day_charges)

    def finish(self) -> dict[str, Any]:
        values = self.values
        if not values:
            return {"n_days": 0}
        winners = [x for x in self.trade_net if x > 0]
        losers = [x for x in self.trade_net if x < 0]
        ordered = sorted(values)
        mid = len(ordered) // 2
        median = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2
        n_trades = len(self.trade_net)
        return {
            "n_days": len(values), "gross_inr": sum(self.gross_values), "charges_inr": sum(self.charge_values),
            **{f"charges_{key}_inr": value for key, value in self.charge_totals.items()},
            "net_inr": sum(values), "avg_day_inr": sum(values) / len(values), "median_day_inr": median,
            "win_rate": sum(x > 0 for x in values) / len(values), "worst_day_inr": min(values),
            "max_drawdown_inr": max_drawdown(values), "ulcer_index_inr": ulcer_index(values),
            "cvar95_day_inr": cvar95(values), "mtm_stop_days": self.mtm_stop_days,
            "mtm_stop_frequency": self.mtm_stop_days / len(values), "n_trades": n_trades,
            "trade_expectancy_inr": sum(self.trade_net) / n_trades if n_trades else float("nan"),
            "trade_win_rate": sum(x > 0 for x in self.trade_net) / n_trades if n_trades else float("nan"),
            "profit_factor": sum(winners) / abs(sum(losers)) if losers else float("inf") if winners else float("nan"),
            "avg_winner_inr": sum(winners) / len(winners) if winners else float("nan"),
            "avg_loser_inr": sum(losers) / len(losers) if losers else float("nan"),
            "entry_days": self.entry_days, "no_entry_days": self.no_entry_days,
            "entry_hit_rate": self.entry_days / len(values), "no_entry_rate": self.no_entry_days / len(values),
            "ce_entries": self.ce_entries, "pe_entries": self.pe_entries,
            "ce_net_inr": self.ce_net, "pe_net_inr": self.pe_net,
            "avg_hold_minutes": sum(self.hold_minutes) / len(self.hold_minutes) if self.hold_minutes else float("nan"),
            "reentry_count": self.reentry_count, "one_leg_sl_days": self.one_leg_sl_days,
            "both_leg_sl_days": self.both_leg_sl_days,
            **{f"exit_{key.lower()}_count": value for key, value in self.exit_counts.items()},
        }


def run_job(paths: list[str], family: str, days: list[date], root: str, variants: list[Variant]) -> list[dict[str, Any]]:
    reference = default_reference_data()
    sizing_date = date.fromisoformat(SIZING_DATE)
    bases = [(Path(path), load_legwise(Path(path))) for path in paths]
    configs: list[tuple[Path, Any, Variant, Any]] = []
    for path, base in bases:
        for variant in variants:
            try:
                strategy = mutate(base, family, variant)
                configs.append((path, base, variant, strategy))
            except (TypeError, ValueError) as exc:
                configs.append((path, base, variant, exc))
    stats: dict[tuple[str, str], dict[str, Stats]] = {}
    for path, _base, variant, strategy in configs:
        if isinstance(strategy, Exception):
            continue
        stats[(path.stem, variant.name)] = {name: Stats(strategy) for name in ("fit", "holdout", "full")}
    for day in days:
        data = load_day(Path(root), bases[0][1].underlying, day)
        for path, _base, variant, strategy in configs:
            if isinstance(strategy, Exception):
                continue
            result = simulate_day(strategy, data, reference, sizing_date)
            key = (path.stem, variant.name)
            stats[key]["full"].add(result)
            stats[key]["fit" if day <= FIT_END else "holdout"].add(result)
    rows: list[dict[str, Any]] = []
    for path, base, variant, strategy in configs:
        row: dict[str, Any] = {
            "base": path.stem, "family": family, "underlying": base.underlying,
            "entry_time": base.entry_time, "strike_family": "+".join(sorted({strike_label(leg) for leg in base.legs})),
            "variant": variant.name, "parameter": variant.kind, "value": str(variant.value),
            "valid": not isinstance(strategy, Exception), "error": str(strategy) if isinstance(strategy, Exception) else "",
        }
        if not isinstance(strategy, Exception):
            row["mutated_strike_family"] = "+".join(sorted({strike_label(leg) for leg in strategy.legs}))
            for name in ("fit", "holdout", "full"):
                row.update({f"{name}_{key}": value for key, value in stats[(path.stem, variant.name)][name].finish().items()})
        rows.append(row)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", choices=("buy", "widesl"), required=True)
    parser.add_argument("--root", type=Path, default=data_dir())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint-dir", type=Path, required=True)
    parser.add_argument("--checkpoint-rows", type=int, default=1000)
    parser.add_argument("--workers", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    variants = buy_variants() if args.family == "buy" else widesl_variants()
    paths = family_paths(args.family)
    if not paths:
        raise SystemExit(f"no {args.family} strategy files found")
    days_by_underlying = {}
    for underlying in ("NIFTY", "SENSEX"):
        n_days, _ = backtest_days(args.root, underlying, FROM, TO)
        days_by_underlying[underlying] = n_days
    args.checkpoint_dir.mkdir(parents=True, exist_ok=True)
    jobs: list[tuple[str, tuple[Any, ...], Path]] = []
    for underlying in ("NIFTY", "SENSEX"):
        selected = [str(path) for path in paths if load_legwise(path).underlying == underlying]
        base_chunk = max(1, args.checkpoint_rows // len(variants))
        for start in range(0, len(selected), base_chunk):
            chunk = selected[start : start + base_chunk]
            part = args.checkpoint_dir / f"{args.family.lower()}_{underlying.lower()}_{start // base_chunk:03d}.csv"
            jobs.append((part.stem, (chunk, args.family, days_by_underlying[underlying], str(args.root), variants), part))
    pending = [(job_id, job, part) for job_id, job, part in jobs if not part.exists()]
    print(f"family={args.family} bases={len(paths)} variants={len(variants)} jobs={len(jobs)} pending={len(pending)}", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(run_job, *job): (job_id, part) for job_id, job, part in pending}
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
    rows: list[dict[str, Any]] = []
    for _job_id, _job, part in jobs:
        with part.open(newline="") as handle:
            rows.extend(csv.DictReader(handle))
    rows.sort(key=lambda row: (row["base"], row["variant"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    valid = sum(row["valid"] == "True" for row in rows)
    print(f"wrote {len(rows)} rows ({valid} valid) to {args.output}", flush=True)


if __name__ == "__main__":
    main()
