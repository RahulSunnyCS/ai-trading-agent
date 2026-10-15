"""BL-107 step 2: turn the first-year winners into named variants at the rotation's 25 entry times.

Reads ../bl104/results/daytype_fy/winners.json (written by `daytype_lists.py --window first`).
Writes results/cells.json (one row per variant x slot, for simulate.py) and results/sets.json (the
readable table of every added setting: universe, family, day type, scope, every parameter).

T1 = each family's all-times winner (expiry and non-expiry) at all 25 slots; T2 = each band winner at
its band's slots. A winner that is the family's own template adds nothing.

    uv run python research/bl107/build_universe.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402
import otm1_one_setting as o  # noqa: E402

RES = HERE / "results"
WINNERS = HERE.parent / "bl104" / "results" / "daytype_fy" / "winners.json"
ALL25 = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47) if (9, 17) <= (h, m) <= (15, 17)]
BAND_SLOTS = {
    "09:15-10:30": [s for s in ALL25 if s <= "10:17"],
    "10:30-13:00": [s for s in ALL25 if "10:32" <= s <= "13:02"],
    "13:00-15:30": [s for s in ALL25 if s >= "13:17"],
    "all times": ALL25,
}
SAMPLED12 = ("09:17", "09:32", "09:47", "10:17", "10:47", "11:32", "12:17", "13:02", "13:17", "13:47", "14:02", "14:32")
LETTER = {"W": "w", "D": "d", "B": "b"}
TAG = {"expiry": "E", "other": "O"}


def main() -> None:
    winners = json.loads(WINNERS.read_text())
    cells, sets, seen = [], [], {}
    for w in winners:
        if w["kind"] not in TAG or w["params"] is None:
            continue
        universe = "T1" if w["band"] == "all times" else "T2"
        sig = json.dumps([w["fam"], w["index"], w["kind"], w["band"], w["params"]], sort_keys=True)
        if sig in seen:
            continue
        n = len(seen) + 1
        seen[sig] = n
        params = {k: tuple(v) if isinstance(v, list) else v for k, v in w["params"].items()}
        built, dropped = [], []
        for slot in BAND_SLOTS[w["band"]]:
            name = f"{w['index']}_{LETTER[w['fam']]}{TAG[w['kind']]}{n}_{slot.replace(':', '')}"
            try:
                grid.build(grid.Cell(w["fam"], w["index"], slot, params))
            except ValueError as e:
                dropped.append(f"{slot}: {' '.join(str(e).split())[:60]}")
                continue
            built.append(slot)
            cells.append({
                "name": name, "family": w["fam"], "index": w["index"], "slot": slot,
                "params": w["params"], "universe": universe, "kind": w["kind"], "scope": w["band"],
                "set": n, "sampled": slot in SAMPLED12,
            })
        sets.append({
            "set": n, "universe": universe, "family": w["family"], "index": w["index"], "kind": w["kind"],
            "scope": w["band"], "status": w["status"], "params": w["params"],
            "setting": o.pretty({**w["params"], "strike": w["params"]["strike"]}) if w["fam"] == "W" else json.dumps(w["params"], default=list),
            "gain_first_year": w["gain"], "slots": built, "dropped": dropped,
        })
    RES.mkdir(exist_ok=True)
    (RES / "cells.json").write_text(json.dumps(cells, default=list))
    (RES / "sets.json").write_text(json.dumps(sets, default=list, indent=1))
    t1 = [c for c in cells if c["universe"] == "T1"]
    t2 = [c for c in cells if c["universe"] == "T2"]
    print(f"{len(sets)} settings added: T1 {len({c['set'] for c in t1})} settings / {len(t1)} variants, "
          f"T2 {len({c['set'] for c in t2})} settings / {len(t2)} variants")
    print(f"at the 12 sampled times: T1 {sum(c['sampled'] for c in t1)}, T2 {sum(c['sampled'] for c in t2)}")
    for s in sets:
        print(f"  #{s['set']:3d} {s['universe']} {s['family']:22s} {s['kind']:6s} {s['scope']:12s} {s['status']:30s} "
              f"gain(1st yr) {s['gain_first_year']:+5.0f}  {s['setting']}")


if __name__ == "__main__":
    main()
