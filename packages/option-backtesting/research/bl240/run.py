"""BL-240: Dir cover-bridge on Core's 21% Dir picks (registered in the item, Phase 0).

Every Dir pick of Core's Adaptive list C in the fit window (2025-01-10 -> 2026-10-08) is re-run by the legwise
engine under 11 arms at 0.5% slippage and ₹23.6 an order: A(M) the pick as it is with overall stop M, H(M) the same
with a cover (a ~₹50 same-side long bought when a sold leg stops, closed when that leg is re-sold), M in
{3000..7000}; W(5000) the cover on the opposite option type (placebo). The primary arms also run at 0% and 1%
slippage. A control run (A(3000), 0% slippage, no charges) must equal the stored Core result to the rupee.

    uv run python research/bl240/run.py --count    # pick-days only, no arm run (logged in the item first)
    uv run python research/bl240/run.py            # -> out/table.json
"""

from __future__ import annotations

import argparse
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

ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
FIT_FROM, FIT_TO = date(2025, 1, 10), date(2026, 10, 8)
DIR_RE = re.compile(r"^[NS]_(dir|ditm1)_")
MS = (3000, 4000, 5000, 6000, 7000)
PRIMARY = 5000
SLIP, COST = 0.5, 23.6
COVER = {
    "lots_ratio": 1.0,
    "stop_loss_percent": None,
    "strike_premium": 50,
    "resell_after_reverse": True,
    "close_on_reentry": True,
}


def with_overall(spec: dict, m: float) -> dict:
    spec = json.loads(json.dumps(spec))
    spec.setdefault("overall", {})["stop_loss_inr"] = float(m)
    return spec


def with_cover(spec: dict, opposite: bool = False) -> dict:
    spec = json.loads(json.dumps(spec))
    for leg in spec["legs"]:
        if leg["position"] == "sell":
            leg["reverse_on_sl"] = {**COVER, **({"opposite": True} if opposite else {})}
    return spec


def arms(spec: dict) -> dict[str, tuple[dict, float]]:
    """{arm: (spec, slippage_pct)}; the primary arms are repeated at 0% and 1%."""
    out: dict[str, tuple[dict, float]] = {}
    for m in MS:
        base = with_overall(spec, m)
        out[f"A{m}"] = (base, SLIP)
        out[f"H{m}"] = (with_cover(base), SLIP)
    out[f"W{PRIMARY}"] = (with_cover(with_overall(spec, PRIMARY), opposite=True), SLIP)
    for slip in (0.0, 1.0):
        for tag, m in (("A", 3000), ("A", PRIMARY), ("H", PRIMARY), ("W", PRIMARY)):
            base = with_overall(spec, m)
            sp = with_cover(base, opposite=tag == "W") if tag != "A" else base
            out[f"{tag}{m}@{slip:g}"] = (sp, slip)
    return out


def pick_days():
    picks = picks_for("core", ROOT, FIT_FROM, FIT_TO)
    return [(d, n) for d in sorted(picks) for n in picks[d] if DIR_RE.match(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", action="store_true")
    args = ap.parse_args()
    items = pick_days()
    if args.count:
        by_name: dict[str, int] = {}
        for _, n in items:
            by_name[n] = by_name.get(n, 0) + 1
        days = {d for d, _ in items}
        print(
            f"{len(items)} pick-days on {len(days)} days; first {items[0][0]}, last {items[-1][0]}"
        )
        print("by index:", {k: sum(v for n, v in by_name.items() if n[0] == k) for k in "NS"})
        return

    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import MissingReferenceData, simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import LegwiseStrategy
    from option_backtesting.rotation import store
    from option_backtesting.rotation.lists import SIZING_DATE

    sizing, ref = date.fromisoformat(SIZING_DATE), default_reference_data()
    with store.slipped(0.0):
        stored = {n: store.read_net(n, ROOT) for n in {n for _, n in items}}
    table: dict[str, dict] = {}
    bad: list[tuple] = []
    skipped: list[str] = []
    t0 = time.time()
    cache: dict[tuple[str, date], object] = {}

    def run_arm(spec: dict, data, slip: float, cost: float) -> dict:
        s = json.loads(json.dumps(spec))
        s["execution"] = {"slippage_pct": slip, "cost_per_order_inr": cost, "lot_sizing": "current"}
        res = simulate_day(LegwiseStrategy.model_validate(s), data, ref, sizing)
        covers = [t for t in res.trades if t.leg_id.endswith("_rev")]
        return {
            "net": res.net,
            "orders": 2 * len(res.trades),
            "stops": sum(1 for t in res.trades if t.exit_reason == "SL"),
            "overall_stop": bool(res.stopped_by and res.stopped_by.startswith("overall SL")),
            "worst_mtm": res.worst_mtm,
            "covers": len(covers),
            "covers_resold": sum(1 for t in covers if t.exit_reason == "COVER"),
            "cover_gross": sum(t.pnl for t in covers),
        }

    for n, (day, name) in enumerate(items):
        und = "NIFTY" if name[0] == "N" else "SENSEX"
        try:
            if (und, day) not in cache:
                cache.clear()
                cache[(und, day)] = load_day(ROOT, und, day)
            data = cache[(und, day)]
            spec = yaml.safe_load(strategy_path(name).read_text())["strategy"]
            ctrl = run_arm(spec, data, 0.0, 0.0)["net"]
            if abs(ctrl - stored[name].get(day, float("nan"))) > 0.01:
                bad.append((day.isoformat(), name, ctrl, stored[name].get(day)))
            row = {"name": name, "arms": {}}
            for arm, (sp, slip) in arms(spec).items():
                row["arms"][arm] = run_arm(sp, data, slip, COST)
            table[f"{day.isoformat()}|{name}"] = row
        except (FileNotFoundError, MissingReferenceData):
            skipped.append(f"{day.isoformat()}|{name}")
            continue
        if n and n % 50 == 0:
            print(f"  {n}/{len(items)}, {time.time() - t0:.0f}s", flush=True)
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    (out / "table.json").write_text(
        json.dumps(
            {"keys": list(table), "table": table, "control_mismatch": bad, "skipped": skipped}
        )
    )
    print(
        f"{len(table)} pick-days ({len(skipped)} skipped) in {time.time() - t0:.0f}s; "
        f"control (0% slippage, no charges) mismatches vs stored: {len(bad)}"
    )
    for b in bad[:8]:
        print("  ", b)


if __name__ == "__main__":
    main()
