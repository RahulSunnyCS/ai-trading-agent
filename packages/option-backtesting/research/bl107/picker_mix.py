"""Experiment 6: picker mix. Adaptive (list C, registered weights and lookbacks) under three selection
rules — (a) today: 3 core with at least 2 Widesl; (b) at least 1 Widesl; (c) 4 core with at least
2 Widesl — over Core-298 and Core-298 + T1, every day after the warm-up from 2024-10-09 (history from
2024-10-09 for both universes). Also saves rule (a)'s daily T1 picks for Experiment 5.

    uv run python research/bl107/picker_mix.py
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
import replay_both_years as rb  # noqa: E402  (patches variant names for T1 / pool)

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import score, store  # noqa: E402
from option_backtesting.rotation.lists import WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402

RULES = {"a: 3 picks, >=2 Widesl": (3, 2), "b: 3 picks, >=1 Widesl": (3, 1), "c: 4 picks, >=2 Widesl": (4, 2)}
OUT = HERE / "results" / "picker_mix"


def main() -> None:
    root = data_dir()
    attrs = store.read_days(root)
    m = store.load_matrix(variant_names(), root)
    cells = {c["name"]: c for c in json.loads((rp.RES / "cells.json").read_text())}
    added = rb.load([rp.RES / "sim_early" / "t1t2", rp.RES / "sim"])
    t1 = [n for n in sorted(added) if cells[n]["universe"] == "T1"]
    days = sorted(set(d for d in m.days if d in attrs and d <= rb.END and d.weekday() < 5)
                  & set.intersection(*(set(date.fromisoformat(x) for x in added[n]) for n in t1)))
    mi = {d: i for i, d in enumerate(m.days)}
    core_g = np.array([[m.values[mi[d], j] for j in range(len(m.names))] for d in days])
    t1_g = np.array([[added[n][d.isoformat()] for n in t1] for d in days])
    replay_days = days[WARMUP:]
    first = np.array([d < rb.CUT for d in replay_days])
    exp = rp.expiry_days()
    universes = {"Core-298": (list(m.names), core_g), "T1": (list(m.names) + t1, np.hstack([core_g, t1_g]))}
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Adaptive, gross per lot-day; first year {replay_days[0]} -> 2025-10-08 ({first.sum()} days), "
          f"test year ({(~first).sum()} days)\n")
    for uname, (names, G) in universes.items():
        res = {}
        for rule, (n_core, min_wide) in RULES.items():
            score.N_CORE, score.MIN_WIDE_N = n_core, min_wide
            r = rp.replay(days, names, G, G, attrs, replay_days, 0.0, [""] * len(names), exp)
            res[rule] = np.array(r["C"]["gross"])
            if uname == "T1" and rule.startswith("a"):
                (OUT / "t1_picks.json").write_text(json.dumps(
                    [{"day": d.isoformat(), "picks": p} for d, p in zip(r["C"]["day"], r["C"]["picks"], strict=True)]))
        score.N_CORE, score.MIN_WIDE_N = RULES["a: 3 picks, >=2 Widesl"]
        base = res["a: 3 picks, >=2 Widesl"]
        print(f"== {uname} ==")
        print(f"{'rule':24s}{'1st yr':>8s}{'test yr':>9s}{'test maxDD':>12s}{'vs (a) test':>13s}{'90%':>18s}{'95%':>18s}  verdict")
        for rule, g in res.items():
            t, b = g[~first], base[~first]
            line = f"{rule:24s}{g[first].mean():8.0f}{t.mean():9.0f}{max_drawdown(t):12,.0f}"
            if not rule.startswith("a"):
                mean, lo, hi = block_bootstrap_mean(t - b)
                rng = np.random.default_rng(20261012)
                n = len(t)
                idx = np.arange(n)
                boots = []
                for _ in range(2000):
                    starts = rng.integers(0, n, size=int(np.ceil(n / 5)))
                    sel = np.concatenate([np.take(idx, range(s0, s0 + 5), mode="wrap") for s0 in starts])[:n]
                    boots.append((t - b)[sel].mean())
                lo95, hi95 = np.percentile(boots, [2.5, 97.5])
                ok = lo > 0 and max_drawdown(t) >= max_drawdown(b)
                line += (f"{mean:+13.0f}  [{lo:+6.0f},{hi:+6.0f}]  [{lo95:+6.0f},{hi95:+6.0f}]  "
                         f"{'PASS' if ok else 'no pass'}")
            print(line)
        print()


if __name__ == "__main__":
    main()
