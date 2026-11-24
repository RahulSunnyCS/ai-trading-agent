"""BL-222: trend-side wide leg stop on T1's Dir picks (registered in the item, Phase 0).

Every T1 Dir pick of the fit window (2025-01-10 -> 2026-10-08) is re-run by the legwise engine under 10 arms:
A0 the pick as it is; S(X) both leg stops raised to X; WCE(X) / WPE(X) only the call / put leg raised to X
(a stop already at or above X is unchanged), X in {30, 40, 50}. ₹23.6 an order and 0.5% slippage on every arm.
A control run at 0% slippage and zero charges must equal the stored T1 result to the rupee.

    uv run python research/bl222/run.py            # -> out/table.json
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PKG = HERE.parents[1]
sys.path.insert(0, str(PKG / "src"))
sys.path.insert(0, str(PKG / "research" / "common"))
from adaptive_picks import picks_for, strategy_path  # noqa: E402
from trend_state import trend_states  # noqa: E402

ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
FROM, TO = date(2025, 1, 1), date(2026, 10, 8)
DIR_RE = re.compile(r"^[NS]_(dir|ditm1)")
XS = (30, 40, 50)
SLIP, COST = 0.5, 23.6


def raise_stops(spec: dict, x: float, legs: tuple[str, ...]) -> dict:
    spec = json.loads(json.dumps(spec))
    for leg in spec["legs"]:
        if leg["id"] in legs and leg.get("stop_loss", {}).get("percent") is not None:
            leg["stop_loss"]["percent"] = max(float(leg["stop_loss"]["percent"]), float(x))
    return spec


def arms(spec: dict) -> dict[str, dict]:
    out = {"A0": spec}
    for x in XS:
        out[f"S{x}"] = raise_stops(spec, x, ("ce", "pe"))
        out[f"WCE{x}"] = raise_stops(spec, x, ("ce",))
        out[f"WPE{x}"] = raise_stops(spec, x, ("pe",))
    return out


def main():
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import MissingReferenceData, simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import LegwiseStrategy
    from option_backtesting.rotation import store
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.ruletest.frame import load_frame

    sizing, ref = date.fromisoformat(SIZING_DATE), default_reference_data()
    frame = load_frame(ROOT, "NIFTY", TO, date(2020, 9, 1))
    state = trend_states(frame)["hourly"]
    picks = picks_for("t1", ROOT, date(2025, 1, 10), TO)
    dir_picks = {d: [n for n in ns if DIR_RE.match(n)] for d, ns in picks.items()}
    days = sorted(d for d in dir_picks if dir_picks[d] and d.isoformat() in state)
    with store.slipped(0.0):
        stored = {n: store.read_net(n, ROOT) for n in {x for d in days for x in dir_picks[d]}}
    table, t0, bad = {}, time.time(), []

    def run_arm(spec, day, data, slip, cost):
        s = json.loads(json.dumps(spec))
        s["execution"] = {"slippage_pct": slip, "cost_per_order_inr": cost, "lot_sizing": "current"}
        res = simulate_day(LegwiseStrategy.model_validate(s), data, ref, sizing)
        return {
            "net": res.net,
            "orders": 2 * len(res.trades),
            "stops": sum(1 for t in res.trades if t.exit_reason == "SL"),
            "worst_mtm": res.worst_mtm,
        }

    for n, day in enumerate(days):
        name = dir_picks[day][0]
        und = "NIFTY" if name[0] == "N" else "SENSEX"
        try:
            data = load_day(ROOT, und, day)
            spec = yaml.safe_load(strategy_path(name).read_text())["strategy"]
            ctrl = run_arm(spec, day, data, 0.0, 0.0)["net"]
            if abs(ctrl - stored[name][day]) > 0.01:
                bad.append((day.isoformat(), name, ctrl, stored[name][day]))
            row = {"name": name, "state": state[day.isoformat()], "arms": {}}
            for arm, sp in arms(spec).items():
                row["arms"][arm] = run_arm(sp, day, data, SLIP, COST)
            table[day.isoformat()] = row
        except (FileNotFoundError, MissingReferenceData):
            continue
        if n and n % 50 == 0:
            print(f"  {n}/{len(days)}, {time.time() - t0:.0f}s", flush=True)
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    (out / "table.json").write_text(json.dumps({"days": list(table), "table": table, "control_mismatch": bad}))
    print(f"{len(table)} pick-days in {time.time() - t0:.0f}s; control (0% slippage, no charges) mismatches vs stored: {len(bad)}")
    for b in bad[:5]:
        print("  ", b)


if __name__ == "__main__":
    main()
