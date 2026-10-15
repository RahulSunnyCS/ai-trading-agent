"""BL-107 step 4: replay Steady (A), Calendar (B), Adaptive (C) and Baseline (REF) on the test year over
Core-298 / Core-144 and over T1 / T2 (Core plus the first-year day-type winners), with the day-type
weight on Adaptive only.

Each test day every list ranks its universe on the results before that day with the picker's own
composite (registered weights and lookbacks) and picks 3 core + 1 Buy at 2 lots each; per-lot-day is
the mean of the picks' one-lot gross, as the read-out and BL-106. The day-type weight multiplies the
Adaptive composite by (1 + w) for a variant tagged expiry on its index's weekly expiry day, or tagged
non-expiry on any other day (composites are percentile-rank sums, never negative: +w x |score|).

    uv run python research/bl107/replay.py            # w = 10% (registered) and 0% (ablation)
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
HIST_FROM = date(2025, 4, 1)
TEST_FROM = date(2025, 10, 9)
WEIGHT = 0.10
FAMILY = {"w": "wide", "d": "dir", "b": "buy"}
SAMPLED12 = {"0917", "0932", "0947", "1017", "1047", "1132", "1217", "1302", "1317", "1347", "1402", "1432"}


def patch_parts() -> None:
    from option_backtesting.rotation import score, variants

    orig = variants.parts

    def parts(name: str) -> tuple[str, str, str]:
        a, b, c = name.split("_")
        if len(b) >= 3 and b[0] in FAMILY and b[1] in "EO" and b[2:].isdigit():
            return a, FAMILY[b[0]], c
        return orig(name)

    variants.parts = parts
    score.parts = parts


def expiry_days() -> dict[str, set[date]]:
    path = HERE.parents[1] / "src" / "option_backtesting" / "data" / "reference" / "expiries_observed.csv"
    out: dict[str, set[date]] = {"N": set(), "S": set()}
    with path.open(newline="") as h:
        for r in csv.DictReader(h):
            k = {"NIFTY": "N", "SENSEX": "S"}.get(r["underlying"])
            if k:
                out[k].add(date.fromisoformat(r["expiry"]))
    return out


def load_new() -> tuple[list[date], dict[str, dict[str, tuple[float, float]]]]:
    cols: dict[str, dict[str, tuple[float, float]]] = {}
    for f in sorted((RES / "sim").glob("*.npz")):
        z = np.load(f)
        for j, n in enumerate(z["names"]):
            cols[str(n)] = {
                str(day): (float(z["gross"][i, j]), float(z["net"][i, j])) for i, day in enumerate(z["days"])
            }
    return cols


def replay(days, names, gross, net, attrs, test_days, boost, tags, expiry):
    """tags[j]: 'E' / 'O' for added variants, '' for Core; expiry: {'N': set, 'S': set}."""
    from option_backtesting.rotation import pick, score
    from option_backtesting.rotation.lists import LISTS

    index_letter = np.array([n.split("_")[0] for n in names])
    is_new = np.array([t != "" for t in tags])
    tag_arr = np.array(tags)
    dte_cols = None
    out = {k: {"day": [], "gross": [], "net": [], "picks": [], "new": [], "match": []} for k in LISTS}
    idx = {d: i for i, d in enumerate(days)}
    col = {n: j for j, n in enumerate(names)}
    for d in test_days:
        i = idx[d]
        a = attrs[d]
        hist = pick.History(
            days[:i], list(names), gross[:i],
            [attrs[x]["weekday"] for x in days[:i]], [attrs[x]["vix_band"] for x in days[:i]],
            [attrs[x]["dte_n"] for x in days[:i]], [attrs[x]["dte_s"] for x in days[:i]], "",
        )
        vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "", "None") else None
        weekday = np.array([*hist.weekday, d.strftime("%a")])
        band = np.array([*hist.band, score.vix_band(vix)])
        dn = np.array([*hist.dte_n, a["dte_n"]])
        ds = np.array([*hist.dte_s, a["dte_s"]])
        Pv = np.vstack([hist.values, np.zeros((1, len(names)))])
        dmat = score.dte_matrix(dn, ds, list(names))
        fam = score.family_index(list(names))
        is_exp = np.array([d in expiry[x] for x in index_letter])
        match = is_new & (((tag_arr == "E") & is_exp) | ((tag_arr == "O") & ~is_exp))
        _ = dte_cols
        for key, lst in LISTS.items():
            comp = score.composite(Pv, weekday, band, dmat, list(names), lst, fam)
            if key == "C" and boost:
                comp = comp + boost * np.abs(comp) * match
            picks = score.select(comp, list(names))
            chosen = picks.core + picks.buy
            out[key]["day"].append(d)
            out[key]["gross"].append(float(np.mean([gross[i, col[p]] for p in chosen])))
            out[key]["net"].append(float(np.mean([net[i, col[p]] for p in chosen])))
            out[key]["picks"].append(chosen)
            out[key]["new"].append(float(np.mean([is_new[col[p]] for p in chosen])))
            out[key]["match"].append(float(np.mean([match[col[p]] for p in chosen])))
    return out


def main() -> None:
    patch_parts()
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.rotation import base, store
    from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
    from option_backtesting.rotation.variants import variant_names

    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    new = load_new()
    cells = {c["name"]: c for c in json.loads((RES / "cells.json").read_text())}
    expiry = expiry_days()
    common = sorted(
        set(d for d in m.days if d in attrs and d >= HIST_FROM)
        & set.intersection(*(set(date.fromisoformat(x) for x in c) for c in new.values()))
    ) if new else sorted(d for d in m.days if d in attrs and d >= HIST_FROM)
    common = [d for d in common if d.weekday() < 5]
    mi = {d: i for i, d in enumerate(m.days)}
    core_g = np.array([[m.values[mi[d], j] for j in range(len(m.names))] for d in common])
    test = [d for d in common if d >= TEST_FROM]
    print(f"{len(common)} history+test days, {len(test)} test days {test[0]} -> {test[-1]}; "
          f"{len(m.names)} core, {len(new)} added variants", flush=True)

    def tag_of(n: str) -> str:
        return n.split("_")[0], n.split("_")[2]

    def build(label: str, uni: str | None, only12: bool):
        core = [n for n in m.names if (not only12 or n.split("_")[2] in SAMPLED12)]
        add = [n for n in sorted(new) if uni and cells[n]["universe"] == uni
               and (not only12 or n.split("_")[2] in SAMPLED12)]
        names = core + add
        cj = {n: j for j, n in enumerate(m.names)}
        gross = np.zeros((len(common), len(names)))
        net = np.zeros_like(gross)
        for j, n in enumerate(names):
            if n in cj:
                gross[:, j] = core_g[:, cj[n]]
                net[:, j] = core_g[:, cj[n]]  # stored results are uncharged
            else:
                gross[:, j] = [new[n][d.isoformat()][0] for d in common]
                net[:, j] = [new[n][d.isoformat()][1] for d in common]
        tags = ["" if n in cj else ("E" if n.split("_")[1][1] == "E" else "O") for n in names]
        return names, gross, net, tags

    results: dict[str, dict] = {}
    for label, uni, only12, boosts in (
        ("Core-298", None, False, (0.0,)),
        ("T1-25", "T1", False, (WEIGHT, 0.0)),
        ("T2-25", "T2", False, (WEIGHT, 0.0)),
    ):
        names, gross, net, tags = build(label, uni, only12)
        for b in boosts:
            tag = label if b == 0.0 and uni is None else f"{label} w={int(b * 100)}%"
            if uni and b == 0.0:
                tag = f"{label} w=0%"
            results[tag] = replay(common, names, gross, net, attrs, test, b, tags, expiry)
            results[tag]["n_variants"] = len(names)
            print(f"  {tag}: {len(names)} variants replayed", flush=True)

    names_l = {"A": "Steady", "B": "Calendar", "C": "Adaptive", "REF": "Baseline"}
    rows = []
    for label, r in results.items():
        ref_label = "Core-144" if label.endswith("-12") or label.startswith("Core-144") else "Core-298"
        for key in ("C", "A", "B", "REF"):
            g = np.array(r[key]["gross"])
            n = np.array(r[key]["net"])
            bg = np.array(results[ref_label][key]["gross"])
            diff = g - bg
            mean, lo, hi = block_bootstrap_mean(diff) if label != ref_label else (0.0, 0.0, 0.0)
            rows.append({
                "universe": label, "list": names_l[key], "variants": r["n_variants"], "days": len(g),
                "gross_per_lot_day": g.mean(), "gross_total": g.sum(), "max_drawdown": max_drawdown(g),
                "win_rate": float((g > 0).mean()), "worst_day": g.min(),
                "net_per_lot_day_mixed": n.mean(), "share_new_picks": float(np.mean(r[key]["new"])),
                "share_matching_day_type": float(np.mean(r[key]["match"])),
                "diff_vs_base": mean, "lo90": lo, "hi90": hi, "base": ref_label,
                "winner": bool(label != ref_label and key == "C" and lo > 0 and max_drawdown(g) >= max_drawdown(bg)),
            })
    base_series = base.base_per_lot(root, "gross")
    RES.mkdir(exist_ok=True)
    with (RES / "replay_summary.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    with (RES / "replay_daily.csv").open("w", newline="") as h:
        w = csv.writer(h)
        w.writerow(["universe", "list", "day", "gross_per_lot", "net_per_lot", "new_share", "picks"])
        for label, r in results.items():
            for key in ("C", "A", "B", "REF"):
                for d, g, nn, ns, p in zip(r[key]["day"], r[key]["gross"], r[key]["net"], r[key]["new"], r[key]["picks"], strict=True):
                    w.writerow([label, names_l[key], d.isoformat(), round(g, 2), round(nn, 2), round(ns, 2), "|".join(p)])
    print(f"\nAdaptive, {len(test)} test days {test[0]} -> {test[-1]} (gross per lot-day)\n")
    print(f"{'universe':16s}{'variants':>9s}{'gross/day':>10s}{'total':>9s}{'maxDD':>9s}{'win':>6s}{'worst':>8s}"
          f"{'diff':>8s}{'90% interval':>17s}{'new picks':>10s}{'day-type':>9s}  verdict")
    for r in rows:
        if r["list"] != "Adaptive":
            continue
        base_row = r["universe"] in ("Core-298", "Core-144")
        print(f"{r['universe']:16s}{r['variants']:9d}{r['gross_per_lot_day']:10.1f}{r['gross_total']:9.0f}"
              f"{r['max_drawdown']:9.0f}{r['win_rate']:6.0%}{r['worst_day']:8.0f}"
              + ("      — (base)" if base_row else f"{r['diff_vs_base']:+8.1f}  [{r['lo90']:+6.1f},{r['hi90']:+6.1f}]")
              + f"{r['share_new_picks']:10.0%}{r['share_matching_day_type']:9.0%}  "
              + ("" if base_row else ("WIN" if r["winner"] else "no win")))
    bs = np.array([base_series[d] for d in test if d in base_series])
    print(f"\nfixed base (stored): {bs.mean():.1f} gross per lot-day over {len(bs)} days")
    print("\nother lists, same universes:")
    for r in rows:
        if r["list"] != "Adaptive":
            print(f"  {r['universe']:16s}{r['list']:9s} gross/day {r['gross_per_lot_day']:7.1f}  maxDD {r['max_drawdown']:8.0f}"
                  + ("" if r["universe"] in ("Core-298", "Core-144") else f"  diff {r['diff_vs_base']:+6.1f} [{r['lo90']:+6.1f},{r['hi90']:+6.1f}]"))


if __name__ == "__main__":
    sys.exit(main())
