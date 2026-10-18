"""BL-129: among Adaptive's core picks, Widesl rank 1 vs rank 2, and the book with rank 1 at two lots.

As registered in backlog/BL-129 (descriptive, in-sample). Reads the live store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl129/rank_double.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, pick, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import is_wide, track_names, variant_names

HERE = Path(__file__).parent
WINDOWS = {
    "two_years": (date(2025, 1, 10), date(2026, 10, 16)),
    "last_year": (date(2025, 10, 9), date(2026, 10, 16)),
}
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261021, 0.90
BROKERAGE = 20.0 * 1.18  # per order, with GST


def read(name: str, root: Path) -> dict[date, tuple[float, int]]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                n = int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else 0
                out[date.fromisoformat(r["day"])] = (float(r["gross"]), n)
            except (KeyError, ValueError):
                continue
    return out


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "days": int(x.size),
        "mean": m,
        "ci90": [lo, hi],
        "reading": "positive" if lo > 0 else "negative" if hi < 0 else "inconclusive",
    }


def run(root: Path, names: list[str]) -> dict:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def val(n, d):
        if n not in cache:
            cache[n] = read(n, root)
        return cache[n].get(d)

    rows = []
    for d in rec.days_available():
        if not (WINDOWS["two_years"][0] <= d <= WINDOWS["two_years"][1]):
            continue
        a = rec.attrs[d]
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, daylog._number(a.get("vix_open")), dte):
            if key != "C":
                continue
            score = {n: float(comp[j]) for j, n in enumerate(cols)}
            wide = sorted((n for n in picks.core if is_wide(n)), key=lambda n: (-score[n], n))
            other = [n for n in picks.core if n not in wide[:2]]
            assert len(wide) >= 2 and len(other) == 1, (d, picks.core)
            w1, w2, x = val(wide[0], d), val(wide[1], d), val(other[0], d)
            if None in (w1, w2, x):
                continue
            book_a = w1[0] + w2[0] + x[0]
            book_b = 2 * w1[0] + x[0]
            saved = 2 * w2[1] * BROKERAGE
            rows.append({"day": d.isoformat(), "w1": wide[0], "w2": wide[1], "x": other[0],
                         "w1_gross": w1[0], "w2_gross": w2[0], "x_gross": x[0], "three_wide": len(wide) == 3,
                         "book_a": book_a, "book_b": book_b, "brokerage_saved": saved})  # fmt: skip

    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for r in rows if lo.isoformat() <= r["day"] <= hi.isoformat()]
        w1 = np.array([r["w1_gross"] for r in sub])
        w2 = np.array([r["w2_gross"] for r in sub])
        a = np.array([r["book_a"] for r in sub])
        b = np.array([r["book_b"] for r in sub])
        s = np.array([r["brokerage_saved"] for r in sub])
        out[wname] = {
            "days": len(sub),
            "three_wide_days": int(sum(r["three_wide"] for r in sub)),
            "w1_mean": float(w1.mean()), "w2_mean": float(w2.mean()), "x_mean": float(np.mean([r["x_gross"] for r in sub])),
            "w1_minus_w2": interval(w1 - w2) | {"share_w1_better": float((w1 > w2).mean())},
            "book_a_gross_per_day": float(a.mean()), "book_b_gross_per_day": float(b.mean()),
            "brokerage_saved_per_day": float(s.mean()),
            "b_minus_a_net": interval(b - a + s),
            "max_drawdown_gross": {"A": max_drawdown(a), "B": max_drawdown(b)},
            "worst_day_gross": {"A": float(a.min()), "B": float(b.min())},
        }  # fmt: skip
    return out


def main() -> None:
    root = data_dir()
    report = {
        "core_298": run(root, variant_names()),
        "t1": run(root, [*variant_names(), *track_names("t1")]),
        "note": "gross per lot from the stored results (no charges); net B-A adds only the brokerage B saves",
    }
    (HERE / "rank_double_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for u in ("core_298", "t1"):
        for w, r in report[u].items():
            d = r["w1_minus_w2"]
            n = r["b_minus_a_net"]
            print(
                f"{u:8} {w:9} days {r['days']} (3-Widesl days {r['three_wide_days']}) | W1 {r['w1_mean']:+.0f} W2 {r['w2_mean']:+.0f} X {r['x_mean']:+.0f} | W1-W2 {d['mean']:+.0f} [{d['ci90'][0]:+.0f},{d['ci90'][1]:+.0f}] {d['reading']} W1 better {d['share_w1_better']:.0%}"
            )
            print(
                f"{'':19} book A {r['book_a_gross_per_day']:+.0f}/day  B {r['book_b_gross_per_day']:+.0f}/day  brokerage saved {r['brokerage_saved_per_day']:.0f}/day | B-A net {n['mean']:+.0f} [{n['ci90'][0]:+.0f},{n['ci90'][1]:+.0f}] {n['reading']} | DD A {r['max_drawdown_gross']['A']:,.0f} B {r['max_drawdown_gross']['B']:,.0f} | worst A {r['worst_day_gross']['A']:,.0f} B {r['worst_day_gross']['B']:,.0f}"
            )


if __name__ == "__main__":
    main()
