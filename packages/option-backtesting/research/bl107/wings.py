"""Experiment 7: wings (a long CE + PE at closest premium X) on T1's Widesl picks, registered before the
run. The day's T1 Adaptive picks (from picker_mix) are unchanged; only Widesl picks get wings. Net of
charges, 1 lot per pick, the book summed per day; margin from the broker-calculator model in the item.

Coarse pairs (NIFTY X, SENSEX X) = (5,15), (10,30), (20,60); then the midpoints next to the
first-year best (one step beyond at an end); two scopes (all days, expiry days only). Chosen on the
first year (best net return on margin with net >= 85 % of the unwinged book); judged once on the
test year.

    uv run python research/bl107/wings.py
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
from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import (  # noqa: E402
    Leg,
    LegwiseStrategy,
    Strike,
    load_legwise,
)
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.readout import max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import is_buy, is_wide  # noqa: E402

CUT = date(2025, 10, 9)
COARSE = [(5.0, 15.0), (10.0, 30.0), (20.0, 60.0)]
SPAN_RATE = {"NIFTY": 0.09, "SENSEX": 0.095}  # unhedged SPAN, share of one short leg's notional
HEDGE_K = 1.27  # hedged SPAN = K x mean wing width (points) x qty, fitted to the calculator
OUT = HERE / "results" / "wings"


def winged(st: LegwiseStrategy, x: float) -> LegwiseStrategy:
    s = st.model_copy(deep=True)
    for t in ("CE", "PE"):
        s.legs.append(Leg(id=f"wing_{t.lower()}", lots=s.legs[0].lots, position="buy", option_type=t,
                          expiry=s.legs[0].expiry, strike=Strike(closest_premium=x)))
    return LegwiseStrategy.model_validate(s.model_dump())


def margin(result, underlying: str, expiry_day: bool, kind: str) -> float:
    """The broker-calculator model for one pick's first entry (0 when nothing entered)."""
    shorts = {t.contract[2]: t for t in result.trades if t.position == "sell"}
    longs = {t.contract[2]: t for t in result.trades if t.position == "buy"}
    if kind == "buy":
        return float(sum(t.entry_price * t.qty for t in result.trades if t.position == "buy"))
    if not shorts:
        return 0.0
    first = {}
    for t in result.trades:  # the first entry per side
        if t.position == "sell" and t.contract[2] not in first:
            first[t.contract[2]] = t
    q = next(iter(first.values())).qty
    strikes = [t.contract[1] for t in first.values()]
    exposure = 0.02 * sum(strikes) * q
    span = SPAN_RATE[underlying] * float(np.mean(strikes)) * q
    if longs and "CE" in first and "PE" in first:
        wc = next(t for t in result.trades if t.position == "buy" and t.contract[2] == "CE").contract[1]
        wp = next(t for t in result.trades if t.position == "buy" and t.contract[2] == "PE").contract[1]
        width = np.mean([abs(wc - first["CE"].contract[1]), abs(first["PE"].contract[1] - wp)])
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

    def run(pairs: list[tuple[float, float]]) -> dict:
        """Per day: the unwinged book and, per pair, the winged book (net, margin)."""
        days, base, wing = [], [], {p: [] for p in pairs}
        for row in picks:
            d = date.fromisoformat(row["day"])
            loaded: dict[str, object] = {}
            b_net = b_mar = 0.0
            w = {p: [0.0, 0.0, 0.0, 0.0] for p in pairs}  # net all-days, margin, net expiry-only, margin
            for n in row["picks"]:
                st = strategy(n)
                u = st.underlying
                if u not in loaded:
                    loaded[u] = load_day(root, u, d)
                is_exp = d in exp["N" if u == "NIFTY" else "S"]
                kind = "buy" if is_buy(n) else "wide" if is_wide(n) else "dir"
                r = simulate_day(st, loaded[u], ref, sizing)
                net = r.gross - sum(trade_charges(u, d, t)[0] for t in r.trades)
                mar = margin(r, u, is_exp, kind)
                b_net += net
                b_mar += mar
                for p in pairs:
                    if kind != "wide":
                        for i, v in enumerate((net, mar, net, mar)):
                            w[p][i] += v
                        continue
                    x = p[0] if u == "NIFTY" else p[1]
                    rw = simulate_day(winged(st, x), loaded[u], ref, sizing)
                    nw = rw.gross - sum(trade_charges(u, d, t)[0] for t in rw.trades)
                    mw = margin(rw, u, is_exp, kind)
                    w[p][0] += nw
                    w[p][1] += mw
                    w[p][2] += nw if is_exp else net
                    w[p][3] += mw if is_exp else mar
            days.append(d)
            base.append((b_net, b_mar))
            for p in pairs:
                wing[p].append(tuple(w[p]))
        return {"days": days, "base": np.array(base), "wing": {p: np.array(v) for p, v in wing.items()}}

    def stats(net: np.ndarray, mar: np.ndarray) -> dict:
        return {"net": float(net.sum()), "mean_margin": float(mar.mean()), "rom": float(net.sum() / mar.mean()),
                "worst": float(net.min()), "worst5": float(np.sort(net)[:5].sum()), "maxdd": max_drawdown(net)}

    OUT.mkdir(parents=True, exist_ok=True)
    res = run(COARSE)
    first = np.array([d < CUT for d in res["days"]])

    def variants(res: dict) -> dict:
        out = {"none": (res["base"][:, 0], res["base"][:, 1])}
        for p, a in res["wing"].items():
            out[(p, "all")] = (a[:, 0], a[:, 1])
            out[(p, "expiry")] = (a[:, 2], a[:, 3])
        return out

    def choose(v: dict) -> tuple:
        b = stats(*[x[first] for x in v["none"]])
        ok = [k for k in v if k != "none" and stats(*[x[first] for x in v[k]])["net"] >= 0.85 * b["net"]]
        return max(ok, key=lambda k: stats(*[x[first] for x in v[k]])["rom"]) if ok else "none"

    v = variants(res)
    best = choose(v)
    if best != "none":  # refine around the best coarse pair
        i = COARSE.index(best[0])
        extra = []
        for j in (i - 1, i + 1):
            if 0 <= j < len(COARSE):
                extra.append(((COARSE[i][0] + COARSE[j][0]) / 2, (COARSE[i][1] + COARSE[j][1]) / 2))
        if i == 0:
            extra.append((3.0, 10.0))
        if i == len(COARSE) - 1:
            extra.append((30.0, 90.0))
        res2 = run(extra)
        v.update(variants({"days": res2["days"], "base": res2["base"], "wing": res2["wing"]}))
        best = choose(v)
    rows = []
    print(f"{'variant':26s}{'1st net':>10s}{'1st RoM':>9s}{'test net':>10s}{'test margin':>13s}{'test RoM':>10s}"
          f"{'test worst':>11s}{'worst-5':>10s}{'test maxDD':>11s}")
    for k, (net, mar) in v.items():
        a, t = stats(net[first], mar[first]), stats(net[~first], mar[~first])
        label = "no wings" if k == "none" else f"N {k[0][0]:g} / S {k[0][1]:g}, {k[1]}"
        rows.append({"variant": label, **{f"first_{x}": y for x, y in a.items()}, **{f"test_{x}": y for x, y in t.items()}})
        print(f"{label:26s}{a['net']:10,.0f}{a['rom']:9.2f}{t['net']:10,.0f}{t['mean_margin']:13,.0f}{t['rom']:10.2f}"
              f"{t['worst']:11,.0f}{t['worst5']:10,.0f}{t['maxdd']:11,.0f}")
    with (OUT / "summary.csv").open("w", newline="") as h:
        wr = csv.DictWriter(h, fieldnames=list(rows[0]))
        wr.writeheader()
        wr.writerows(rows)
    if best == "none":
        print("\nno wing variant kept 85 % of the first-year net: no wings")
        return
    b, c = stats(*[x[~first] for x in v["none"]]), stats(*[x[~first] for x in v[best]])
    tail = c["worst"] >= 0.7 * b["worst"] and c["worst5"] >= 0.7 * b["worst5"]
    ok = tail and c["net"] >= 0.85 * b["net"] and c["rom"] > b["rom"]
    print(f"\nchosen on the first year: N {best[0][0]:g} / S {best[0][1]:g}, {best[1]}")
    print(f"test year vs no wings: net {c['net']:,.0f} vs {b['net']:,.0f}; RoM {c['rom']:.2f} vs {b['rom']:.2f}; "
          f"worst {c['worst']:,.0f} vs {b['worst']:,.0f}; worst-5 {c['worst5']:,.0f} vs {b['worst5']:,.0f}"
          f" -> {'PASS' if ok else 'no pass: no wings'}")


if __name__ == "__main__":
    main()
