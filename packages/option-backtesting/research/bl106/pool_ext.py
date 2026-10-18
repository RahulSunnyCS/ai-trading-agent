"""BL-106 amendment (owner, 2026-10-15): at least one ITM set in each NIFTY Directional band.

NIFTY Dir bands whose four first-year-selected sets hold no ITM1 / ITM2 get one more: the strongest
ITM1 / ITM2 band candidate by first-year robust score that passes the same gates, has a day MTM stop
and no unverified re-entry. Writes `pool_cells_ext_<date>.json` / `pool_sets_ext_<date>.json`
(set number 5, names `N_d<band>5_<slot>`), simulated by `pool_run.py --ext`.
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
DATE = "2026-10-15"


def verified(r: dict) -> bool:
    return not (r["p_reentry"] and ('"asap"' in r["p_reentry"] or '"cost", 2' in r["p_reentry"]))


def main() -> None:
    sets = json.loads((HERE / f"pool_sets_{DATE}.json").read_text())
    with (Y1 / "D_band_winners_tail.csv").open(newline="") as h:
        rows = list(csv.DictReader(h))
    cells, new_sets = [], []
    for band in "ABCD":
        have = [s for s in sets if s["family"] == "D" and s["index"] == "N" and s["band"] == band]
        if any(s["params"]["strike"] in ("ITM1", "ITM2") for s in have):
            print(f"band {band}: already has an ITM set")
            continue
        g = [
            r
            for r in rows
            if r["index"] == "N"
            and r["band"] == band
            and r["band_candidate"] == "True"
            and r["is_template"] != "True"
            and r["p_strike"].strip('"') in ("ITM1", "ITM2")
            and r["p_mtm"]
            and verified(r)
        ]
        if not g:
            print(f"band {band}: no ITM candidate")
            continue
        pick = max(g, key=lambda r: float(r["band_robust"]))
        params = grid.params_from_row("D", pick)
        new_sets.append(
            {
                "family": "D",
                "index": "N",
                "band": band,
                "k": 5,
                "params": params,
                "y1_avg_day_inr": float(pick["mean_avg_day_inr"]),
                "robust": float(pick["band_robust"]),
            }
        )
        for p in sorted(grid.ROTATION.glob("N_dir_*.yaml")):
            slot = f"{p.stem[-4:-2]}:{p.stem[-2:]}"
            if grid.band(slot) == band:
                cells.append(
                    {
                        "family": "D",
                        "index": "N",
                        "slot": slot,
                        "params": params,
                        "name": f"N_d{band}5_{slot.replace(':', '')}",
                    }
                )
        print(
            f"band {band}: add {params['strike']} SL {params['sl']} trail {params['trail']} "
            f"MTM {params['mtm']} RE {params['reentry']}; robust {float(pick['band_robust']):.1f}, "
            f"{float(pick['mean_avg_day_inr']):.0f}/day first year"
        )
    (HERE / f"pool_cells_ext_{DATE}.json").write_text(json.dumps(cells, indent=1, default=list))
    (HERE / f"pool_sets_ext_{DATE}.json").write_text(json.dumps(new_sets, indent=1, default=list))
    print(f"{len(new_sets)} sets, {len(cells)} variants")


if __name__ == "__main__":
    main()
