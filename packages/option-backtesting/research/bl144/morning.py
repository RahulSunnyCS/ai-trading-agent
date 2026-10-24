"""BL-144 addendum: on quiet weeks, does T1 start its wide-stop picks from the morning?
Descriptive; reads research/bl144/out/daily.csv written by run.py. See the item's Log."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation.variants import strategy_path

OUT = Path(__file__).resolve().parent / "out"
MORNING = 9 * 60 + 47


def start_min(name: str) -> int:
    tag = name.split("_")[-1]
    return int(tag[:2]) * 60 + int(tag[2:])


def wide(name: str, cache: dict) -> bool:
    if name not in cache:
        sl = [x.stop_loss.percent for x in load_legwise(strategy_path(name)).legs if x.stop_loss]
        cache[name] = bool(sl) and min(sl) >= 100
    return cache[name]


def num(r: dict, k: str) -> float:
    return float(r[k]) if r.get(k) not in (None, "") else float("nan")


def main() -> None:
    rows = list(csv.DictReader((OUT / "daily.csv").open()))
    study = json.loads((OUT / "study.json").read_text())
    c1, c2 = study["r7_cuts"]
    d1, d2 = study["d_cuts"]
    cache: dict = {}
    res: dict = {}
    for key in ("T1", "CORE"):
        res[key] = {}
        for g in ("low", "mid", "high"):
            days = [
                r
                for r in rows
                if r["r7_pct"]
                and r[f"{key}_picks"]
                and (
                    g == "low"
                    and num(r, "r7_pct") <= c1
                    or g == "high"
                    and num(r, "r7_pct") >= c2
                    or g == "mid"
                    and c1 < num(r, "r7_pct") < c2
                )
            ]
            starts, wstarts, all_wide, morn_wide_day, n_picks, n_morn, n_w, n_wm = (
                [],
                [],
                0,
                0,
                0,
                0,
                0,
                0,
            )
            for r in days:
                names = r[f"{key}_picks"].split()
                flags = [wide(n, cache) for n in names]
                st = [start_min(n) for n in names]
                starts += st
                n_picks += len(names)
                n_morn += sum(1 for s in st if s <= MORNING)
                for f, s in zip(flags, st, strict=True):
                    if f:
                        n_w += 1
                        wstarts.append(s)
                        n_wm += s <= MORNING
                all_wide += all(flags)
                morn_wide_day += any(f and s <= MORNING for f, s in zip(flags, st, strict=True))
            res[key][g] = {
                "days": len(days),
                "mean_start": f"{int(np.mean(starts)) // 60:02d}:{int(np.mean(starts)) % 60:02d}",
                "morning_share": round(100 * n_morn / n_picks, 1),
                "wide_picks_mean_start": f"{int(np.mean(wstarts)) // 60:02d}:{int(np.mean(wstarts)) % 60:02d}",
                "wide_picks_morning_share": round(100 * n_wm / max(n_w, 1), 1),
                "days_all_wide_pct": round(100 * all_wide / len(days), 1),
                "days_with_morning_wide_pct": round(100 * morn_wide_day / len(days), 1),
            }
    # counterfactual: T1 vs the fixed all-wide-from-the-open 3 x Widesl, per lot-day
    t1 = np.array([num(r, "T1_gross") / num(r, "T1_lots") for r in rows])
    w3 = np.array([num(r, "W3_gross") / num(r, "W3_lots") for r in rows])
    base = np.array([num(r, "BASE_gross") / num(r, "BASE_lots") for r in rows])
    r7 = np.array([num(r, "r7_pct") for r in rows])
    d = np.array([num(r, "d_pct") for r in rows])
    masks = {
        "R7 low (quiet week)": r7 <= c1,
        "R7 low and day quiet": (r7 <= c1) & (d <= d1),
        "R7 low and day wide": (r7 <= c1) & (d >= d2),
        "day quiet (any week)": d <= d1,
    }
    res["counterfactual"] = {
        k: {
            "days": int(m.sum()),
            "T1": round(float(np.nanmean(t1[m]))),
            "3xWidesl_0917": round(float(np.nanmean(w3[m]))),
            "BASE": round(float(np.nanmean(base[m]))),
            "T1_beats_W3_days_pct": round(100 * float(np.mean(t1[m] > w3[m])), 1),
        }
        for k, m in masks.items()
    }
    (OUT / "morning.json").write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
