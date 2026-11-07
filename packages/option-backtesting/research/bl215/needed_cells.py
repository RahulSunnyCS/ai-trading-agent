"""BL-215: which cells T1's selection method reads that the Stage 1 run (7 slots) did not run.

Imports the selection code with its results root pointed at results/bl215x (stage1 -> bl215_stage1, extra ->
bl215_extra), records every series it asks for and cannot find, and writes them as a --cells file for
`research/bl104/run_grid.py` (tag bl215_extra). Re-run after the extra run: it must report 0 missing.

    uv run python research/bl215/needed_cells.py --out research/bl215/extra_cells.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import daytype_lists as dl  # noqa: E402


def configure(root: Path) -> None:
    # the two runs, under the tag names the selection code reads (the link to the extra run was once missing and every
    # cell then read as missing, so they are made here rather than by hand)
    root.mkdir(parents=True, exist_ok=True)
    for tag, target in (("stage1", "../bl215_stage1"), ("extra", "../bl215_extra")):
        if not (root / tag).exists():
            (root / tag).symlink_to(target)
    dl.RESULTS = root
    dl.TAGS = ("stage1", "extra")
    dl._SERIES.clear()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    ap.add_argument("--index", default="N")
    a = ap.parse_args()
    configure(HERE.parent / "bl104" / "results" / "bl215x")
    days, _, _ = dl.series("stage1", "B_N_0917")
    missing: dict[str, dict] = {}
    real = dl.column

    def column(tag, f, slot, params):
        try:
            return real(tag, f, slot, params)
        except (KeyError, FileNotFoundError):
            missing[json.dumps([f.fam, f.idx, slot, params], default=list, sort_keys=True)] = {
                "family": f.fam,
                "index": f.idx,
                "slot": slot,
                "params": params,
            }
            return days, np.zeros(len(days))

    real_has = dl._has

    def has(tag, f, slot, params):
        # the last tag claims a premium cell that no tag holds, so the selection asks for it and it is recorded
        return real_has(tag, f, slot, params) or (tag == dl.TAGS[-1] and f.is_premium)

    dl._has = has
    dl.column = column
    exp = dl.expiries()
    for f in dl.FAMILIES:
        if f.idx != a.index:
            continue
        for slot in dl.ALL_SLOTS:
            dl.evaluate(f, slot, exp[dl.grid.INDICES[f.idx]])
    cells = list(missing.values())
    from collections import Counter

    print(len(cells), "missing cells;", dict(Counter((c["family"], c["slot"]) for c in cells)))
    if a.out:
        a.out.write_text(json.dumps(cells, default=list))


if __name__ == "__main__":
    main()
