"""BL-107: first-year profile (2024-10-09 -> 2025-10-08 only; the test year is not read) of every T1
setting and every Core-298 template: expiry / non-expiry results and daily correlations, from the
BL-104 stored series at the 12 sampled slots (net of charges, slot-mean per day).

    uv run python research/bl107/first_year_profile.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import daytype_lists as dl  # noqa: E402

CUT = date(2025, 10, 9)
RES = HERE / "results"


def series_for(f: dl.Family, params: dict | None, stored: bool = False) -> tuple[list[date], np.ndarray]:
    """Slot-mean daily series over the 12 sampled slots, first year only."""
    cols, days = [], None
    for slot in dl.ALL_SLOTS:
        if stored:
            p = params
        else:
            match = [s for d_, _, s in dl.candidates(f, slot) if dl.key(d_) == dl.key(params)]
            p = match[0]
        dd, v = dl.column(None, f, slot, p)
        keep = [i for i, x in enumerate(dd) if x < CUT]
        dd = [dd[i] for i in keep]
        v = v[keep]
        if days is None:
            days = dd
        else:
            pos = {x: i for i, x in enumerate(dd)}
            v = np.array([v[pos[x]] for x in days])
        cols.append(v)
    return days, np.mean(cols, axis=0)


def main() -> None:
    fams = {f.name: f for f in dl.FAMILIES}
    sets = json.loads((RES / "sets.json").read_text())
    exp = dl.expiries()
    out: dict[str, dict] = {}
    for s in sets:
        if s["universe"] != "T1":
            continue
        f = fams[s["family"]]
        params = {k: tuple(v) if isinstance(v, list) else v for k, v in s["params"].items()}
        days, v = series_for(f, params)
        out[f"T1#{s['set']} {s['family']} {s['kind']}"] = {"days": days, "v": v, "idx": f.idx, "params": s["params"]}
    for f in dl.FAMILIES:
        for name, _, tparams in f.templates:
            days, v = series_for(f, tparams, stored=True)
            out[f"Core {name}"] = {"days": days, "v": v, "idx": f.idx, "params": tparams}
    base_days = next(iter(out.values()))["days"]
    for k, r in out.items():
        assert r["days"] == base_days, k
    underlying = {"N": "NIFTY", "S": "SENSEX"}
    print(f"first year {base_days[0]} -> {base_days[-1]}, {len(base_days)} days, 12 slots, net per lot-day (slot mean)\n")
    print(f"{'strategy':48s}{'exp days':>9s}{'exp avg':>9s}{'exp lose%':>10s}{'non avg':>9s}{'non lose%':>10s}{'all avg':>9s}")
    rows = {}
    for k, r in out.items():
        e = np.array([d in exp[underlying[r["idx"]]] for d in base_days])
        v = r["v"]
        rows[k] = (v[e].mean(), v[~e].mean())
        print(f"{k:48s}{e.sum():9d}{v[e].mean():9.0f}{np.mean(v[e] < 0):10.0%}{v[~e].mean():9.0f}{np.mean(v[~e] < 0):10.0%}{v.mean():9.0f}")
    names = list(out)
    M = np.corrcoef(np.array([out[k]["v"] for k in names]))
    print("\nhighest correlations of each T1 setting (first year, daily):")
    for i, k in enumerate(names):
        if not k.startswith("T1"):
            continue
        order = [j for j in np.argsort(-M[i]) if j != i][:3]
        print(f"  {k:46s} " + ", ".join(f"{names[j]} {M[i, j]:.2f}" for j in order))
    np.save(RES / "first_year_corr.npy", M)
    (RES / "first_year_corr_names.json").write_text(json.dumps(names))
    (RES / "first_year_profile.json").write_text(json.dumps({k: {"exp_avg": v[0], "non_avg": v[1]} for k, v in rows.items()}))


if __name__ == "__main__":
    main()
