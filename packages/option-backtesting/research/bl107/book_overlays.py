"""Experiment 5: book overlays on T1's Adaptive picks (registered before the run). The day's picks as
one book, minute by minute (BL-095 `apply_book`), gross: book stop x profit lock x sizing. The
combination is chosen on the first year (best Calmar with a total >= 95 % of the plain book) and
checked once on the test year.

    uv run python research/bl107/book_overlays.py   (needs results/picker_mix/t1_picks.json)
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.portfolio import (  # noqa: E402
    Member,
    Trail,
    apply_book,
    member_from_curve,
)
from option_backtesting.rotation.readout import max_drawdown  # noqa: E402

CUT = date(2025, 10, 9)
STOPS = (None, 6000.0, 8000.0, 10000.0)
LOCKS = {"none": None, "lock 3k at +6k": Trail("lock", a=6000.0, b=3000.0), "lock 4k at +8k": Trail("lock", a=8000.0, b=4000.0)}
SIZING = ("1-1-1", "2-1-1")


def calmar(x: np.ndarray) -> float:
    dd = max_drawdown(x)
    return float(x.sum() / len(x) * 252 / abs(dd)) if dd < 0 else float("inf")


def main() -> None:
    picks = json.loads((HERE / "results" / "picker_mix" / "t1_picks.json").read_text())
    cells = {c["name"]: c for c in json.loads((HERE / "results" / "cells.json").read_text())}
    root = Path(data_dir())
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    strategies: dict[str, object] = {}

    def strategy(n: str):
        if n not in strategies:
            if n in cells:
                c = cells[n]
                p = {k: tuple(v) if isinstance(v, list) else v for k, v in c["params"].items()}
                strategies[n] = grid.build(grid.Cell(c["family"], c["index"], c["slot"], p))
            else:
                strategies[n] = load_legwise(grid.ROTATION / f"{n}.yaml")
        return strategies[n]

    combos = [(s, lk, sz) for s in STOPS for lk in LOCKS for sz in SIZING]
    books = {c: [] for c in combos}
    days = []
    for row in picks:
        d = date.fromisoformat(row["day"])
        loaded: dict[str, object] = {}
        curves = []
        for n in row["picks"]:
            st = strategy(n)
            if st.underlying not in loaded:
                loaded[st.underlying] = load_day(root, st.underlying, d)
            r = simulate_day(st, loaded[st.underlying], ref, sizing)
            curves.append((n, r.mtm, r.gross))
        days.append(d)
        for s, lk, sz in combos:
            members = [
                Member(n, 1, member_from_curve(n, 1, curve, gross).pnl) for n, curve, gross in curves
            ]
            if sz == "2-1-1":
                members[0] = Member(members[0].name, 2, members[0].pnl)  # the highest-scored core pick
            books[(s, lk, sz)].append(apply_book(members, s, LOCKS[lk]).gross_with)
    first = np.array([d < CUT for d in days])
    plain = (None, "none", "1-1-1")
    P = np.array(books[plain])
    print(f"book P&L (gross, ₹), first year {first.sum()} days / test year {(~first).sum()} days\n")
    print(f"{'stop':>7s} {'lock':16s}{'size':>6s}{'1st total':>11s}{'1st Calmar':>11s}{'test total':>12s}{'test maxDD':>12s}{'test Calmar':>12s}")
    for c in combos:
        x = np.array(books[c])
        s, lk, sz = c
        print(f"{('none' if s is None else f'{s:,.0f}'):>7s} {lk:16s}{sz:>6s}{x[first].sum():11,.0f}{calmar(x[first]):11.2f}"
              f"{x[~first].sum():12,.0f}{max_drawdown(x[~first]):12,.0f}{calmar(x[~first]):12.2f}")
    eligible = [c for c in combos if np.array(books[c])[first].sum() >= 0.95 * P[first].sum()]
    chosen = max(eligible, key=lambda c: calmar(np.array(books[c])[first]))
    x = np.array(books[chosen])
    ok = calmar(x[~first]) > calmar(P[~first]) and x[~first].sum() >= 0.95 * P[~first].sum()
    print(f"\nchosen on the first year: stop {chosen[0]}, {chosen[1]}, sizing {chosen[2]}")
    print(f"test year: total {x[~first].sum():,.0f} vs plain {P[~first].sum():,.0f}; Calmar {calmar(x[~first]):.2f} vs "
          f"{calmar(P[~first]):.2f}; maxDD {max_drawdown(x[~first]):,.0f} vs {max_drawdown(P[~first]):,.0f}"
          f" -> {'PASS' if ok else 'no pass: no overlay'}")


if __name__ == "__main__":
    main()
