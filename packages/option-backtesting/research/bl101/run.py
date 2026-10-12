"""BL-101: early long ATM straddle as a hedge for the owner's fixed base (NIFTY).

Rules are registered in backlog/BL-101-early-long-straddle-hedge.md (Phase 0) before this runs.
Read-only on the lake; writes only daily.csv / report.txt in this folder."""

from __future__ import annotations

import csv
import math
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation.lists import SIZING_DATE

HERE = Path(__file__).parent
PKG = HERE.parent.parent
FROM, TO, SPLIT = date(2024, 1, 1), date(2026, 10, 9), date(2025, 7, 1)
SLIPS = (0.0, 1.0, 2.0)
FILES = {
    "W": PKG / "strategies/legwise/nifty_widesl_917_otm1.yaml",
    "D": PKG / "strategies/rotation_base/N_dir_atm_0924.yaml",
    "L": HERE / "nifty_long_straddle_916.yaml",
}

# BL-096 registered charge model (copied, not imported across research folders)
STT_SELL = ((date(2000, 1, 1), 0.0010), (date(2026, 4, 1), 0.0015))
EXCH, SEBI, IPFT, STAMP, GST, BROK = 0.0003503, 0.000001, 0.000005, 0.00003, 0.18, 20.0


def charges(day, t) -> float:
    if t.exit_price is None:
        return 0.0
    sell = (t.entry_price if t.position == "sell" else t.exit_price) * t.qty
    buy = (t.exit_price if t.position == "sell" else t.entry_price) * t.qty
    both = sell + buy
    stt = [r for s, r in STT_SELL if day >= s][-1] * sell
    brok = 2 * BROK
    ex, se, ip = EXCH * both, SEBI * both, IPFT * both
    return brok + stt + ex + se + ip + STAMP * buy + GST * (brok + ex + se + ip)


def curve(result, n=400):
    """Minute-indexed gross MTM, forward-filled; 0 before the first sample."""
    pts = dict(result.mtm)
    if not pts:
        return None
    lo = min(pts)
    return pts, lo


def es95(x):
    x = np.sort(np.asarray(x))
    return float(x[: max(1, math.ceil(len(x) * 0.05))].mean())


def mdd(x):
    c = np.cumsum(x)
    return float((c - np.maximum.accumulate(np.maximum(c, 0))).min())


def stats(x):
    x = np.asarray(x)
    return dict(n=len(x), total=x.sum(), mean=x.mean(), es95=es95(x), mdd=mdd(x), worst=x.min(),
                win=float((x > 0).mean()))


