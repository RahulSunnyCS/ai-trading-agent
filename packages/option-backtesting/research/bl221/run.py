"""BL-221: trend-aligned range-break Dir, fit window 2024-10-09 -> 2026-10-08 (Amendment 1).

Per usable NIFTY session: the 09:17 -> range-end index range, the first bar after the range end whose
HIGH is above the range high (LOW below the range low), and the trade entered at the NEXT minute (the
engine's `price_at` = the previous bar's close, so the fill is the break bar's close) as a one-leg
sold ATM weekly option opposite to the break, 21% stop, re-entry at cost x1, out 15:28, simulated by
the verified legwise engine. The trend state uses only hourly (or daily) bars completed before the
session. Everything is simulated once per (day, range end, side, slippage) and the cells, comparators
and placebo draws are selections over those results.

    uv run python research/bl221/run.py --smoke 15      # 15 days, prints timing
    uv run python research/bl221/run.py                 # the registered fit window -> out/

PRIMARY CELL (declared before any run, Amendment 2): range end 10:00, hourly EMA 20/50, break valid
until 12:00. Every other cell is a sensitivity row: a lead there alone is not a pass.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "common"))
from trend_state import LAST, trend_states  # noqa: E402,F401

OUT = HERE / "out"
ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
PKG = HERE.parents[1]

FIT_FROM, FIT_TO = date(2024, 10, 9), date(2026, 10, 8)
RANGE_STARTS = 2  # 09:17 is minute 2 on the 09:15 grid
RANGE_ENDS = {"10:00": 45, "09:45": 30, "10:30": 75}
CUTOFFS = {"12:00": 165, "14:00": 285}
SLIPS = (0.0, 0.5, 1.0)
COST_PER_ORDER = 23.6  # ₹20 + 18% GST, the rotation's convention
PRIMARY = ("10:00", "hourly", "12:00")
SEED = 20261115


def label(minute: int) -> str:
    total = 9 * 60 + 15 + minute
    return f"{total // 60:02d}:{total % 60:02d}"


# ---- trend (point in time): research/common/trend_state.py ----


# ---- breaks ----


def find_breaks(frame, i: int, range_end: int) -> dict:
    """The day's range and the first break bar each way (None = none). Bars from range_end + 1 on."""
    hi = float(np.max(frame.H[i, RANGE_STARTS:range_end]))
    lo = float(np.min(frame.L[i, RANGE_STARTS:range_end]))
    up = next((t for t in range(range_end + 1, 373) if frame.H[i, t] > hi), None)
    dn = next((t for t in range(range_end + 1, 373) if frame.L[i, t] < lo), None)
    prev_close = float(frame.C[i - 1, LAST]) if i else float(frame.O[i, 0])
    return {"up": up, "down": dn, "range_pct": (hi - lo) / prev_close * 100}


# ---- strategies and simulation ----


def one_leg(day_label: str, entry: int, side: str, slip: float, buy: bool = False) -> dict:
    option = "CE" if side == "down" else "PE"  # sell opposite: up-break -> PE, down-break -> CE
    if buy:  # reported only: buy the same-direction option
        option = "CE" if side == "up" else "PE"
    leg = {
        "id": "leg",
        "lots": 1,
        "position": "buy" if buy else "sell",
        "option_type": option,
        "expiry": "weekly",
        "strike": {"strike_type": "ATM"},
        "stop_loss": {"percent": 21},
    }
    if not buy:
        leg["reentry_on_sl"] = {"mode": "cost", "count": 1}
    return {
        "id": f"bl221_{side}_{label(entry)}",
        "underlying": "NIFTY",
        "entry_time": label(entry),
        "exit_time": "15:28",
        "square_off": "partial",
        "legs": [leg],
        "execution": {"slippage_pct": slip, "cost_per_order_inr": COST_PER_ORDER},
    }


def base_dir(slip: float, entry: str | None = None) -> dict:
    spec = yaml.safe_load((PKG / "strategies/rotation_base/N_dir_atm_0924.yaml").read_text())
    spec = spec["strategy"]
    if entry:
        spec["entry_time"] = entry
    spec["execution"] = {"slippage_pct": slip, "cost_per_order_inr": COST_PER_ORDER}
    return spec


def simulate(spec: dict, data, reference, sizing) -> dict:
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.schema import LegwiseStrategy

    res = simulate_day(LegwiseStrategy.model_validate(spec), data, reference, sizing)
    return {
        "net": res.net,
        "gross": res.gross,
        "orders": len(res.trades),
        "traded": bool(res.trades),
        "stopped": res.stopped_by,
    }


def run_all(limit: int | None) -> dict:
    sys.path.insert(0, str(PKG / "src"))
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import MissingReferenceData
    from option_backtesting.legwise.market import backtest_days, load_day
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.ruletest.frame import load_frame

    sizing = date.fromisoformat(SIZING_DATE)
    reference = default_reference_data()
    frame = load_frame(ROOT, "NIFTY", FIT_TO, date(2020, 9, 1))
    at = {d: i for i, d in enumerate(frame.days)}
    trend = trend_states(frame)
    days, skipped = backtest_days(ROOT, "NIFTY", FIT_FROM, FIT_TO, False)
    days = [d for d in days if d.isoformat() in at]
    if limit:
        days = days[:limit]
    table: dict[str, dict] = {}
    t0 = time.time()
    for n, day in enumerate(days):
        key = day.isoformat()
        i = at[key]
        try:
            data = load_day(ROOT, "NIFTY", day)
        except (FileNotFoundError, MissingReferenceData):
            continue
        row = {
            "trend": {k: trend[k][key] for k in trend},
            "breaks": {},
            "sims": {},
            "comp": {},
        }

        def sim(spec, data=data):
            try:
                return simulate(spec, data, reference, sizing)
            except MissingReferenceData:
                return None

        for rname, rend in RANGE_ENDS.items():
            b = find_breaks(frame, i, rend)
            row["breaks"][rname] = b
            for side in ("up", "down"):
                t = b[side]
                if t is None:
                    continue
                entry = t + 1
                row["sims"][f"{rname}|{side}"] = {
                    "entry": entry,
                    "sell": {str(s): sim(one_leg(key, entry, side, s)) for s in SLIPS},
                }
                if rname == "10:00":  # the buy variant is reported for the primary range only
                    row["sims"][f"{rname}|{side}"]["buy"] = {
                        str(s): sim(one_leg(key, entry, side, s, buy=True)) for s in SLIPS
                    }
        row["comp"]["base"] = {str(s): sim(base_dir(s)) for s in SLIPS}
        row["comp"]["dir1001"] = {str(s): sim(base_dir(s, "10:01")) for s in SLIPS}
        table[key] = row
        if n and n % 25 == 0:
            rate = (time.time() - t0) / (n + 1)
            print(f"  {n + 1}/{len(days)} days, {rate:.2f}s/day, ~{rate * (len(days) - n) / 60:.1f} min left", flush=True)
    return {"days": list(table), "table": table, "skipped": {k.isoformat(): v for k, v in skipped.items()}}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", type=int, default=0)
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    t = time.time()
    result = run_all(args.smoke or None)
    name = "smoke.json" if args.smoke else "table.json"
    (OUT / name).write_text(json.dumps(result))
    print(f"{len(result['days'])} days in {time.time() - t:.0f}s -> out/{name}")
