"""BL-221 extra (owner, 2026-11-15): sell the strike AT the range edge instead of ATM at the break.

Up-break: sell the PE whose strike is the range high rounded to the nearest strike; down-break: the CE at the
range low's strike. The legwise schema takes only ATM / OTMn / ITMn, so the level is written as the offset
from the ATM the engine resolves at the entry minute (same spot: the previous bar's close). Same entries,
21% stop, re-entry at cost x1, exit 15:28, costs and slippage as the registered rule. Exploratory, never a pass.

    uv run python research/bl221/run_level.py
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


def main():
    from option_backtesting.data.providers.base import Right
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.data.resolver import resolve_strike
    from option_backtesting.legwise.engine import MissingReferenceData
    from option_backtesting.legwise.market import load_day
    from option_backtesting.rotation.lists import SIZING_DATE

    table = json.loads((HERE / "out" / "table.json").read_text())
    sizing = date.fromisoformat(SIZING_DATE)
    reference = default_reference_data()
    out, t0 = {}, time.time()
    for key in table["days"]:
        sims = {k: v for k, v in table["table"][key]["sims"].items() if k.startswith("10:00|")}
        if not sims:
            continue
        day = date.fromisoformat(key)
        data = load_day(ROOT, "NIFTY", day)
        hi = max(x for x in data.spot.high[2:45] if x is not None)
        lo = min(x for x in data.spot.low[2:45] if x is not None)
        step = reference.strike_step("NIFTY", day)
        row = {}
        for sk, v in sims.items():
            side, entry = sk.split("|")[1], v["entry"]
            edge = hi if side == "up" else lo
            level = int(edge / step + 0.5) * step
            spot = data.spot.price_at(entry)
            option = "CE" if side == "down" else "PE"
            atm = resolve_strike("NIFTY", "ATM", Right(option), spot, as_of=day, reference=reference).strike
            k = round((level - atm) / step)
            # PE: strike above ATM is ITM; CE: strike above ATM is OTM
            itm = k if option == "PE" else -k
            rule = "ATM" if itm == 0 else (f"ITM{itm}" if itm > 0 else f"OTM{-itm}")
            res = {"level": level, "atm": atm, "rule": rule, "sell": {}}
            for s in SLIPS:
                spec = one_leg(key, entry, side, s)
                spec["legs"][0]["strike"] = {"strike_type": rule}
                try:
                    res["sell"][str(s)] = simulate(spec, data, reference, sizing)
                except MissingReferenceData:
                    res["sell"][str(s)] = None
            row[sk] = res
        out[key] = row
    (HERE / "out" / "table_level.json").write_text(json.dumps(out))
    offs = [v["rule"] for r in out.values() for v in r.values()]
    from collections import Counter
    print(f"{len(out)} days in {time.time() - t0:.0f}s; strike offsets vs ATM:", Counter(offs).most_common(8))


if __name__ == "__main__":
    main()
