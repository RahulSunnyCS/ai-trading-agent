"""BL-134: a two-strategy book (top Widesl + Dir) against BL-133's Dir plan and 3 lots as picked.

As registered in backlog/BL-134 (descriptive, in-sample). Reads the live store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl134/two_strategy.py
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
from option_backtesting.rotation.score import runners_up
from option_backtesting.rotation.variants import is_dir, is_wide, track_names, variant_names

HERE = Path(__file__).parent
WINDOWS = {
    "two_years": (date(2025, 1, 10), date(2026, 10, 16)),
    "last_year": (date(2025, 10, 9), date(2026, 10, 16)),
}
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261026, 0.90
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
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def book_value(lots: dict[str, int], got: dict) -> tuple[float, float]:
    """(gross, brokerage): one lot's gross x lots; brokerage once per strategy placed."""
    gross = sum(k * got[n][0] for n, k in lots.items())
    brokerage = sum(2 * got[n][1] * BROKERAGE for n in lots)
    return gross, brokerage


def run(root: Path, names: list[str]) -> dict:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def val(n, d):
        if n not in cache:
            cache[n] = read(n, root)
        return cache[n].get(d)

    rows, skipped = [], 0
    lo0, hi0 = WINDOWS["two_years"]
    for d in rec.days_available():
        if not lo0 <= d <= hi0:
            continue
        a = rec.attrs[d]
        expiry = "0" in (a["dte_n"], a["dte_s"])
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, daylog._number(a.get("vix_open")), dte):
            if key != "C":
                continue
            score = {n: float(comp[j]) for j, n in enumerate(cols)}
            core = picks.core
            wide = sorted((n for n in core if is_wide(n)), key=lambda n: (-score[n], n))
            dirs = [n for n in core if is_dir(n)]
            dir_ = dirs[0] if dirs else runners_up(comp, cols, picks).get("dir")
            got = {n: val(n, d) for n in {*core, dir_} if n}
            if dir_ is None or any(v is None for v in got.values()):
                skipped += 1
                continue
            w1, rest = wide[0], wide[1:]
            if expiry:
                p = {w1: 2, dir_: 1}
                r = {n: 1 for n in core}
            else:
                p = {w1: 2, dir_: 2}
                r = {n: 1 for n in core}
                r[dir_] = (
                    r.get(dir_, 0) + 1
                )  # Dir pick doubled; on a 3-Widesl day the runner-up Dir is added
            b3 = {n: 1 for n in core}
            row = {"day": d.isoformat(), "expiry": expiry, "three_wide": not dirs, "dropped": rest}
            for name, lots in (("P", p), ("R", r), ("B3", b3)):
                g, brk = book_value(lots, got)
                row[name] = {"gross": g, "brokerage": brk, "lots": sum(lots.values())}
            rows.append(row)

    out = {"skipped_days": skipped}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for r in rows if lo.isoformat() <= r["day"] <= hi.isoformat()]
        w = {"days": len(sub), "expiry_days": int(sum(r["expiry"] for r in sub)),
             "three_wide_days": int(sum(r["three_wide"] for r in sub))}  # fmt: skip
        nets = {}
        for name in ("P", "R", "B3"):
            g = np.array([r[name]["gross"] for r in sub])
            b = np.array([r[name]["brokerage"] for r in sub])
            nets[name] = g - b
            w[name] = {
                "gross_per_day": float(g.mean()),
                "net_per_day": float((g - b).mean()),
                "brokerage_per_day": float(b.mean()),
                "max_drawdown_net": max_drawdown(g - b),
                "worst_day_net": float((g - b).min()),
            }
        diff = nets["P"] - nets["R"]
        w["P_minus_R_net"] = interval(diff)
        order = np.argsort(diff)[::-1]
        total = float(diff.sum())
        for top in (5, 10):
            w[f"P_minus_R_net_without_top_{top}"] = interval(np.delete(diff, order[:top])) | {
                "share": float(diff[order[:top]].sum() / total) if total else None
            }
        w["P_minus_B3_net"] = interval(nets["P"] - nets["B3"])
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    report = {
        "core_298": run(root, variant_names()),
        "t1": run(root, [*variant_names(), *track_names("t1")]),
        "note": "gross per one-lot result x lots, brokerage once per strategy placed; Buy add-on left out of every book",
    }
    (HERE / "two_strategy_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for book in ("core_298", "t1"):
        print(f"== {book} (skipped {report[book]['skipped_days']})")
        for wname in WINDOWS:
            w = report[book][wname]
            print(
                f"  {wname} {w['days']}d ({w['expiry_days']} expiry, {w['three_wide_days']} three-Widesl)"
            )
            for name in ("B3", "R", "P"):
                x = w[name]
                print(
                    f"    {name:2}: gross {x['gross_per_day']:+.0f} net {x['net_per_day']:+.0f}/day brokerage {x['brokerage_per_day']:.0f} | DD {x['max_drawdown_net']:,.0f} worst {x['worst_day_net']:,.0f}"
                )
            d = w["P_minus_R_net"]
            print(
                f"    P-R net {d['mean']:+.0f} [{d['ci90'][0]:+.0f},{d['ci90'][1]:+.0f}] {d['reading']} | P-B3 net {w['P_minus_B3_net']['mean']:+.0f}"
            )
            for top in (5, 10):
                c = w[f"P_minus_R_net_without_top_{top}"]
                print(
                    f"      w/o top {top}: {c['mean']:+.0f} [{c['ci90'][0]:+.0f},{c['ci90'][1]:+.0f}] share {c['share']:.0%}"
                    if c["share"] is not None
                    else ""
                )


if __name__ == "__main__":
    main()
