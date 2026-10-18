"""BL-131: a daily ₹10,000 / ₹12,000 stop on each 3-lot book (Core-298 and T1).

As registered in backlog/BL-131 (descriptive, in-sample). Reads the live store only; replayed paths are
cached under research/bl131/results/ (git-ignored).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl131/book_stop.py
"""

from __future__ import annotations

import csv
import json
import pickle
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, portfolio, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
CACHE = HERE / "results" / "paths.pkl"
WINDOWS = {
    "two_years": (date(2025, 1, 10), date(2026, 10, 16)),
    "last_year": (date(2025, 10, 9), date(2026, 10, 16)),
}
LEVELS = (6_000.0, 7_000.0, 8_000.0, 9_000.0, 10_000.0, 12_000.0)  # Amendment 1 added 6k-9k
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261023, 0.90
TOL = 1.0  # rupees: a replayed path must end at the stored gross


def stored_gross(name: str, root: Path) -> dict[date, float]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                out[date.fromisoformat(r["day"])] = float(r["gross"])
            except (KeyError, ValueError):
                continue
    return out


def picks_by_day(root: Path, names: list[str]) -> dict[date, list[str]]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    lo, hi = WINDOWS["two_years"]
    return {d: rec.picks(d)["C"]["core"] for d in rec.days_available() if lo <= d <= hi}


def main() -> None:
    root = data_dir()
    books = {
        "core_298": picks_by_day(root, variant_names()),
        "t1": picks_by_day(root, [*variant_names(), *track_names("t1")]),
    }
    paths: dict[tuple[date, str], tuple[float, ...]] = {}
    if CACHE.exists():
        paths = pickle.loads(CACHE.read_bytes())
    gross_cache: dict[str, dict[date, float]] = {}
    mismatched: Counter = Counter()
    todo = sorted({(d, n) for b in books.values() for d, ps in b.items() for n in ps} - set(paths))
    loaded: dict = {}
    current = None
    for k, (d, n) in enumerate(todo):
        if d != current:
            loaded, current = {}, d
        try:
            paths[(d, n)] = portfolio._replay(root, d, n, loaded)
        except portfolio.PortfolioStopError as error:
            print("skip", d, n, error)
        if k % 200 == 0:
            print(f"replayed {k}/{len(todo)}", flush=True)
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_bytes(pickle.dumps(paths))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(pickle.dumps(paths))

    report: dict = {"levels": LEVELS, "note": "gross per book (one lot per pick); no charges"}
    days_by_book: dict[str, dict[date, dict]] = {}
    for book, by_day in books.items():
        rows = {}
        for d, ps in by_day.items():
            members = []
            ok = True
            for n in ps:
                p = paths.get((d, n))
                if n not in gross_cache:
                    gross_cache[n] = stored_gross(n, root)
                g = gross_cache[n].get(d)
                if p is None or g is None or abs(p[-1] - g) > TOL:
                    ok = False
                    break
                members.append(portfolio.Member(n, 1, p))
            if not ok:
                mismatched[book] += 1
                continue
            lots = Counter(m.name for m in members)
            members = [
                portfolio.Member(n, k, next(m.pnl for m in members if m.name == n))
                for n, k in lots.items()
            ]
            row = {"none": portfolio.apply_book(members, None).gross_with}
            for lvl in LEVELS:
                bd = portfolio.apply_book(members, lvl)
                row[int(lvl)] = bd.gross_with
                row[f"fired_{int(lvl)}"] = bd.stop_minute is not None
            rows[d] = row
        days_by_book[book] = rows

    for book, rows in days_by_book.items():
        report[book] = {"days_left_out_path_mismatch": mismatched[book]}
        for wname, (lo, hi) in WINDOWS.items():
            ds = sorted(d for d in rows if lo <= d <= hi)
            none = np.array([rows[d]["none"] for d in ds])
            w = {"days": len(ds), "none": {"per_day": float(none.mean()), "total": float(none.sum()),
                                           "max_drawdown": max_drawdown(none), "worst_day": float(none.min())}}  # fmt: skip
            for lvl in LEVELS:
                key = int(lvl)
                withs = np.array([rows[d][key] for d in ds])
                fired = np.array([rows[d][f"fired_{key}"] for d in ds])
                diff = withs - none
                m, lo90, hi90 = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
                w[str(key)] = {
                    "days_fired": int(fired.sum()),
                    "per_day": float(withs.mean()), "total": float(withs.sum()),
                    "diff_per_day": m, "ci90": [lo90, hi90], "diff_total": float(diff.sum()),
                    "cost_days": int(((diff < 0) & fired).sum()), "cost_sum": float(diff[(diff < 0) & fired].sum()),
                    "saved_days": int(((diff > 0) & fired).sum()), "saved_sum": float(diff[(diff > 0) & fired].sum()),
                    "max_drawdown": max_drawdown(withs), "worst_day": float(withs.min()),
                    "positive": bool(lo90 > 0),
                    "protective": bool(max_drawdown(withs) > max_drawdown(none) and withs.min() > none.min()),
                }  # fmt: skip
            report[book][wname] = w
    both = {}
    for wname, (lo, hi) in WINDOWS.items():
        common = sorted(set(days_by_book["core_298"]) & set(days_by_book["t1"]))
        ds = [d for d in common if lo <= d <= hi]
        out = {"days": len(ds)}
        for key in ("none", *[int(v) for v in LEVELS]):
            s = np.array(
                [days_by_book["core_298"][d][key] + days_by_book["t1"][d][key] for d in ds]
            )
            out[str(key)] = {"per_day": float(s.mean()), "total": float(s.sum()),
                             "max_drawdown": max_drawdown(s), "worst_day": float(s.min())}  # fmt: skip
        both[wname] = out
    report["both_books"] = both
    (HERE / "book_stop_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")

    for book in ("core_298", "t1"):
        print(f"== {book} (left out: {report[book]['days_left_out_path_mismatch']})")
        for wname in WINDOWS:
            w = report[book][wname]
            n = w["none"]
            print(
                f"  {wname} {w['days']}d none: {n['per_day']:+.0f}/day total {n['total']:+,.0f} DD {n['max_drawdown']:,.0f} worst {n['worst_day']:,.0f}"
            )
            for lvl in [str(int(v)) for v in LEVELS]:
                x = w[lvl]
                print(
                    f"    stop {lvl}: fired {x['days_fired']}d | {x['per_day']:+.0f}/day total {x['total']:+,.0f} | diff {x['diff_per_day']:+.0f} [{x['ci90'][0]:+.0f},{x['ci90'][1]:+.0f}] total {x['diff_total']:+,.0f} | cost {x['cost_days']}d {x['cost_sum']:+,.0f} saved {x['saved_days']}d {x['saved_sum']:+,.0f} | DD {x['max_drawdown']:,.0f} worst {x['worst_day']:,.0f}"
                )
    for wname, o in both.items():
        print(
            f"== both books {wname} {o['days']}d: "
            + " | ".join(
                f"{k}: {o[k]['per_day']:+.0f}/day total {o[k]['total']:+,.0f} DD {o[k]['max_drawdown']:,.0f} worst {o[k]['worst_day']:,.0f}"
                for k in ("none", *[str(int(v)) for v in LEVELS])
            )
        )


if __name__ == "__main__":
    main()
