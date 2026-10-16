"""Experiment 4: the new beyond-the-edge cells (MTM ₹5k/₹6k for Widesl and Dir; wider closest
premiums for Widesl and Buy), at the 12 sampled slots, in the stored-parameter form the BL-104 list
builder looks up. Only cells not already stored are written.

    uv run python research/bl107/edges_cells.py   ->  research/bl107/edges_cells_2026-10-16.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import daytype_lists as dl  # noqa: E402
import grid  # noqa: E402

NEW_MTM = {"W": (5000, 6000), "D": (5000, 6000)}
NEW_PREMIUMS = {
    "NIFTY_Widesl_premium": (210, 250),
    "SENSEX_Widesl_premium": (560, 640),
    "NIFTY_Buy_premium": (150, 200),
    "SENSEX_Buy_premium": (400, 500),
}


def settings(f: dl.Family, slot: str) -> list[dict]:
    """Every stored-form parameter set of the family in the widened grid."""
    base = []
    for c in grid.cells(f.fam, f.idx, slot, with_template=False):
        p = c.params
        if f.fam in ("W", "D") and p["mtm"] is None:
            continue
        base.append(p)
    if f.fam in NEW_MTM:
        base += [{**p, "mtm": m} for p in base if p["mtm"] == 4000 for m in NEW_MTM[f.fam]]
    names = {v: k for k, v in grid.PREMIUM.get(f.fam, {}).get(grid.INDICES[f.idx], {}).items()}
    out = []
    if not f.is_premium:
        return [p for p in base if p["strike"] == f.strike]
    anchor = {"W": "OTM1", "B": "ATM"}[f.fam]
    premiums = sorted(set(f.premiums) | set(dl.refined_premiums(f, slot)) | set(NEW_PREMIUMS[f.name]))
    for p in base:
        if p["strike"] != anchor:
            continue
        for pr in premiums:
            out.append({**p, "strike": names.get(pr, pr)})
    return out


def main() -> None:
    cells, seen = [], set()
    for f in dl.FAMILIES:
        for slot in dl.ALL_SLOTS:
            for p in settings(f, slot):
                key = json.dumps([f.fam, f.idx, slot, p], sort_keys=True, default=list)
                if key in seen or any(dl._has(t, f, slot, p) for t in dl.TAGS):
                    continue
                seen.add(key)
                cells.append({"family": f.fam, "index": f.idx, "slot": slot, "params": p})
    path = HERE / "edges_cells_2026-10-16.json"
    path.write_text(json.dumps(cells, default=list))
    from collections import Counter

    print(len(cells), "new cells", Counter((c["family"], c["index"]) for c in cells))


if __name__ == "__main__":
    main()
