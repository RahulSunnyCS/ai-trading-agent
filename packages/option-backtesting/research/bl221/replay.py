"""BL-221 Phase 1-2: replay every rotation strategy-day once and keep what the Friday read needs.

Each weekday session in the store from 2024-10-09 to 2026-11-12 (BL-221 reads only these spent days;
NIFTY 2022-24 and any day from 2026-11-13 are BL-220's hold-outs and are refused here) is replayed
for Core-298 and T1's extra strategies with the nightly update's own call (`simulate_day`, the
strategy file, `SIZING_DATE`) at 0.5 % slippage, as `rotation.portfolio._replay` does. One row per
strategy-day goes to out/rows.csv.gz: the replayed net beside the stored slip-0.5 net (a mismatch is
counted, never hidden), the stored gross at 0 %, the gross P&L by session window, exits by reason,
the premium sold or bought at the first entry and its value at that leg's exit, and the day's VIX,
weekdays to expiry and opening gap.

    uv run python research/bl221/replay.py [--from D] [--to D]
"""

from __future__ import annotations

import argparse
import collections
import csv
import gzip
import re
import sys
import time
from datetime import date
from pathlib import Path

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import SIZING_DATE
from option_backtesting.rotation.portfolio import member_from_curve, strategy_file
from option_backtesting.rotation.variants import track_names, underlying_of, variant_names

FIRST, LAST = date(2024, 10, 9), date(2026, 11, 12)  # spent days only (BL-221 Phase 0)
SLIP = 0.5
OUT = Path(__file__).parent / "out"
# minute index 0 = 09:15; window ends at 10:00 and 13:00
W1, W2 = 45, 225
FAMILY = {"wide": "Widesl", "dir": "Dir ATM", "ditm1": "Dir ITM1", "buy": "Buy"}


def family(name: str) -> str:
    token = re.match(r"[NS]_([a-z]+\d*)", name).group(1)
    if token in FAMILY:
        return FAMILY[token]
    if re.fullmatch(r"p\d+", token):
        return "Widesl"  # closest-premium Widesl, counted under Widesl (owner, 2026-11-12)
    raise SystemExit(f"unknown family token {token!r} in {name}")


def regime(day: date) -> str:
    """R-a: 2024-10-09 -> 2025-01-03 (Fridays were SENSEX expiry days; analyse.py leaves it out);
    R-b: Jan-Aug 2025; R-c: Sep 2025 on. analyse.py prints them by their dates."""
    if day <= date(2025, 1, 3):
        return "R-a"
    return "R-b" if day <= date(2025, 8, 31) else "R-c"


def stored(name: str, root: Path) -> tuple[dict[date, float], dict[date, float]]:
    with store.slipped(SLIP):
        slipped = store.read_net(name, root)
    gross = {}
    path = store.result_path(name, root)
    if path.exists():
        with path.open() as f:
            gross = {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}
    return slipped, gross


def last_close(series) -> float | None:
    for value in reversed(series.close):
        if value is not None:
            return value
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=date.fromisoformat, default=FIRST)
    ap.add_argument("--to", dest="end", type=date.fromisoformat, default=LAST)
    args = ap.parse_args()
    if args.start < FIRST or args.end > LAST:
        sys.exit(f"BL-221 reads only {FIRST} to {LAST}: other days are BL-220's hold-outs")

    root = data_dir()
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    names = [(n, "core") for n in sorted(variant_names())] + [
        (n, "t1") for n in sorted(track_names("t1"))
    ]
    specs = {}
    for name, _ in names:
        spec = load_legwise(strategy_file(name))
        specs[name] = spec.model_copy(
            update={"execution": spec.execution.model_copy(update={"slippage_pct": SLIP})}
        )
    stores = {name: stored(name, root) for name, _ in names}
    days = sorted(
        d for d in store.read_days(root) if args.start <= d <= args.end and d.weekday() < 5
    )

    OUT.mkdir(exist_ok=True)
    out = OUT / f"rows_{args.start}_{args.end}.csv.gz"
    cols = [
        "day",
        "weekday",
        "regime",
        "universe",
        "variant",
        "index",
        "family",
        "entry",
        "dte_n",
        "dte_s",
        "vix_open",
        "gap_pct",
        "net",
        "stored_net",
        "stored_gross",
        "gross",
        "costs",
        "n_trades",
        "w_0915_1000",
        "w_1000_1300",
        "w_1300_close",
        "worst_mtm",
        "best_mtm",
        "stopped_by",
        "first_premium",
        "first_premium_exit",
        "exits",
    ]
    attrs = store.read_days(root)
    prev_close: dict[str, float | None] = {}
    mismatches = skipped = 0
    started = time.time()
    with gzip.open(out, "wt", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(cols)
        for n_day, day in enumerate(days, 1):
            loaded, gap = {}, {}
            for und in ("NIFTY", "SENSEX"):
                try:
                    loaded[und] = load_day(root, und, day)
                except FileNotFoundError:
                    continue
                spot = loaded[und].spot
                first = next((v for v in spot.open if v is not None), None)
                before = prev_close.get(und)
                gap[und] = round((first / before - 1) * 100, 3) if first and before else ""
                prev_close[und] = last_close(spot)
            a = attrs[day]
            for name, universe in names:
                und = underlying_of(name)
                net_store, gross_store = stores[name]
                if und not in loaded or day not in net_store:
                    skipped += 1
                    continue
                result = simulate_day(specs[name], loaded[und], ref, sizing)
                path = member_from_curve(name, 1, result.mtm, result.gross).pnl
                if abs(result.net - net_store[day]) > 1.0:
                    mismatches += 1
                exits = collections.Counter(t.exit_reason for t in result.trades)
                start = min((x.entry_min for x in result.trades), default=None)
                first_trades = [t for t in result.trades if t.entry_min == start]
                prem = sum(t.entry_price for t in first_trades)
                prem_exit = sum(t.exit_price for t in first_trades if t.exit_price is not None)
                writer.writerow(
                    [
                        day,
                        day.strftime("%a"),
                        regime(day),
                        universe,
                        name,
                        und,
                        family(name),
                        name[-4:],
                        a.get("dte_n", ""),
                        a.get("dte_s", ""),
                        a.get("vix_open", ""),
                        gap.get(und, ""),
                        round(result.net, 2),
                        net_store[day],
                        gross_store.get(day, ""),
                        round(result.gross, 2),
                        round(result.costs, 2),
                        len(result.trades),
                        round(path[W1], 2),
                        round(path[W2] - path[W1], 2),
                        round(result.gross - path[W2], 2),
                        round(result.worst_mtm, 2),
                        round(result.best_mtm, 2),
                        result.stopped_by or "",
                        round(prem, 2),
                        round(prem_exit, 2),
                        ";".join(f"{k}:{v}" for k, v in sorted(exits.items())),
                    ]
                )
            if n_day % 25 == 0:
                print(
                    f"{n_day}/{len(days)} days, {time.time() - started:.0f}s, mismatches {mismatches}",
                    flush=True,
                )
    print(
        f"done: {len(days)} days -> {out}; mismatches {mismatches}, skipped {skipped}, {time.time() - started:.0f}s"
    )


if __name__ == "__main__":
    main()
