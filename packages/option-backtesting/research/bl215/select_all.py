"""BL-215 Phase 2: T1's selection method (BL-104 daytype_lists, Amendments 1-11, rule R1) run on every fold's
tuning window, and nothing else. Reads series only inside [tune start, tune end); writes `selected.json`.

Tuning windows that end before 2024-10-09 read results/bl215x (stage1 -> bl215_stage1, extra -> bl215_extra;
NIFTY, run for this item); later ones read the original BL-104 results. NIFTY expiry days before 2024-10-09 are
the days the _bl214 store labels dte_n 0 (the observed-expiry list begins 2024-10); from then on the observed list,
as T1's own selection used.

    uv run python research/bl215/select_all.py [--folds 12m,6m] [--only F4,H7] --out research/bl215/selected.json
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
sys.path.insert(0, str(HERE))
import daytype_lists as dl  # noqa: E402
from folds import ALL_FOLDS, NEW_ERA  # noqa: E402

ORIG_RESULTS, ORIG_TAGS = dl.RESULTS, dl.TAGS
OLD_RESULTS = ORIG_RESULTS / "bl215x"
OLD_DAYS_CSV = Path("/Volumes/TradingData/_bl214/rotation/days.csv")


def expiries() -> dict[str, set[date]]:
    out = _orig_expiries()
    with OLD_DAYS_CSV.open(newline="") as h:
        for r in csv.DictReader(h):
            d = date.fromisoformat(r["day"])
            if d < NEW_ERA and r["dte_n"] == "0":
                out["NIFTY"].add(d)
    return out


_orig_expiries = dl.expiries
dl.expiries = expiries


def select(start: date, half: date, end: date) -> list[dict]:
    old = end <= NEW_ERA
    dl.RESULTS, dl.TAGS = (OLD_RESULTS, ("stage1", "extra")) if old else (ORIG_RESULTS, ORIG_TAGS)
    dl._SERIES.clear()  # noqa: SLF001
    dl.WINDOW, dl.WIN, dl.RULE, dl.MAX_PICKS = "custom", (start, half, end), "R1", None
    exp = dl.expiries()
    out = []
    for f in dl.FAMILIES:
        if f.idx != "N":
            continue
        results = {slot: dl.evaluate(f, slot, exp[dl.grid.INDICES[f.idx]]) for slot in dl.ALL_SLOTS}
        for kind in ("expiry", "other"):
            agg = dl.aggregate(f, results, kind, dl.ALL_SLOTS)
            allowed = dl.family_premiums(agg)[0] if f.is_premium else None
            dec = dl.decide(f, agg, kind, allowed)
            for r in dec["picks"]:
                if r.get("is_template"):
                    continue
                out.append({"family": f.name, "fam": f.fam, "index": f.idx, "kind": kind,
                            "status": dec["status"], "params": r["params"],
                            "gain_first": r["gain_first"], "gain_confirm": r["gain_test"],
                            "n_days": dec.get("n_days")})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default="12m,6m")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    only = {x for x in a.only.split(",") if x}
    res = json.loads(a.out.read_text()) if a.out.exists() else {}
    for kind in a.folds.split(","):
        for name, start, half, end, tstart, tend in ALL_FOLDS[kind]:
            if only and name not in only:
                continue
            key = f"{kind}:{name}"
            if key in res:
                continue
            sel = select(start, half, end)
            res[key] = {"fold": name, "length": kind, "tune": [str(start), str(half), str(end)],
                        "test": [str(tstart), str(tend)], "settings": sel}
            print(key, len(sel), "settings", flush=True)
            a.out.write_text(json.dumps(res, default=list, indent=1))


if __name__ == "__main__":
    main()
