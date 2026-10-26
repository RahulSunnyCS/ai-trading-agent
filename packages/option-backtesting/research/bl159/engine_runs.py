"""BL-159 reads 2b, 6, 7: the legwise engine on every day of the period, eight strategies per day, each
day loaded once. Writes out/engine_days.csv (day, strategy, gross, charges, net, worst_mtm, stopped_by,
n_trades, orders); a day already in the file is not rerun, so the script resumes.

    uv run python research/bl159/engine_runs.py [--days N] [--from D --to D]
"""

from __future__ import annotations

import argparse
import copy
import csv
import os
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
import yaml  # noqa: E402

from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.legwise.schema import LegwiseStrategy  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

START, END = date(2024, 10, 9), date(2026, 10, 8)
PKG = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "out"
COLUMNS = ["day", "strategy", "gross", "charges", "net", "worst_mtm", "stopped_by", "n_trades", "orders"]


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())["strategy"]


def _leg(id_: str, position: str, option_type: str, strike: str, lots: int = 1, **extra) -> dict:
    return {"id": id_, "lots": lots, "position": position, "option_type": option_type, "expiry": "weekly",
            "strike": {"strike_type": strike}, **extra}


def strategies() -> dict[str, LegwiseStrategy]:
    wide = _load(PKG / "strategies/rotation/N_wide_0917.yaml")
    dir_base = _load(PKG / "strategies/rotation_base/N_dir_atm_0924.yaml")
    out: dict[str, dict] = {"wide_sym": wide, "dir_base": dir_base}

    pe2 = copy.deepcopy(wide)
    [leg for leg in pe2["legs"] if leg["option_type"] == "PE"][0]["strike"] = {"strike_type": "OTM2"}
    out["wide_pe_otm2"] = pe2
    ce2 = copy.deepcopy(wide)
    [leg for leg in ce2["legs"] if leg["option_type"] == "CE"][0]["strike"] = {"strike_type": "OTM2"}
    out["wide_ce_otm2"] = ce2

    for n in (4, 6):
        condor = copy.deepcopy(wide)
        condor["legs"] += [_leg("ce_wing", "buy", "CE", f"OTM{n}"), _leg("pe_wing", "buy", "PE", f"OTM{n}")]
        out[f"condor_otm{n}"] = condor

    for n in (2, 3):
        out[f"ratio_otm{n}"] = {
            "id": f"bl159_ratio_otm{n}", "underlying": "NIFTY", "entry_time": "09:24", "exit_time": "15:28",
            "square_off": "partial",
            "legs": [_leg("ce_long", "buy", "CE", "ATM"), _leg("pe_long", "buy", "PE", "ATM"),
                     _leg("ce_short", "sell", "CE", f"OTM{n}", lots=2), _leg("pe_short", "sell", "PE", f"OTM{n}", lots=2)],
            "overall": {"stop_loss_inr": 3000},
        }
    for name, body in out.items():
        body["id"] = f"bl159_{name}"
    return {name: LegwiseStrategy.model_validate(body) for name, body in out.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0, help="stop after N days (smoke test)")
    ap.add_argument("--from", dest="start", default=START.isoformat())
    ap.add_argument("--to", dest="end", default=END.isoformat())
    args = ap.parse_args()
    root = Path(os.environ.get("TRADING_DATA_ROOT", str(Path.home() / "TradingData")))
    strats = strategies()
    OUT.mkdir(exist_ok=True)
    path = OUT / "engine_days.csv"
    done: set[tuple[str, str]] = set()
    if path.exists():
        with path.open() as f:
            done = {(r["day"], r["strategy"]) for r in csv.DictReader(f)}
    days, left_out = backtest_days(root, "NIFTY", date.fromisoformat(args.start), date.fromisoformat(args.end))
    todo = [d for d in days if any((d.isoformat(), s) not in done for s in strats)]
    if args.days:
        todo = todo[: args.days]
    print(f"{len(days)} days in period, {len(left_out)} left out by data_quality, {len(todo)} to run", flush=True)
    sizing = date.fromisoformat(SIZING_DATE)
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        if new:
            w.writeheader()
        t0 = time.time()
        for i, d in enumerate(todo, 1):
            try:
                data = load_day(root, "NIFTY", d)
            except FileNotFoundError as error:
                print(f"{d}: {error}", flush=True)
                continue
            for name, strategy in strats.items():
                if (d.isoformat(), name) in done:
                    continue
                try:
                    r = simulate_day(strategy, data, None, sizing)
                except Exception as error:  # noqa: BLE001 - recorded, the run goes on
                    w.writerow({"day": d, "strategy": name, "gross": "", "charges": "", "net": "",
                                "worst_mtm": "", "stopped_by": f"ERR {type(error).__name__}: {error}"[:120],
                                "n_trades": 0, "orders": 0})
                    continue
                orders, buy, sell = trade_values(r.trades)
                ch = day_charges("NIFTY", d.isoformat(), orders, buy, sell).total
                w.writerow({"day": d, "strategy": name, "gross": round(r.gross, 2), "charges": round(ch, 2),
                            "net": round(r.gross - ch, 2), "worst_mtm": round(r.worst_mtm, 2),
                            "stopped_by": r.stopped_by or "", "n_trades": len(r.trades), "orders": orders})
            f.flush()
            if i % 10 == 0 or i == len(todo):
                el = time.time() - t0
                print(f"{i}/{len(todo)} days, {el:.0f}s, {el / i:.1f}s a day", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
