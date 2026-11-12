"""BL-220 Phase 2: the Friday rules R1 / R2 / R3 against R0 on Tuned Adaptive's recorded picks.

Hold-out B (BL-220 Phase 0): the T1 journal's entries for the first 20 Fridays from 2026-11-13 and every
session in the same weeks (Monday 2026-11-09 to the 20th Friday). Mon-Thu are the same under every rule,
so only Fridays move a rule's figures; the Mon-Thu days before 2026-11-13 (spent) shape every rule alike.
List C, one lot per pick, the stored results after 0.5 % slippage, brokerage ₹20 × 1.18 × 2 per trade.

    R0  every pick                      R2  Friday: nothing
    R1  Friday: drop the core pick with the lowest recorded composite, and the Buy add-on
    R3  Friday: drop every pick whose entry is 13:00 or later

Pass (each of R1-R3 against R0): net per session not more than 5 % below R0's, and the worst drawdown
(peak-to-trough of the cumulative net with the trough at most 20 sessions after the peak) at least 10 %
smaller. None passes -> killed; more than one -> the higher net is proposed.

    uv run python research/bl220/book.py              # the registered read (refuses until B is complete)
    uv run python research/bl220/book.py --dev FROM TO  # code check on spent days only; never a verdict
"""

from __future__ import annotations

import argparse
import csv
from datetime import date, timedelta

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import entries, store

FIRST_FRIDAY, N_FRIDAYS, SPENT_TO = date(2026, 11, 13), 20, date(2026, 11, 12)
BROKERAGE_PER_TRADE = 20 * 1.18 * 2
NET_FLOOR, DD_CUT, DD_WINDOW = 0.05, 0.10, 20
RULES = ("R0", "R1", "R2", "R3")


def results(name: str, root, cache: dict) -> dict[date, tuple[float, int]]:
    if name not in cache:
        with store.slipped(0.5):
            path = store.read_path(store.result_path(name, root))
        rows = {}
        if path.exists():
            with path.open() as fh:
                for r in csv.DictReader(fh):
                    rows[date.fromisoformat(r["day"])] = (float(r["net"]), int(r["n_trades"]))
        cache[name] = rows
    return cache[name]


def kept(rule: str, day: date, block: dict) -> list[str]:
    core, buy = list(block.get("core", [])), list(block.get("buy", []))
    if day.weekday() != 4 or rule == "R0":
        return core + buy
    if rule == "R2":
        return []
    if rule == "R1":
        comp = block.get("composite", {})
        lowest = min(core, key=lambda n: (comp.get(n, float("inf")), n)) if core else None
        return [n for n in core if n != lowest]
    return [n for n in core + buy if n[-4:] < "1300"]  # R3


def worst_drawdown(series: list[float]) -> float:
    total, worst, cum = 0.0, 0.0, []
    for v in series:
        total += v
        cum.append(total)
    for j, low in enumerate(cum):
        start = max(0, j - DD_WINDOW)
        peak = max([0.0 if start == 0 else cum[start - 1], *cum[start : j + 1]])
        worst = max(worst, peak - low)
    return worst


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", nargs=2, type=date.fromisoformat, metavar=("FROM", "TO"))
    args = ap.parse_args()
    root = data_dir()
    by_day = {date.fromisoformat(e["day"]): e for e in entries.read(root, "t1")}

    if args.dev:
        lo, hi = args.dev
        if hi > SPENT_TO:
            raise SystemExit(f"--dev reads spent days only (to {SPENT_TO})")
        print(
            f"DEVELOPMENT RUN on spent days {lo} -> {hi}: a code check, not hold-out B, never a verdict"
        )
    else:
        fridays = [FIRST_FRIDAY + timedelta(weeks=i) for i in range(60)]
        recorded = [f for f in fridays if f in by_day]
        if len(recorded) < N_FRIDAYS:
            raise SystemExit(
                f"hold-out B not complete: {len(recorded)} of {N_FRIDAYS} Fridays recorded"
            )
        lo, hi = FIRST_FRIDAY - timedelta(days=4), recorded[N_FRIDAYS - 1]

    days = sorted(d for d in by_day if lo <= d <= hi and d.weekday() < 5)
    cache: dict = {}
    series = {r: [] for r in RULES}
    missing = []
    for d in days:
        block = by_day[d]["lists"]["C"]
        for rule in RULES:
            total = 0.0
            for name in kept(rule, d, block):
                row = results(name, root, cache).get(d)
                if row is None:
                    missing.append((d, name))
                    continue
                total += row[0] - BROKERAGE_PER_TRADE * row[1]
            series[rule].append(total)
    if missing and not args.dev:
        raise SystemExit(
            f"results missing for {len(set(missing))} pick-days, e.g. {sorted(set(missing))[:3]}"
        )
    n_fri = sum(1 for d in days if d.weekday() == 4)
    print(
        f"sessions {len(days)} ({days[0]} -> {days[-1]}), Fridays {n_fri}, missing pick-days {len(set(missing))}"
    )
    base_net = sum(series["R0"]) / len(days)
    base_dd = worst_drawdown(series["R0"])
    print(f"R0  net/session {base_net:,.0f}  worst {DD_WINDOW}-session drawdown {base_dd:,.0f}")
    passing = []
    for rule in RULES[1:]:
        net = sum(series[rule]) / len(days)
        dd = worst_drawdown(series[rule])
        net_ok = net >= base_net - NET_FLOOR * abs(base_net)
        dd_ok = dd <= (1 - DD_CUT) * base_dd
        ok = net_ok and dd_ok
        if ok:
            passing.append((net, rule))
        print(
            f"{rule}  net/session {net:,.0f} ({'ok' if net_ok else 'below the floor'})  "
            f"drawdown {dd:,.0f} ({'ok' if dd_ok else 'not 10% smaller'})  -> {'pass' if ok else 'fail'}"
        )
    if args.dev:
        return
    print("VERDICT: " + (f"PASS, propose {max(passing)[1]}" if passing else "KILL: no rule passes"))


if __name__ == "__main__":
    main()
