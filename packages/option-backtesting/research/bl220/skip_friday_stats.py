"""BL-220, descriptive (owner, 2026-11-12): each book traded as now against the same book with Fridays
skipped, the usual book statistics side by side. Not a test: the live-store window is the in-sample read S,
the NIFTY 2021-24 window is A2's data already read once (rule R2).

Books, one lot a strategy, the stored results' 0.5 % slippage copy, brokerage ₹20 × 1.18 × 2 per trade:
    T1, Core   list C as `book.py` takes them (live: the journal where recorded, re-derived before it,
               Buy add-on included; _bl214: BL-214's re-derivation, core picks only)
    Fixed base 2 × N_wide_0917 + 1 × N_dir_atm_0924 (one order a trade whatever the lots)
Skipping Friday = that day's result is 0 (nothing traded, no brokerage).

    uv run python research/bl220/skip_friday_stats.py live          # 2025-01-10 -> 2026-11-12
    TRADING_DATA_ROOT=<root>/_bl214 uv run python research/bl220/skip_friday_stats.py bl214   # 2021-11 -> 2024-10
"""

from __future__ import annotations

import csv
import math
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from book import (  # noqa: E402 - same item's scoring helpers
    BROKERAGE_PER_TRADE,
    bl214_blocks,
    insample_blocks,
    kept,
    results,
)

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import base, store  # noqa: E402
from option_backtesting.rotation.variants import track_names, variant_names  # noqa: E402

CAPITAL = 850_000.0  # Settings › Automation capital of one account
WINDOWS = {
    "live": (date(2025, 1, 10), date(2026, 11, 12)),
    "bl214": (date(2021, 11, 1), date(2024, 10, 8)),
}


def base_series(root: Path, lo: date, hi: date) -> dict[date, float]:
    cache: dict = {}
    wide = results(base.WIDE_NAME, root, cache)
    path = store.slip_path(base._path(root), 0.5)  # noqa: SLF001
    with path.open() as fh:
        dir_rows = {
            date.fromisoformat(r["day"]): (float(r["net"]), int(r["n_trades"]))
            for r in csv.DictReader(fh)
        }
    out = {}
    for d in sorted(set(wide) & set(dir_rows)):
        if lo <= d <= hi and d.weekday() < 5:
            (wn, wt), (dn, dt) = wide[d], dir_rows[d]
            out[d] = base.N_WIDE * wn + base.N_DIR * dn - BROKERAGE_PER_TRADE * (wt + dt)
    return out


def book_series(root: Path, blocks: dict[date, dict]) -> dict[date, float]:
    cache: dict = {}
    out = {}
    for d, block in sorted(blocks.items()):
        rows = [results(n, root, cache).get(d) for n in kept("R0", d, block)]
        if any(r is None for r in rows):
            continue
        out[d] = sum(net - BROKERAGE_PER_TRADE * trades for net, trades in rows)
    return out


def stats(days: list[date], x: list[float]) -> dict:
    peak, cum, worst_dd, trough, longest, run = 0.0, 0.0, 0.0, None, 0, 0
    for d, v in zip(days, x, strict=True):
        cum += v
        peak = max(peak, cum)
        if peak - cum > worst_dd:
            worst_dd, trough = peak - cum, d
        run = run + 1 if cum < peak else 0
        longest = max(longest, run)
    total = cum
    traded = [v for d, v in zip(days, x, strict=True) if not (v == 0 and d.weekday() == 4)]
    wins, losses = [v for v in traded if v > 0], [v for v in traded if v < 0]
    mean = total / len(x)
    sd = math.sqrt(sum((v - mean) ** 2 for v in x) / (len(x) - 1))
    years = len(x) / 250
    return {
        "total": total, "pct": 100 * total / CAPITAL, "per_year_pct": 100 * total / CAPITAL / years,
        "per_day": mean, "max_dd": worst_dd, "max_dd_pct": 100 * worst_dd / CAPITAL, "trough": trough,
        "longest_under": longest, "ret_dd": total / worst_dd if worst_dd else math.inf,
        "win": 100 * len(wins) / len(traded), "pf": sum(wins) / -sum(losses) if losses else math.inf,
        "avg_win": sum(wins) / len(wins), "avg_loss": sum(losses) / len(losses),
        "worst": min(x), "best": max(x), "sharpe": mean / sd * math.sqrt(250) if sd else 0.0,
        "days": len(x), "traded": len(traded),
    }  # fmt: skip


def show(title: str, series: dict[date, float]) -> None:
    days = sorted(series)
    now = [series[d] for d in days]
    skip = [0.0 if d.weekday() == 4 else series[d] for d in days]
    a, b = stats(days, now), stats(days, skip)
    fri = [series[d] for d in days if d.weekday() == 4]
    print(f"\n== {title}: {days[0]} -> {days[-1]}, {len(days)} sessions, {len(fri)} Fridays "
          f"(Friday average {sum(fri) / len(fri):,.0f}, {100 * sum(1 for v in fri if v > 0) / len(fri):.0f}% won)")  # fmt: skip
    rows = [
        ("Total net (₹)", "total", "{:,.0f}"), ("Return on ₹8.5 lakh", "pct", "{:.1f} %"),
        ("  per year", "per_year_pct", "{:.1f} %"), ("Net per session (₹)", "per_day", "{:,.0f}"),
        ("Max drawdown (₹)", "max_dd", "{:,.0f}"), ("  as % of ₹8.5 lakh", "max_dd_pct", "{:.1f} %"),
        ("  trough on", "trough", "{}"), ("Longest time under water (sessions)", "longest_under", "{}"),
        ("Return ÷ max drawdown", "ret_dd", "{:.2f}"), ("Sharpe (daily, ×√250)", "sharpe", "{:.2f}"),
        ("Win rate (days traded)", "win", "{:.0f} %"), ("Profit factor", "pf", "{:.2f}"),
        ("Average win day (₹)", "avg_win", "{:,.0f}"), ("Average loss day (₹)", "avg_loss", "{:,.0f}"),
        ("Worst day (₹)", "worst", "{:,.0f}"), ("Best day (₹)", "best", "{:,.0f}"),
        ("Days traded", "traded", "{}"),
    ]  # fmt: skip
    print(f"{'':38}{'as now':>14}{'skip Friday':>14}")
    for label, key, fmt in rows:
        print(f"{label:38}{fmt.format(a[key]):>14}{fmt.format(b[key]):>14}")


def main() -> None:
    mode = sys.argv[1]
    lo, hi = WINDOWS[mode]
    root = data_dir()
    if mode == "live":
        show("T1 (Tuned Adaptive)", book_series(root, insample_blocks(root, "t1", lo, hi)))
        show("Core (Classic Adaptive)", book_series(root, insample_blocks(root, "core", lo, hi)))
    else:
        if root.name != "_bl214":
            raise SystemExit("bl214 mode needs TRADING_DATA_ROOT=<root>/_bl214")
        core_n = [n for n in variant_names() if n.startswith("N_")]
        t1_n = [*core_n, *[n for n in track_names("t1") if n.startswith("N_")]]
        show("T1 NIFTY-only", book_series(root, bl214_blocks(root, t1_n, lo, hi)))
        show("Core NIFTY-only", book_series(root, bl214_blocks(root, core_n, lo, hi)))
    show("Fixed base", base_series(root, lo, hi))


if __name__ == "__main__":
    main()
