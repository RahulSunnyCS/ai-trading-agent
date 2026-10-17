"""Experiment 9: hedges held to the close on T1's picks, registered before the run.

A long CE + PE at closest premium X, entered with the pick, never closed by the pick's leg SL or its
MTM stop (a separate position, no stops, exit 15:28); the pick itself is unchanged. Grid: X pairs x
which picks (Widesl / Dir / both) x days (all / expiry only), first year chooses, test year judges
with Experiment 7's rule. Net of charges, 1 lot per pick; margin from Experiment 7's model.

    uv run python research/bl107/hedges_hold.py
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import replay as rp  # noqa: E402
from run_grid import trade_charges  # noqa: E402

rp.patch_parts()
from wings import HEDGE_K, SPAN_RATE  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import (  # noqa: E402
    Leg,
    LegwiseStrategy,
    Overall,
    Strike,
    load_legwise,
)
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.readout import max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import is_buy, is_dir, is_wide  # noqa: E402

CUT = date(2025, 10, 9)
COARSE = [(5.0, 15.0), (10.0, 30.0), (20.0, 60.0)]
WHO = ("wide", "dir", "both")
DAYS = ("all", "expiry")
OUT = HERE / "results" / "hedges_hold"


def hedge_of(st: LegwiseStrategy, x: float) -> LegwiseStrategy:
    legs = [Leg(id=f"hedge_{t.lower()}", lots=st.legs[0].lots, position="buy", option_type=t,
                expiry=st.legs[0].expiry, strike=Strike(closest_premium=x)) for t in ("CE", "PE")]
    return LegwiseStrategy(id=f"{st.id}_hedge", underlying=st.underlying, entry_time=st.entry_time,
                           exit_time="15:28", square_off="partial", legs=legs, overall=Overall(),
                           execution=st.execution)


def charges(u: str, d: date, r) -> float:
    return sum(trade_charges(u, d, t)[0] for t in r.trades)


def margin(main, hedge, underlying: str, expiry_day: bool, kind: str) -> float:
    """Experiment 7's model at the pick's first entry; the hedge strikes as the wings."""
    if kind == "buy":
        return float(sum(t.entry_price * t.qty for t in main.trades if t.position == "buy"))
    first = {}
    for t in main.trades:
        if t.position == "sell" and t.contract[2] not in first:
            first[t.contract[2]] = t
    if not first:
        return 0.0
    q = next(iter(first.values())).qty
    strikes = [t.contract[1] for t in first.values()]
    exposure = 0.02 * sum(strikes) * q
    span = SPAN_RATE[underlying] * float(np.mean(strikes)) * q
    if hedge is not None and "CE" in first and "PE" in first:
        hs = {t.contract[2]: t.contract[1] for t in hedge.trades}
        if "CE" in hs and "PE" in hs:
            width = np.mean([abs(hs["CE"] - first["CE"].contract[1]), abs(first["PE"].contract[1] - hs["PE"])])
            span = min(span, HEDGE_K * width * q)
    elm = 0.02 * sum(strikes) * q if expiry_day else 0.0
    return float(exposure + span + elm)


def main() -> None:
    picks = json.loads((HERE / "results" / "picker_mix" / "t1_picks.json").read_text())
    cells = {c["name"]: c for c in json.loads((HERE / "results" / "cells.json").read_text())}
    exp = rp.expiry_days()
    root = Path(data_dir())
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    cache: dict[str, LegwiseStrategy] = {}

    def strategy(n: str) -> LegwiseStrategy:
        if n not in cache:
            if n in cells:
                c = cells[n]
                p = {k: tuple(v) if isinstance(v, list) else v for k, v in c["params"].items()}
                cache[n] = grid.build(grid.Cell(c["family"], c["index"], c["slot"], p))
            else:
                cache[n] = load_legwise(grid.ROTATION / f"{n}.yaml")
        return cache[n]

    def run(pairs):
        """Per day: the unhedged book (net, margin) and per (pair, who, days) the hedged book, plus the
        hedges' own net and how much of it came on days a pick's stop fired."""
        keys = [(p, w, dd) for p in pairs for w in WHO for dd in DAYS]
        days, base = [], []
        book = {k: [] for k in keys}
        hedge_own = {k: [] for k in keys}
        hedge_stopday = {k: [] for k in keys}
        for row in picks:
            d = date.fromisoformat(row["day"])
            loaded: dict[str, object] = {}
            b_net = b_mar = 0.0
            acc = {k: [0.0, 0.0, 0.0, 0.0] for k in keys}  # net, margin, hedge net, hedge net on stop days
            for n in row["picks"]:
                st = strategy(n)
                u = st.underlying
                if u not in loaded:
                    loaded[u] = load_day(root, u, d)
                is_exp = d in exp["N" if u == "NIFTY" else "S"]
                kind = "buy" if is_buy(n) else "wide" if is_wide(n) else "dir" if is_dir(n) else "other"
                r = simulate_day(st, loaded[u], ref, sizing)
                net = r.gross - charges(u, d, r)
                mar = margin(r, None, u, is_exp, kind)
                stopped = bool(r.stopped_by) or any(t.exit_reason == "SL" for t in r.trades)
                b_net += net
                b_mar += mar
                hedged: dict[float, tuple[float, float]] = {}
                for k in keys:
                    p, who, dd = k
                    use = kind in ("wide", "dir") and (who == "both" or who == kind) and (dd == "all" or is_exp)
                    if not use:
                        acc[k][0] += net
                        acc[k][1] += mar
                        continue
                    x = p[0] if u == "NIFTY" else p[1]
                    if x not in hedged:
                        h = simulate_day(hedge_of(st, x), loaded[u], ref, sizing)
                        hedged[x] = (h.gross - charges(u, d, h), margin(r, h, u, is_exp, kind))
                    hn, hm = hedged[x]
                    acc[k][0] += net + hn
                    acc[k][1] += hm
                    acc[k][2] += hn
                    acc[k][3] += hn if stopped else 0.0
            days.append(d)
            base.append((b_net, b_mar))
            for k in keys:
                book[k].append((acc[k][0], acc[k][1]))
                hedge_own[k].append(acc[k][2])
                hedge_stopday[k].append(acc[k][3])
        return days, np.array(base), {k: np.array(v) for k, v in book.items()}, hedge_own, hedge_stopday

    def stats(net, mar):
        return {"net": float(net.sum()), "mean_margin": float(mar.mean()), "rom": float(net.sum() / mar.mean()),
                "worst": float(net.min()), "worst5": float(np.sort(net)[:5].sum()), "maxdd": max_drawdown(net)}

    OUT.mkdir(parents=True, exist_ok=True)
    days, base, book, own, stopday = run(COARSE)
    first = np.array([d < CUT for d in days])

    def choose(book):
        b = stats(base[first, 0], base[first, 1])
        ok = [k for k, a in book.items() if stats(a[first, 0], a[first, 1])["net"] >= 0.85 * b["net"]]
        return max(ok, key=lambda k: stats(book[k][first, 0], book[k][first, 1])["rom"]) if ok else None

    best = choose(book)
    if best is not None:
        i = COARSE.index(best[0])
        extra = [((COARSE[i][0] + COARSE[j][0]) / 2, (COARSE[i][1] + COARSE[j][1]) / 2)
                 for j in (i - 1, i + 1) if 0 <= j < len(COARSE)]
        extra += [(3.0, 10.0)] if i == 0 else []
        extra += [(30.0, 90.0)] if i == len(COARSE) - 1 else []
        _, _, b2, o2, s2 = run(extra)
        book.update(b2)
        own.update(o2)
        stopday.update(s2)
        best = choose(book)

    rows = []
    hdr = (f"{'variant':34s}{'1st net':>10s}{'1st RoM':>8s}{'test net':>10s}{'margin':>10s}{'RoM':>6s}"
           f"{'worst':>9s}{'worst-5':>10s}{'maxDD':>10s}{'hedge own':>11s}{'on stop days':>13s}")
    print(hdr)
    a, t = stats(base[first, 0], base[first, 1]), stats(base[~first, 0], base[~first, 1])
    print(f"{'no hedge':34s}{a['net']:10,.0f}{a['rom']:8.2f}{t['net']:10,.0f}{t['mean_margin']:10,.0f}{t['rom']:6.2f}"
          f"{t['worst']:9,.0f}{t['worst5']:10,.0f}{t['maxdd']:10,.0f}")
    rows.append({"variant": "no hedge", **{f"first_{x}": y for x, y in a.items()}, **{f"test_{x}": y for x, y in t.items()}})
    for k, arr in sorted(book.items(), key=lambda kv: (kv[0][1], kv[0][2], kv[0][0])):
        a, t = stats(arr[first, 0], arr[first, 1]), stats(arr[~first, 0], arr[~first, 1])
        ho = np.array(own[k])[~first].sum()
        hs = np.array(stopday[k])[~first].sum()
        label = f"N {k[0][0]:g}/S {k[0][1]:g}, {k[1]}, {k[2]}"
        print(f"{label:34s}{a['net']:10,.0f}{a['rom']:8.2f}{t['net']:10,.0f}{t['mean_margin']:10,.0f}{t['rom']:6.2f}"
              f"{t['worst']:9,.0f}{t['worst5']:10,.0f}{t['maxdd']:10,.0f}{ho:11,.0f}{hs:13,.0f}")
        rows.append({"variant": label, **{f"first_{x}": y for x, y in a.items()}, **{f"test_{x}": y for x, y in t.items()},
                     "test_hedge_own": ho, "test_hedge_on_stop_days": hs})
    with (OUT / "summary.csv").open("w", newline="") as h:
        w = csv.DictWriter(h, fieldnames=sorted({f for r in rows for f in r}, key=lambda f: (f != "variant", f)))
        w.writeheader()
        w.writerows(rows)
    if best is None:
        print("\nno hedged variant kept 85 % of the first-year net: no hedge")
        return
    b = stats(base[~first, 0], base[~first, 1])
    c = stats(book[best][~first, 0], book[best][~first, 1])
    tail = c["worst"] >= 0.7 * b["worst"] and c["worst5"] >= 0.7 * b["worst5"]
    ok = tail and c["net"] >= 0.85 * b["net"] and c["rom"] > b["rom"]
    print(f"\nchosen on the first year: N {best[0][0]:g} / S {best[0][1]:g}, {best[1]}, {best[2]}")
    print(f"test year vs no hedge: net {c['net']:,.0f} vs {b['net']:,.0f}; RoM {c['rom']:.2f} vs {b['rom']:.2f}; "
          f"worst {c['worst']:,.0f} vs {b['worst']:,.0f}; worst-5 {c['worst5']:,.0f} vs {b['worst5']:,.0f}"
          f" -> {'PASS' if ok else 'no pass: no hedge'}")


if __name__ == "__main__":
    main()
