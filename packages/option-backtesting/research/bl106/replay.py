"""BL-106 step 4: replay Steady (A), Calendar (B), Adaptive (C) and Baseline (REF) on the test year.

For each test day (2025-10-09 -> 2026-10-09, weekdays) every list ranks its universe on the results
before that day with the picker's own `pick.score_history` (registered weights and lookbacks) and
picks 3 core + 1 Buy at 2 lots each. Universes: the 298 (stored results), the pool (536 variants) and
the pool + the ITM amendment (556). Per-lot-day = mean of the picks' one-lot gross, as the read-out.

The pool names `N_wA1_0917` are mapped to the picker's families by patching `parts` in `variants`
and `score` (wide / dir / buy, tag = start time) for the duration of the run; the 298 names pass through.

    python research/bl106/replay.py
"""

from __future__ import annotations

import csv
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
TEST_FROM = date(2025, 10, 9)
BOOT_SEED = 20261012
FAMILY = {"w": "wide", "d": "dir", "b": "buy"}


def patch_parts() -> None:
    from option_backtesting.rotation import score, variants

    orig = variants.parts

    def parts(name: str) -> tuple[str, str, str]:
        a, b, c = name.split("_")
        if len(b) == 3 and b[0] in FAMILY and b[1] in "ABCD":
            return a, FAMILY[b[0]], c  # pool name: index, picker family, HHMM
        return orig(name)

    variants.parts = parts
    score.parts = parts


def load_pool(dirs: list[Path]) -> tuple[list[date], list[str], np.ndarray, np.ndarray]:
    cols: dict[str, dict[str, tuple[float, float]]] = {}
    for d in dirs:
        for f in sorted(d.glob("*.npz")):
            z = np.load(f)
            for j, n in enumerate(z["names"]):
                cols[str(n)] = {
                    str(day): (float(z["gross"][i, j]), float(z["net"][i, j]))
                    for i, day in enumerate(z["days"])
                }
    names = sorted(cols)
    common = sorted(set.intersection(*(set(c) for c in cols.values())))
    days = [date.fromisoformat(d) for d in common if date.fromisoformat(d).weekday() < 5]
    keep = [d.isoformat() for d in days]
    gross = np.array([[cols[n][d][0] for n in names] for d in keep])
    net = np.array([[cols[n][d][1] for n in names] for d in keep])
    return days, names, gross, net


def replay(days, names, values, attrs, pnl_gross, pnl_net, test_days):
    from option_backtesting.rotation import pick
    from option_backtesting.rotation.lists import LISTS

    out = {k: {"day": [], "gross": [], "net": [], "picks": []} for k in LISTS}
    index = {d: i for i, d in enumerate(days)}
    for d in test_days:
        i = index[d]
        a = attrs[d]
        hist = pick.History(
            days[:i],
            list(names),
            values[:i],
            [attrs[x]["weekday"] for x in days[:i]],
            [attrs[x]["vix_band"] for x in days[:i]],
            [attrs[x]["dte_n"] for x in days[:i]],
            [attrs[x]["dte_s"] for x in days[:i]],
            "",
        )
        vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "", "None") else None
        res = pick.score_history(hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]})
        col = {n: j for j, n in enumerate(names)}
        for key, r in res.items():
            picks = r["core"] + r["buy"]
            out[key]["day"].append(d)
            out[key]["gross"].append(float(np.mean([pnl_gross[i, col[p]] for p in picks])))
            out[key]["net"].append(float(np.mean([pnl_net[i, col[p]] for p in picks])))
            out[key]["picks"].append(picks)
    return out


