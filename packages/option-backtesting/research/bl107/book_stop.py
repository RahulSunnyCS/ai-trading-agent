"""BL-107 check: the day's Adaptive picks (T1 no weight vs Core-298) as one book, 1 lot each, under a
portfolio MTM stop on the combined P&L (BL-095's rule: the first minute the book reaches -stop,
everything closes at that minute's close and nothing later enters). Test year, 239 days.

    uv run python research/bl107/book_stop.py
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
import grid  # noqa: E402
from run_grid import trade_charges  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.portfolio import apply_book, member_from_curve  # noqa: E402
from option_backtesting.rotation.readout import max_drawdown  # noqa: E402

RES = HERE / "results"
STOPS = (None, 5000.0, 7000.0, 8000.0)
UNIVERSES = {"Core-298": "Core-298", "T1 (no weight)": "T1-25 w=0%"}


def main() -> None:
    cells = {c["name"]: c for c in json.loads((RES / "cells.json").read_text())}
    picks: dict[str, dict[date, list[str]]] = defaultdict(dict)
    for r in csv.DictReader((RES / "replay_daily.csv").open()):
        for label, key in UNIVERSES.items():
            if r["universe"] == key and r["list"] == "Adaptive":
                picks[label][date.fromisoformat(r["day"])] = r["picks"].split("|")
    root = Path(data_dir())
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    strat_cache: dict[str, object] = {}

    def strategy(n: str):
        if n not in strat_cache:
            if n in cells:
                c = cells[n]
                p = {k: tuple(v) if isinstance(v, list) else v for k, v in c["params"].items()}
                strat_cache[n] = grid.build(grid.Cell(c["family"], c["index"], c["slot"], p))
            else:
                strat_cache[n] = load_legwise(grid.ROTATION / f"{n}.yaml")
        return strat_cache[n]

    days = sorted(set(picks["Core-298"]) & set(picks["T1 (no weight)"]))
    out = {(label, s): [] for label in UNIVERSES for s in STOPS}
    charges_full = {label: [] for label in UNIVERSES}
    stopped_days = {(label, s): 0 for label in UNIVERSES for s in STOPS}
    n_buy = {label: 0 for label in UNIVERSES}
    for d in days:
        loaded = {}
        for label in UNIVERSES:
            members, ch = [], 0.0
            for n in picks[label][d]:
                st = strategy(n)
                u = st.underlying
                if u not in loaded:
                    loaded[u] = load_day(root, u, d)
                res = simulate_day(st, loaded[u], ref, sizing)
                members.append(member_from_curve(n, 1, res.mtm, res.gross))
                ch += sum(trade_charges(u, d, t)[0] for t in res.trades)
                n_buy[label] += st.legs[0].position == "buy"
            charges_full[label].append(ch)
            for s in STOPS:
                b = apply_book(members, s)
                out[(label, s)].append(b.gross_with)
                stopped_days[(label, s)] += b.stop_minute is not None
    print(f"{len(days)} test days {days[0]} -> {days[-1]}; 1 lot per pick (3 core picks, +1 Buy lot on Buy days: "
          + ", ".join(f"{k} {v} Buy-days" for k, v in n_buy.items()) + ")")
    print("Book P&L in ₹ for the whole book (gross; 'net' subtracts each day's full-day charges, a slight"
          " over-count on days the stop cut trades short)\n")
    print(f"{'universe':16s}{'book stop':>10s}{'total gross':>13s}{'per day':>9s}{'net total':>12s}{'max DD':>10s}"
          f"{'worst day':>11s}{'win':>6s}{'stopped':>9s}")
    rows = []
    for label in UNIVERSES:
        for s in STOPS:
            g = np.array(out[(label, s)])
            n = g - np.array(charges_full[label])
            row = {"universe": label, "stop": s or 0, "total_gross": g.sum(), "per_day": g.mean(), "total_net": n.sum(),
                   "max_dd": max_drawdown(g), "worst_day": g.min(), "win": float((g > 0).mean()),
                   "stopped_days": stopped_days[(label, s)]}
            rows.append(row)
            print(f"{label:16s}{('none' if s is None else f'₹{s:,.0f}'):>10s}{g.sum():13,.0f}{g.mean():9,.0f}{n.sum():12,.0f}"
                  f"{max_drawdown(g):10,.0f}{g.min():11,.0f}{(g > 0).mean():6.0%}{stopped_days[(label, s)]:9d}")
        print()
    with (RES / "book_stop.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
