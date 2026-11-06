"""BL-215: T1's selection method (BL-104 daytype_lists, Amendments 1-11, rule R1, one setting per family and
day type) run on one tuning window. `--start --half --end` are the window's first day, the split between the
ranking half and the confirming half, and the first day after it (exclusive). Prints/writes the winners.

    uv run python research/bl215/select_fold.py --start 2024-10-09 --half 2025-04-09 --end 2025-10-09 [--out f.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import daytype_lists as dl  # noqa: E402


def select(start: date, half: date, end: date, max_picks: int | None = None) -> list[dict]:
    dl.WINDOW, dl.WIN, dl.RULE = "custom", (start, half, end), "R1"
    dl.MAX_PICKS = max_picks
    exp = dl.expiries()
    out = []
    for f in dl.FAMILIES:
        results = {slot: dl.evaluate(f, slot, exp[dl.grid.INDICES[f.idx]]) for slot in dl.ALL_SLOTS}
        for kind in ("expiry", "other"):
            agg = dl.aggregate(f, results, kind, dl.ALL_SLOTS)
            allowed = dl.family_premiums(agg)[0] if f.is_premium else None
            dec = dl.decide(f, agg, kind, allowed)
            for r in dec["picks"]:
                out.append({
                    "family": f.name, "fam": f.fam, "index": f.idx, "kind": kind, "status": dec["status"],
                    "is_template": bool(r.get("is_template")), "params": r.get("params"),
                    "gain_first": r["gain_first"], "gain_test": r["gain_test"],
                })
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--half", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--out")
    a = ap.parse_args()
    res = select(date.fromisoformat(a.start), date.fromisoformat(a.half), date.fromisoformat(a.end))
    for w in res:
        if not w["is_template"]:
            print(w["family"], w["kind"], w["status"], w["params"], round(w["gain_first"]), round(w["gain_test"]))
    print(sum(not w["is_template"] for w in res), "non-template settings of", len(res))
    if a.out:
        Path(a.out).write_text(json.dumps(res, default=list, indent=1))
