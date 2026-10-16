"""BL-107 Experiment 2: the first-year rules R1 (day-type exclusion) and R2 (R1 + Core duplicates out)
replayed on the test year over T1 (Adaptive, no weight). Registered in the item before this ran.

    uv run python research/bl107/rules_check.py
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import replay as rp  # noqa: E402

rp.patch_parts()
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import pick, score, store  # noqa: E402
from option_backtesting.rotation.lists import LISTS  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402

DUPLICATES = {"N_wide", "N_ditm1"}  # R2: Core families a better first-year T1 setting duplicates


def main() -> None:
    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    new = rp.load_new()
    cells = {c["name"]: c for c in json.loads((rp.RES / "cells.json").read_text())}
    profile = json.loads((rp.RES / "first_year_profile.json").read_text())
    exp = rp.expiry_days()
    common = sorted(set(d for d in m.days if d in attrs and d >= rp.HIST_FROM)
                    & set.intersection(*(set(date.fromisoformat(x) for x in c) for c in new.values())))
    common = [d for d in common if d.weekday() < 5]
    test = [d for d in common if d >= rp.TEST_FROM]
    mi = {d: i for i, d in enumerate(m.days)}
    core = list(m.names)
    t1 = [n for n in sorted(new) if cells[n]["universe"] == "T1"]
    names = core + t1
    G = np.hstack([np.array([[m.values[mi[d], j] for j in range(len(core))] for d in common]),
                   np.array([[new[n][d.isoformat()][0] for n in t1] for d in common])])

    def profile_key(n: str) -> str:
        if n in cells:
            return next(k for k in profile if k.startswith(f"T1#{cells[n]['set']} "))
        idx, fam, _ = n.split("_")
        return f"Core {idx}_{fam}"

    keys = [profile_key(n) for n in names]
    exp_bad = np.array([profile[k]["exp_avg"] < 0 for k in keys])
    non_bad = np.array([profile[k]["non_avg"] < 0 for k in keys])
    dup = np.array([n not in cells and "_".join(n.split("_")[:2]) in DUPLICATES for n in names])
    idx_letter = np.array([n.split("_")[0] for n in names])
    print("R1 excludes on non-expiry days:", sorted({k for k, b in zip(keys, non_bad, strict=True) if b}))
    print("R1 excludes on expiry days:", sorted({k for k, b in zip(keys, exp_bad, strict=True) if b}))
    print("R2 also removes:", sorted({k for k, b in zip(keys, dup, strict=True) if b}), "\n")
    col = {n: j for j, n in enumerate(names)}
    out = {"core": [], "t1": [], "r1": [], "r2": []}
    for d in test:
        i = common.index(d)
        a = attrs[d]
        is_exp = np.array([d in exp[x] for x in idx_letter])
        r1 = ~((is_exp & exp_bad) | (~is_exp & non_bad))
        masks = {"core": np.array([n not in cells for n in names]), "t1": np.ones(len(names), bool), "r1": r1, "r2": r1 & ~dup}
        for label, mask in masks.items():
            sel = np.where(mask)[0]
            nm = [names[j] for j in sel]
            P = G[:i, sel]
            hist = pick.History(common[:i], nm, P, [attrs[x]["weekday"] for x in common[:i]],
                                [attrs[x]["vix_band"] for x in common[:i]], [attrs[x]["dte_n"] for x in common[:i]],
                                [attrs[x]["dte_s"] for x in common[:i]], "")
            vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "", "None") else None
            comp = score.composite(np.vstack([P, np.zeros((1, len(nm)))]), np.array([*hist.weekday, d.strftime("%a")]),
                                   np.array([*hist.band, score.vix_band(vix)]),
                                   score.dte_matrix(np.array([*hist.dte_n, a["dte_n"]]), np.array([*hist.dte_s, a["dte_s"]]), nm),
                                   nm, LISTS["C"], score.family_index(nm))
            s = score.select(comp, nm)
            out[label].append(float(np.mean([G[i, col[p]] for p in s.core + s.buy])))
    rng = np.random.default_rng(20261012)
    print(f"Adaptive, {len(test)} test days {test[0]} -> {test[-1]}, gross per lot-day\n")
    t = np.array(out["t1"])
    for label, text in (("core", "Core-298"), ("t1", "T1 (no rule)"), ("r1", "T1 + R1 (day-type exclusion)"), ("r2", "T1 + R2 (R1 + duplicates out)")):
        g = np.array(out[label])
        line = f"{text:32s}{g.mean():7.1f}  total {g.sum():9,.0f}  maxDD {max_drawdown(g):8,.0f}  win {np.mean(g > 0):.0%}"
        if label in ("r1", "r2"):
            mean, lo, hi = block_bootstrap_mean(g - t)
            # 95 % interval from the same bootstrap draws (5-day blocks)
            n = len(g)
            diffs = g - t
            idx = np.arange(n)
            boots = []
            for _ in range(2000):
                starts = rng.integers(0, n, size=int(np.ceil(n / 5)))
                b = np.concatenate([(idx[s0:s0 + 5] if s0 + 5 <= n else np.concatenate([idx[s0:], idx[: s0 + 5 - n]])) for s0 in starts])[:n]
                boots.append(diffs[b].mean())
            lo95, hi95 = np.percentile(boots, [2.5, 97.5])
            line += f"  vs T1 {mean:+6.1f} 90% [{lo:+6.1f},{hi:+6.1f}] 95% [{lo95:+6.1f},{hi95:+6.1f}]"
        print(line)


if __name__ == "__main__":
    main()
