"""BL-221 extras (owner override, 2026-11-15): the same breaks with ITM2 instead of ATM, sold and bought.

Reads out/table.json (the primary range's breaks and entry minutes), simulates the ITM2 variants at those
exact entries and writes out/table_itm2.json. Nothing here changes the registered rule or its cell.

    uv run python research/bl221/run_itm2.py
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import ROOT, SLIPS, one_leg, simulate  # noqa: E402

PKG = HERE.parents[1]
sys.path.insert(0, str(PKG / "src"))


def itm2(spec: dict) -> dict:
    spec = json.loads(json.dumps(spec))
    spec["legs"][0]["strike"] = {"strike_type": "ITM2"}
    spec["id"] += "_itm2"
    return spec


def main():
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import MissingReferenceData
    from option_backtesting.legwise.market import load_day
    from option_backtesting.rotation.lists import SIZING_DATE

    table = json.loads((HERE / "out" / "table.json").read_text())
    sizing = date.fromisoformat(SIZING_DATE)
    reference = default_reference_data()
    out, t0 = {}, time.time()
    for n, key in enumerate(table["days"]):
        sims = {k: v for k, v in table["table"][key]["sims"].items() if k.startswith("10:00|")}
        if not sims:
            continue
        data = load_day(ROOT, "NIFTY", date.fromisoformat(key))
        row = {}
        for sk, v in sims.items():
            side, entry = sk.split("|")[1], v["entry"]
            res = {}
            for kind, buy in (("sell", False), ("buy", True)):
                res[kind] = {}
                for s in SLIPS:
                    try:
                        res[kind][str(s)] = simulate(itm2(one_leg(key, entry, side, s, buy=buy)), data, reference, sizing)
                    except MissingReferenceData:
                        res[kind][str(s)] = None
            row[sk] = res
        out[key] = row
        if n and n % 50 == 0:
            print(f"  {n}/{len(table['days'])}, {time.time() - t0:.0f}s", flush=True)
    (HERE / "out" / "table_itm2.json").write_text(json.dumps(out))
    print(f"{len(out)} days -> out/table_itm2.json in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