def main() -> None:
    patch_parts()
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.rotation import base, store
    from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
    from option_backtesting.rotation.variants import variant_names

    root = data_dir()
    attrs = store.read_days(root)
    results: dict[str, dict] = {}

    # the 298 (stored, before charges: the stored net column equals gross)
    m = store.load_matrix(variant_names(), root)
    d298 = [d for d in m.days if d in attrs]
    v298 = m.values[[i for i, d in enumerate(m.days) if d in attrs]]
    test = [d for d in d298 if d >= TEST_FROM]
    results["298"] = replay(d298, m.names, v298, attrs, v298, v298, test)

    # the pool, with and without the ITM amendment
    for label, dirs in (("pool536", [RES / "sim"]), ("pool556", [RES / "sim", RES / "sim_ext"])):
        days, names, gross, net = load_pool(dirs)
        days_ok = [d for d in days if d in attrs]
        sel = [i for i, d in enumerate(days) if d in attrs]
        t = [d for d in days_ok if d >= TEST_FROM and d in set(test)]
        results[label] = replay(days_ok, names, gross[sel], attrs, gross[sel], net[sel], t)

    common = sorted(
        set(results["298"]["A"]["day"])
        & set(results["pool536"]["A"]["day"])
        & set(results["pool556"]["A"]["day"])
    )
    bp = base.base_per_lot(root, "gross")
    rows = []
    series_out = []
    names = {"A": "Steady", "B": "Calendar", "C": "Adaptive", "REF": "Baseline"}

    def pick(label, key, field):
        r = results[label][key]
        idx = {d: i for i, d in enumerate(r["day"])}
        return np.array([r[field][idx[d]] for d in common])

    for key in ("A", "B", "C", "REF"):
        base298 = pick("298", key, "gross")
        for label in ("298", "pool536", "pool556"):
            g, n = pick(label, key, "gross"), pick(label, key, "net")
            diff = g - base298
            mean, lo, hi = block_bootstrap_mean(diff) if label != "298" else (0.0, 0.0, 0.0)
            rows.append(
                {
                    "list": names[key],
                    "universe": label,
                    "days": len(common),
                    "gross_per_lot_day": g.mean(),
                    "gross_total_per_lot": g.sum(),
                    "max_drawdown_per_lot": max_drawdown(g),
                    "win_rate": float((g > 0).mean()),
                    "net_per_lot_day": n.mean() if label != "298" else float("nan"),
                    "net_max_drawdown": max_drawdown(n) if label != "298" else float("nan"),
                    "diff_vs_298_mean": mean,
                    "diff_lo90": lo,
                    "diff_hi90": hi,
                    "winner": bool(
                        label != "298" and lo > 0 and max_drawdown(g) >= max_drawdown(base298)
                    ),
                }
            )
        for label in ("298", "pool536", "pool556"):
            r = results[label][key]
            for d, g, n, p in zip(r["day"], r["gross"], r["net"], r["picks"], strict=True):
                series_out.append(
                    {
                        "list": names[key],
                        "universe": label,
                        "day": d.isoformat(),
                        "gross_per_lot": g,
                        "net_per_lot": n,
                        "picks": "|".join(p),
                    }
                )
    base_series = np.array([bp[d] for d in common if d in bp])
    rows.append(
        {
            "list": "Fixed base",
            "universe": "stored",
            "days": len(base_series),
            "gross_per_lot_day": base_series.mean(),
            "gross_total_per_lot": base_series.sum(),
            "max_drawdown_per_lot": max_drawdown(base_series),
            "win_rate": float((base_series > 0).mean()),
        }
    )
    RES.mkdir(exist_ok=True)
    with (RES / "replay_summary.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(dict.fromkeys(k for r in rows for k in r)))
        w.writeheader()
        w.writerows(rows)
    with (RES / "replay_daily.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(series_out[0]))
        w.writeheader()
        w.writerows(series_out)
    print(f"{len(common)} common test days, {common[0]} -> {common[-1]}")
    for r in rows:
        print(
            f"{r['list']:10s} {r['universe']:8s} gross/lot-day {r['gross_per_lot_day']:7.1f}  total {r['gross_total_per_lot']:9.0f}  "
            f"maxDD {r['max_drawdown_per_lot']:8.0f}  win {r['win_rate']:.0%}"
            + (
                f"  diff {r['diff_vs_298_mean']:6.1f} [{r['diff_lo90']:6.1f},{r['diff_hi90']:6.1f}]  winner={r['winner']}  net/lot-day {r['net_per_lot_day']:6.1f}"
                if r.get("diff_lo90") is not None and r["universe"] not in ("298", "stored")
                else ""
            )
        )


if __name__ == "__main__":
    sys.exit(main())
