"""BL-106 step 2: the candidate pool, chosen from first-year scores only.

From `bl104/results/stage1_y1/<family>_band_winners_tail.csv` (first-year figures, BL-104 tail gate,
Buy day-stop cap 60 %): per family x index x band, band candidates with a day MTM stop, a Widesl leg
stop <= 100 % and no RE COST x2 / RE ASAP; best band robust score first, each taken set differing from
those already taken in at least two settings; up to K = 4. Each set is applied at every rotation slot
of its band. Writes `results/pool_cells.json` (one row per variant: family, index, slot, params, name).

Names follow the picker's `<N|S>_<tag>_<HHMM>`, the tag = family letter + band + set number
(w = Widesl, d = Dir, b = Buy), e.g. N_wA1_0917; replay.py maps them to the picker's families.
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402

Y1 = HERE.parent / "bl104" / "results" / "stage1_y1"
OUT = HERE / "results"
K = 4
AX = {fam: tuple(grid.AXES[fam]) for fam in grid.FAMILIES}
LETTER = {"W": "w", "D": "d", "B": "b"}


def rotation_slots(family: str, index: str) -> list[str]:
    tag = grid.FAMILY_FILE[family]
    return sorted(
        f"{p.stem[-4:-2]}:{p.stem[-2:]}" for p in grid.ROTATION.glob(f"{index}_{tag}_*.yaml")
    )


def ok(family: str, row: dict) -> bool:
    if not row["p_mtm"]:
        return False
    if family == "W" and row["p_sl"] and float(row["p_sl"]) > 100:
        return False
    re = row.get("p_reentry", "")
    return not (re and ('"asap"' in re or '"cost", 2' in re))


def main() -> None:
    cells, sets = [], []
    for fam in grid.FAMILIES:
        with (Y1 / f"{fam}_band_winners_tail.csv").open(newline="") as h:
            rows = list(csv.DictReader(h))
        for idx in grid.INDICES:
            for band in "ABCD":
                g = [
                    r
                    for r in rows
                    if r["index"] == idx
                    and r["band"] == band
                    and r["band_candidate"] == "True"
                    and r["is_template"] != "True"
                    and ok(fam, r)
                ]
                g.sort(key=lambda r: -float(r["band_robust"]))
                picked: list[dict] = []
                for r in g:
                    if all(sum(r[f"p_{a}"] != q[f"p_{a}"] for a in AX[fam]) >= 2 for q in picked):
                        picked.append(r)
                    if len(picked) == K:
                        break
                for k, r in enumerate(picked, 1):
                    params = grid.params_from_row(fam, r)
                    sets.append(
                        {
                            "family": fam,
                            "index": idx,
                            "band": band,
                            "k": k,
                            "params": params,
                            "y1_avg_day_inr": float(r["mean_avg_day_inr"]),
                        }
                    )
                    template = None
                    for slot in rotation_slots(fam, idx):
                        if grid.band(slot) != band:
                            continue
                        cell = grid.Cell(fam, idx, slot, params)
                        try:
                            grid.build(cell, template or grid.load_template(fam, idx, slot))
                        except ValueError:
                            continue  # e.g. an exit before this slot's entry
                        cells.append(
                            {
                                "family": fam,
                                "index": idx,
                                "slot": slot,
                                "params": params,
                                "name": f"{idx}_{LETTER[fam]}{band}{k}_{slot.replace(':', '')}",
                            }
                        )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "pool_cells.json").write_text(json.dumps(cells, indent=1, default=list))
    (OUT / "pool_sets.json").write_text(json.dumps(sets, indent=1, default=list))
    from collections import Counter

    print(f"{len(sets)} sets -> {len(cells)} variants")
    print(
        "sets per family/index/band:",
        dict(sorted(Counter(f"{s['family']}{s['index']}{s['band']}" for s in sets).items())),
    )


if __name__ == "__main__":
    main()
