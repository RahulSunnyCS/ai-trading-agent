"""BL-107 check (owner, 2026-10-16; SEEN: the idea came from the test-year breakdown, so this is
information, not evidence): Adaptive over Core-298 + T1 with a hard day filter. Each day an
expiry-tagged T1 variant is in the universe only on its index's weekly expiry day, a non-expiry one
only on other days; Core variants are always in. The day's composite is computed over the eligible
universe only.

    uv run python research/bl107/hard_filter.py
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


def main() -> None:
    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    new = rp.load_new()
    cells = {c["name"]: c for c in json.loads((rp.RES / "cells.json").read_text())}
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
    tag = np.array([""] * len(core) + [cells[n]["kind"] for n in t1])
    idx_letter = np.array([n.split("_")[0] for n in names])
    out = {"filter": [], "nofilter": [], "core": []}
    share_new = []
    col = {n: j for j, n in enumerate(names)}
    for d in test:
        i = common.index(d)
        a = attrs[d]
        is_exp = np.array([d in exp[x] for x in idx_letter])
        ok = (tag == "") | ((tag == "expiry") & is_exp) | ((tag == "other") & ~is_exp)
        for label, mask in (("filter", ok), ("nofilter", np.ones(len(names), bool)), ("core", tag == "")):
            sel_idx = np.where(mask)[0]
            nm = [names[j] for j in sel_idx]
            P = G[:i, sel_idx]
            hist = pick.History(common[:i], nm, P, [attrs[x]["weekday"] for x in common[:i]],
                                [attrs[x]["vix_band"] for x in common[:i]], [attrs[x]["dte_n"] for x in common[:i]],
                                [attrs[x]["dte_s"] for x in common[:i]], "")
            vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "", "None") else None
            wd = np.array([*hist.weekday, d.strftime("%a")])
            band = np.array([*hist.band, score.vix_band(vix)])
            dn = np.array([*hist.dte_n, a["dte_n"]])
            ds = np.array([*hist.dte_s, a["dte_s"]])
            comp = score.composite(np.vstack([P, np.zeros((1, len(nm)))]), wd, band, score.dte_matrix(dn, ds, nm),
                                   nm, LISTS["C"], score.family_index(nm))
            s = score.select(comp, nm)
            picks = s.core + s.buy
            out[label].append(float(np.mean([G[i, col[p]] for p in picks])))
            if label == "filter":
                share_new.append(np.mean([p in cells for p in picks]))
    base = np.array(out["core"])
    print(f"Adaptive, {len(test)} test days {test[0]} -> {test[-1]}, gross per lot-day (SEEN: information only)\n")
    for label, text in (("core", "Core-298"), ("nofilter", "T1, no weight"), ("filter", "T1, hard day filter")):
        g = np.array(out[label])
        line = f"{text:22s} {g.mean():7.1f}  total {g.sum():9,.0f}  maxDD {max_drawdown(g):8,.0f}  win {np.mean(g > 0):.0%}  worst {g.min():7,.0f}"
        if label != "core":
            mean, lo, hi = block_bootstrap_mean(g - base)
            line += f"  vs Core {mean:+6.1f} [{lo:+6.1f},{hi:+6.1f}]"
        print(line)
    f, nf = np.array(out["filter"]), np.array(out["nofilter"])
    mean, lo, hi = block_bootstrap_mean(f - nf)
    print(f"\nfilter minus no filter: {mean:+.1f} [{lo:+.1f},{hi:+.1f}] per lot-day; T1 share of picks with the filter {np.mean(share_new):.0%}")


if __name__ == "__main__":
    main()
