"""BL-133: a fourth lot on non-expiry days, placed on a Widesl (T1) or the Dir (Core).

As registered in backlog/BL-133 (descriptive, in-sample). Reads the live store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl133/fourth_lot.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, pick, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import runners_up
from option_backtesting.rotation.variants import is_dir, is_wide, track_names, variant_names

HERE = Path(__file__).parent
WINDOWS = {
    "two_years": (date(2025, 1, 10), date(2026, 10, 16)),
    "last_year": (date(2025, 10, 9), date(2026, 10, 16)),
}
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261025, 0.90
BROKERAGE = 20.0 * 1.18  # per order, with GST
PLACEMENTS = {"core_298": ("C-D2", "C-D+"), "t1": ("T-W1", "T-W2", "T-W+")}


def read(name: str, root: Path) -> dict[date, tuple[float, int]]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                n = int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else 0
                out[date.fromisoformat(r["day"])] = (float(r["gross"]), n)
            except (KeyError, ValueError):
                continue
    return out


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def run(root: Path, names: list[str], book: str) -> dict:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def val(n, d):
        if n not in cache:
            cache[n] = read(n, root)
        return cache[n].get(d)

    rows = []
    lo0, hi0 = WINDOWS["two_years"]
    for d in rec.days_available():
        if not lo0 <= d <= hi0:
            continue
        a = rec.attrs[d]
        expiry = "0" in (a["dte_n"], a["dte_s"])
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, daylog._number(a.get("vix_open")), dte):
            if key != "C":
                continue
            score = {n: float(comp[j]) for j, n in enumerate(cols)}
            core = picks.core
            ru = runners_up(comp, cols, picks)
            got = {n: val(n, d) for n in [*core, *(v for v in ru.values() if v)]}
            if any(got[n] is None for n in core):
                continue
            b3 = sum(got[n][0] for n in core)
            row = {
                "day": d.isoformat(),
                "expiry": expiry,
                "B3": b3,
                "B4": b3 if expiry else b3 * 4 / 3,
            }
            wide = sorted((n for n in core if is_wide(n)), key=lambda n: (-score[n], n))
            dirs = [n for n in core if is_dir(n)]

            def add(
                name: str | None, new_strategy: bool, expiry=expiry, b3=b3, got=got
            ) -> tuple[float, float] | None:
                if expiry:
                    return b3, 0.0
                if name is None or got.get(name) is None:
                    return None
                g, n = got[name]
                return b3 + g, (2 * n * BROKERAGE if new_strategy else 0.0)

            if book == "t1":
                arms = {
                    "T-W1": add(wide[0], False),
                    "T-W2": add(wide[-1], False),
                    "T-W+": add(ru.get("wide"), True),
                }
            else:
                d2 = add(dirs[0], False) if dirs else add(ru.get("dir"), True)
                arms = {"C-D2": d2, "C-D+": add(ru.get("dir"), True)}
            if any(v is None for v in arms.values()):
                continue
            for k, (g, brk) in arms.items():
                row[k] = g
                row[f"{k}_brokerage"] = brk
            rows.append(row)

    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for r in rows if lo.isoformat() <= r["day"] <= hi.isoformat()]
        b3 = np.array([r["B3"] for r in sub])
        b4 = np.array([r["B4"] for r in sub])
        w = {
            "days": len(sub),
            "expiry_days": int(sum(r["expiry"] for r in sub)),
            "B3": {
                "per_day": float(b3.mean()),
                "max_drawdown": max_drawdown(b3),
                "worst_day": float(b3.min()),
            },
            "B4": {
                "per_day": float(b4.mean()),
                "max_drawdown": max_drawdown(b4),
                "worst_day": float(b4.min()),
            },
        }
        for k in PLACEMENTS[book]:
            g = np.array([r[k] for r in sub])
            brk = np.array([r[f"{k}_brokerage"] for r in sub])
            w[k] = {
                "per_day": float(g.mean()),
                "max_drawdown": max_drawdown(g),
                "worst_day": float(g.min()),
                "extra_vs_B3": interval(g - b3),
                "vs_B4": interval(g - b4),
                "vs_B4_after_added_brokerage": interval(g - brk - b4),
                "added_brokerage_per_day": float(brk.mean()),
            }
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    report = {
        "core_298": run(root, variant_names(), "core_298"),
        "t1": run(root, [*variant_names(), *track_names("t1")], "t1"),
        "note": "gross per one-lot results x lots; 3 lots on expiry days in every arm",
    }
    (HERE / "fourth_lot_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for book in ("core_298", "t1"):
        for wname, w in report[book].items():
            print(f"== {book} {wname} {w['days']}d ({w['expiry_days']} expiry)")
            for k in ("B3", "B4"):
                print(
                    f"   {k}: {w[k]['per_day']:+.0f}/day DD {w[k]['max_drawdown']:,.0f} worst {w[k]['worst_day']:,.0f}"
                )
            for k in PLACEMENTS[book]:
                x = w[k]
                e, v, vn = x["extra_vs_B3"], x["vs_B4"], x["vs_B4_after_added_brokerage"]
                print(
                    f"   {k}: {x['per_day']:+.0f}/day DD {x['max_drawdown']:,.0f} worst {x['worst_day']:,.0f} | extra lot {e['mean']:+.0f} "
                    f"[{e['ci90'][0]:+.0f},{e['ci90'][1]:+.0f}] | vs B4 {v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}] {v['reading']} "
                    f"| after brokerage {vn['mean']:+.0f} [{vn['ci90'][0]:+.0f},{vn['ci90'][1]:+.0f}]"
                )


if __name__ == "__main__":
    main()