def main() -> None:
    root = data_dir()
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    days, _ = backtest_days(root, "NIFTY", FROM, TO)
    base = {k: load_legwise(p) for k, p in FILES.items()}
    strat = {}
    for s in SLIPS:
        for k, b in base.items():
            c = b.model_copy(deep=True)
            c.execution.slippage_pct = s
            strat[(k, s)] = c
    rows, mtm = [], {}
    skipped = []
    for d in days:
        try:
            data = load_day(root, "NIFTY", d)
        except Exception as e:  # noqa: BLE001
            skipped.append((d, str(e)))
            continue
        row = {"day": d.isoformat()}
        for (k, s), st in strat.items():
            r = simulate_day(st, data, ref, sizing)
            ch = sum(charges(d, t) for t in r.trades)
            row[f"{k}_gross_{s:g}"] = r.gross
            row[f"{k}_net_{s:g}"] = r.gross - ch
            if s == 0.0:
                mtm[(d, k)] = dict(r.mtm)
        rows.append(row)
    with open(HERE / "daily.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    D = [date.fromisoformat(r["day"]) for r in rows]
    out = [f"BL-101  NIFTY  {D[0]} .. {D[-1]}  days={len(D)}  skipped={len(skipped)}"]

    def col(k, s):
        return np.array([r[f"{k}_net_{s:g}"] for r in rows])

    def block(title, idx, s, lots=1):
        W, Dr, L = col("W", s)[idx], col("D", s)[idx], col("L", s)[idx] * lots
        B = 2 * W + Dr
        BL = B + L
        mb, mbl = B.mean(), BL.mean()
        k = float(np.clip(mbl / mb, 0, 1)) if mb > 0 else 0.0
        res = {"B": stats(B), "B+L": stats(BL), f"kB(k={k:.2f})": stats(k * B), "0.75B": stats(0.75 * B),
               "L": stats(L)}
        out.append(f"\n== {title}  slip={s:g}%  L lots={lots}")
        out.append(f"{'':14}{'n':>5}{'total':>12}{'mean/day':>10}{'ES95':>10}{'MDD':>11}{'worst':>10}{'win%':>7}")
        for n, v in res.items():
            out.append(f"{n:14}{v['n']:5d}{v['total']:12,.0f}{v['mean']:10,.0f}{v['es95']:10,.0f}{v['mdd']:11,.0f}"
                       f"{v['worst']:10,.0f}{100*v['win']:7.1f}")
        b, bl, kb = res["B"], res["B+L"], res[f"kB(k={k:.2f})"]
        imp_es = (bl["es95"] - b["es95"]) / abs(b["es95"])
        imp_dd = (bl["mdd"] - b["mdd"]) / abs(b["mdd"])
        beat = bl["es95"] > kb["es95"] and bl["mdd"] > kb["mdd"]
        give = b["mean"] - bl["mean"]
        per = (bl["es95"] - b["es95"]) / give if give > 0 else float("nan")
        out.append(f"vs B: ES95 {100*imp_es:+.1f}%  MDD {100*imp_dd:+.1f}%   vs kB better on both: {beat}"
                   f"   ES95 gained per Rs of mean given up: {per:.2f}")
        return imp_es, imp_dd, beat, B, L

    allx = np.arange(len(D))
    h1 = np.array([i for i, d in enumerate(D) if d < SPLIT])
    h2 = np.array([i for i, d in enumerate(D) if d >= SPLIT])
    gate = {}
    for s in SLIPS:
        gate[("full", s)] = block("FULL", allx, s)
    block("FULL", allx, 0.0, lots=2)
    gate[("h1", 0.0)] = block("HALF 1 (to 2025-06-30)", h1, 0.0)
    gate[("h2", 0.0)] = block("HALF 2 (2025-07-01+)", h2, 0.0)
    for y in (2024, 2025, 2026):
        idx = np.array([i for i, d in enumerate(D) if d.year == y])
        block(f"YEAR {y}", idx, 0.0)

    # diagnostics: L on B's worst days; intraday worst MTM
    imp, dd, beat, B, L = gate[("full", 0.0)]
    order = np.argsort(B)
    n5 = max(1, math.ceil(len(B) * 0.05))
    out.append(f"\n== L on B's worst days (net, slip 0)")
    out.append(f"worst 5% ({n5} days): B mean {B[order[:n5]].mean():,.0f}  L mean {L[order[:n5]].mean():,.0f}  "
               f"L>0 on {(L[order[:n5]]>0).mean()*100:.0f}% of them")
    out.append(f"worst 10 days: B mean {B[order[:10]].mean():,.0f}  L mean {L[order[:10]].mean():,.0f}")
    out.append(f"L loses on {(L<0).mean()*100:.0f}% of all days; corr(B,L)={np.corrcoef(B,L)[0,1]:.2f}")
    wb, wbl = [], []
    for d in D:
        tot = {}
        for k, m in (("W", 2), ("D", 1), ("L", 0)):
            pts = mtm.get((d, k), {})
            tot[k] = (pts, m)
        mins = sorted(set().union(*[set(p) for p, _ in tot.values()]))
        cb = cbl = None
        last = {k: 0.0 for k in tot}
        wb_d = wbl_d = 0.0
        for mnt in mins:
            for k, (p, _) in tot.items():
                if mnt in p:
                    last[k] = p[mnt]
            bsum = 2 * last["W"] + last["D"]
            wb_d = min(wb_d, bsum)
            wbl_d = min(wbl_d, bsum + last["L"])
        wb.append(wb_d)
        wbl.append(wbl_d)
    wb, wbl = np.array(wb), np.array(wbl)
    out.append(f"intraday worst MTM (gross): B mean {wb.mean():,.0f} min {wb.min():,.0f}; "
               f"B+L mean {wbl.mean():,.0f} min {wbl.min():,.0f}; "
               f"worst-5% mean B {np.sort(wb)[:n5].mean():,.0f} vs B+L {np.sort(wbl)[:n5].mean():,.0f}")

    # verdict
    def r1(g): return g[0] >= 0.15 and g[1] >= 0.15
    ok1 = r1(gate[("full", 0.0)])
    ok2 = gate[("full", 0.0)][2]
    ok3 = all(gate[(h, 0.0)][0] > 0 and gate[(h, 0.0)][1] > 0 and gate[(h, 0.0)][2] for h in ("h1", "h2"))
    ok4 = gate[("full", 2.0)][2] and gate[("full", 2.0)][0] > 0 and gate[("full", 2.0)][1] > 0
    out.append(f"\nVERDICT rules: 1 (>=15% both) {ok1} | 2 (beats kB) {ok2} | 3 (both halves) {ok3} | 4 (slip 2%) {ok4}"
               f"  => {'PASS' if ok1 and ok2 and ok3 and ok4 else 'KILL'}")
    text = "\n".join(out)
    (HERE / "report.txt").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
