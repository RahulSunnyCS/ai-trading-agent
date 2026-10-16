"""BL-111 Amendment A1: the 2-2-1-1 rank ladder on the T1 universe, registered before the run.

Adaptive (list C) ranks Core-298 + the 223 T1 variants every day after the warm-up; three arms at 6
lots: E = 3 picks (>= 2 Widesl) x 2 lots; L2 = 4 picks (>= 2 Widesl) x (2, 2, 1, 1); L1 = 4 picks
(>= 1 Widesl) x (2, 2, 1, 1). Ranks = the selected picks by composite, highest first. No Buy add-on.
Every pick is re-simulated on its day; net at k lots = k x gross - charges at k lots (brokerage flat
per order, the rest scales with lots). The test year decides (net); the rest is descriptive.

    uv run python research/bl107/lot_ladder.py
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import replay as rp  # noqa: E402
import replay_both_years as rb  # noqa: E402  (patches variant names for T1)
from run_grid import BROKERAGE_PER_ORDER, GST, ORDERS_PER_TRADE, trade_charges  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation import pick, score, store  # noqa: E402
from option_backtesting.rotation.lists import LISTS, SIZING_DATE, WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402

SEED = 20261015
ARMS = {"E": (3, 2, (2, 2, 2)), "L2": (4, 2, (2, 2, 1, 1)), "L1": (4, 1, (2, 2, 1, 1))}
FLAT = ORDERS_PER_TRADE * BROKERAGE_PER_ORDER * (1 + GST)  # per closed trade, whatever the lots
OUT = HERE / "results" / "lot_ladder"


def ranked(comp: np.ndarray, names: list[str], n_core: int, min_wide: int) -> list[str]:
    score.N_CORE, score.MIN_WIDE_N = n_core, min_wide
    p = score.select(comp, names)
    return sorted(p.core, key=lambda n: (-p.composite[n], n))


def composites(days, names, G, attrs, replay_days) -> dict[date, np.ndarray]:
    """List C's composite per replay day, from the results before that day (as replay.replay)."""
    lst = LISTS["C"]
    idx = {d: i for i, d in enumerate(days)}
    fam = score.family_index(list(names))
    out = {}
    for d in replay_days:
        i = idx[d]
        a = attrs[d]
        hist = pick.History(
            days[:i], list(names), G[:i],
            [attrs[x]["weekday"] for x in days[:i]], [attrs[x]["vix_band"] for x in days[:i]],
            [attrs[x]["dte_n"] for x in days[:i]], [attrs[x]["dte_s"] for x in days[:i]], "",
        )
        vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "", "None") else None
        weekday = np.array([*hist.weekday, d.strftime("%a")])
        band = np.array([*hist.band, score.vix_band(vix)])
        dmat = score.dte_matrix(np.array([*hist.dte_n, a["dte_n"]]), np.array([*hist.dte_s, a["dte_s"]]), list(names))
        Pv = np.vstack([hist.values, np.zeros((1, len(names)))])
        out[d] = score.composite(Pv, weekday, band, dmat, list(names), lst, fam)
    return out


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
    universes = {"T1": (list(m.names) + t1, np.hstack([core_g, t1_g])), "Core-298": (list(m.names), core_g)}
    stored = {d: {} for d in replay_days}
    for names, G in universes.values():
        for j, n in enumerate(names):
            for k, d in enumerate(days[WARMUP:]):
                stored[d][n] = G[WARMUP + k, j]

    picks: dict[str, dict[str, dict[date, list[str]]]] = {}
    for uname, (names, G) in universes.items():
        comp = composites(days, names, G, attrs, replay_days)
        picks[uname] = {arm: {d: ranked(comp[d], names, n, w) for d in replay_days} for arm, (n, w, _) in ARMS.items()}
        print(f"{uname}: ranked {len(replay_days)} days", flush=True)
    score.N_CORE, score.MIN_WIDE_N = ARMS["E"][0], ARMS["E"][1]

    # one-lot gross and charges for every pick, re-simulated
    need: dict[date, set[str]] = defaultdict(set)
    for u in picks.values():
        for arm in u.values():
            for d, ps in arm.items():
                need[d].update(ps)
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    cache: dict[str, object] = {}

    def strategy(n: str):
        if n not in cache:
            if n in cells:
                c = cells[n]
                p = {k: tuple(v) if isinstance(v, list) else v for k, v in c["params"].items()}
                cache[n] = grid.build(grid.Cell(c["family"], c["index"], c["slot"], p))
            else:
                cache[n] = load_legwise(grid.ROTATION / f"{n}.yaml")
        return cache[n]

    sim: dict[tuple[date, str], tuple[float, float, int]] = {}
    mismatch = []
    for i, d in enumerate(replay_days):
        loaded: dict[str, object] = {}
        for n in sorted(need[d]):
            st = strategy(n)
            u = st.underlying
            if u not in loaded:
                loaded[u] = load_day(Path(root), u, d)
            r = simulate_day(st, loaded[u], ref, sizing)
            closed = [t for t in r.trades if t.exit_price is not None]
            sim[(d, n)] = (r.gross, sum(trade_charges(u, d, t)[0] for t in closed), len(closed))
            if abs(r.gross - stored[d][n]) > 1.0:
                mismatch.append((d.isoformat(), n, r.gross, stored[d][n]))
        if i % 50 == 0:
            print(f"simulated {i + 1}/{len(replay_days)} days", flush=True)

    def pnl(d: date, n: str, k: int) -> tuple[float, float]:
        g, c1, n_closed = sim[(d, n)]
        flat = n_closed * FLAT
        return k * g, k * g - (flat + k * (c1 - flat))

    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    series: dict[tuple[str, str, str], np.ndarray] = {}
    for uname in universes:
        for arm, (_, _, lots) in ARMS.items():
            g6, n6, gb, nb = [], [], [], []
            for d in replay_days:
                ps = picks[uname][arm][d]
                gp = [pnl(d, n, k) for n, k in zip(ps, lots, strict=True)]
                g6.append(sum(x[0] for x in gp))
                n6.append(sum(x[1] for x in gp))
                is_exp = d in exp["N"] or d in exp["S"]
                if is_exp:
                    book = gp
                else:  # ordinary days at 3 lots: E = top 3 x 1; ladders = E's top 2 x (2, 1)
                    e = picks[uname]["E"][d]
                    book = [pnl(d, n, 1) for n in e] if arm == "E" else [pnl(d, e[0], 2), pnl(d, e[1], 1)]
                gb.append(sum(x[0] for x in book))
                nb.append(sum(x[1] for x in book))
                rows.append({"universe": uname, "arm": arm, "day": d.isoformat(), "picks": "|".join(ps),
                             "gross6": g6[-1], "net6": n6[-1], "book_gross": gb[-1], "book_net": nb[-1]})
            for key, v in (("gross6", g6), ("net6", n6), ("book_gross", gb), ("book_net", nb)):
                series[(uname, arm, key)] = np.array(v)
    with (OUT / "daily.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    print(f"\nre-simulated picks: {len(sim)}; one-lot gross differs from the stored result by > ₹1 on {len(mismatch)}")
    for x in mismatch[:10]:
        print("  ", x)
    print(f"days: first year {first.sum()} ({replay_days[0]} -> 2025-10-08), test year {(~first).sum()}")
    for uname in universes:
        for key, label in (("net6", "6 lots every day, net"), ("gross6", "6 lots every day, gross"),
                           ("book_net", "owner's book (3 ordinary / 6 expiry), net")):
            e = series[(uname, "E", key)]
            print(f"\n== {uname}: {label} ==")
            print(f"{'arm':4s}{'1st total':>12s}{'1st /lot-d':>11s}{'test total':>12s}{'test /lot-d':>12s}{'test maxDD':>12s}"
                  f"{'vs E /day':>11s}{'90% interval':>20s}")
            for arm in ARMS:
                x = series[(uname, arm, key)]
                lots = 6.0 if key != "book_net" else np.nan
                line = (f"{arm:4s}{x[first].sum():12,.0f}{x[first].mean() / lots:11.0f}{x[~first].sum():12,.0f}"
                        f"{x[~first].mean() / lots:12.0f}{max_drawdown(x[~first]):12,.0f}")
                if arm != "E":
                    mean, lo, hi = block_bootstrap_mean(x[~first] - e[~first], seed=SEED)
                    line += f"{mean:+11,.0f}  [{lo:+8,.0f},{hi:+8,.0f}]"
                print(line)
    print("\n== Decision (T1, 6 lots, net, test year) ==")
    e = series[("T1", "E", "net6")][~first]
    verdict = {}
    for arm in ("L2", "L1"):
        x = series[("T1", arm, "net6")][~first]
        _, lo, _ = block_bootstrap_mean(x - e, seed=SEED)
        a = x.sum() >= 1.10 * e.sum() if e.sum() > 0 else x.sum() > 0 and x.sum() - e.sum() >= 0.10 * abs(e.sum())
        b = max_drawdown(x) >= max_drawdown(e)
        c = lo > 0
        verdict[arm] = a and b and c
        print(f"{arm}: total {x.sum():,.0f} vs E {e.sum():,.0f} ({x.sum() / e.sum() - 1:+.1%}) (a) {'ok' if a else 'fail'};"
              f" maxDD {max_drawdown(x):,.0f} vs {max_drawdown(e):,.0f} (b) {'ok' if b else 'fail'};"
              f" interval lower {lo:+,.0f}/day (c) {'ok' if c else 'fail'} -> {'PASS' if verdict[arm] else 'no pass'}")
    l1, l2 = series[("T1", "L1", "net6")][~first], series[("T1", "L2", "net6")][~first]
    mean, lo, hi = block_bootstrap_mean(l1 - l2, seed=SEED)
    print(f"L1 - L2: {mean:+,.0f}/day [{lo:+,.0f}, {hi:+,.0f}]")
    if verdict["L1"] and lo > 0:
        print("-> L1 (4 picks, >= 1 Widesl, 2-2-1-1)")
    elif verdict["L2"]:
        print("-> L2 (4 picks, >= 2 Widesl, 2-2-1-1)")
    else:
        print("-> killed: keep 3 picks x 2 lots")


if __name__ == "__main__":
    main()
