"""BL-220 Phase 2 and Amendment 1: the Friday rules R1 / R2 / R3 against R0 on Adaptive's picks.

    R0  every pick                      R2  Friday: nothing
    R1  Friday: drop the core pick with the lowest list C composite, and the Buy add-on
    R3  Friday: drop every pick whose entry is 13:00 or later

One lot a pick, the stored results' 0.5 % slippage copy, brokerage ₹20 × 1.18 × 2 per trade. A rule passes
(against R0) if its net per session is not more than 5 % below R0's and its worst drawdown (peak-to-trough
of the cumulative net, the trough at most 20 sessions after the peak) is at least 10 % smaller.

Modes (BL-220 Phase 0 and Amendment 1):
    b         hold-out B, the verdict: T1's journal, the first 20 Fridays from 2026-11-13 and the sessions of
              those weeks (Monday 2026-11-09 on); refuses until all 20 are recorded with every result
    a2        Amendment 1, registered: BL-214's NIFTY-only books 2021-11-01 -> 2024-10-08, list C re-derived
              as BL-214's score.py does, core picks only; run with TRADING_DATA_ROOT=<root>/_bl214
    insample  Amendment 1, descriptive only: the live store, 2024-11-12 -> 2026-11-12, picks as the Rotation
              page's Day by day takes them; no pass / fail printed
    dev       a code check on spent days of T1's journal; no verdict

    uv run python research/bl220/book.py b | a2 | insample | dev FROM TO
"""

from __future__ import annotations

import argparse
import csv
from bisect import bisect_left
from datetime import date, timedelta
from pathlib import Path

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, entries, expiry, pick, sl150_cap, store
from option_backtesting.rotation.variants import track_names, variant_names

FIRST_FRIDAY, N_FRIDAYS, SPENT_TO = date(2026, 11, 13), 20, date(2026, 11, 12)
A2_FROM, A2_TO = date(2021, 11, 1), date(2024, 10, 8)
S_FROM, S_TO = date(2024, 11, 12), date(2026, 11, 12)
BROKERAGE_PER_TRADE = 20 * 1.18 * 2
NET_FLOOR, DD_CUT, DD_WINDOW = 0.05, 0.10, 20
RULES = ("R0", "R1", "R2", "R3")


# --- picks: {day: {"core": [...], "buy": [...], "composite": {name: value}}} -------------------------


def journal_blocks(root: Path, track: str | None, lo: date, hi: date) -> dict[date, dict]:
    out = {}
    for e in entries.read(root, track):
        d = date.fromisoformat(e["day"])
        if lo <= d <= hi and d.weekday() < 5 and e.get("before_first_entry", False):
            out[d] = e["lists"]["C"]
    return out


def bl214_blocks(root: Path, names: list[str], lo: date, hi: date) -> dict[date, dict]:
    """List C core picks re-derived as research/bl214/score.py `book_picks` does, with composites."""
    daylog._recon_cache.clear()  # noqa: SLF001
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    out = {}
    for d in rec.days_available():
        if not lo <= d <= hi or d.weekday() >= 5:
            continue
        a = rec.attrs[d]
        i = bisect_left(rec.days, d)
        hist = pick.History(
            rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
            rec.dte_n[:i], rec.dte_s[:i], "",
        )  # fmt: skip
        vix = daylog._number(a.get("vix_open"))  # noqa: SLF001
        for key, cols, comp, picks in pick._rank(  # noqa: SLF001
            hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        ):
            if key != "C":
                continue
            idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(str(a["dte_n"])) and str(a["dte_n"]) != "0":  # noqa: SLF001
                picks = sl150_cap.cap_picks(comp, cols, picks)
            at = {c: k for k, c in enumerate(cols)}
            core = list(picks.core)
            out[d] = {"core": core, "buy": [], "composite": {n: float(comp[at[n]]) for n in core}}
    return out


def insample_blocks(root: Path, book: str, lo: date, hi: date) -> dict[date, dict]:
    """The journal where recorded, re-derived before it (the rule of `candles.picks_by_day`)."""
    track = "t1" if book == "t1" else None
    recorded = journal_blocks(root, track, lo, hi)
    first = min(recorded) if recorded else None
    pool = variant_names() + (track_names("t1") if book == "t1" else [])
    rec = daylog.reconstruction(root, pool)
    out = {}
    for d in rec.days_available():
        if lo <= d <= hi and d.weekday() < 5 and (first is None or d < first):
            c = (rec.picks(d) or {}).get("C")
            if c:
                out[d] = c
    out.update(recorded)
    return out


# --- scoring ------------------------------------------------------------------------------------------


def results(name: str, root: Path, cache: dict) -> dict[date, tuple[float, int]]:
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
    core, buy = list(block.get("core", [])), list(block.get("buy") or [])
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
        start = max(0, j - DD_WINDOW + 1)
        peak = max([0.0 if start == 0 else cum[start - 1], *cum[start : j + 1]])
        worst = max(worst, peak - low)
    return worst


def score(title: str, blocks: dict[date, dict], root: Path, judge: bool, strict: bool) -> list[str]:
    cache: dict = {}
    days, series, left_out = [], {r: [] for r in RULES}, []
    for d in sorted(blocks):
        names = set(kept("R0", d, blocks[d]))
        rows = {n: results(n, root, cache).get(d) for n in names}
        if any(v is None for v in rows.values()):
            left_out.append(d)
            continue
        days.append(d)
        for rule in RULES:
            series[rule].append(
                sum(rows[n][0] - BROKERAGE_PER_TRADE * rows[n][1] for n in kept(rule, d, blocks[d]))
            )
    if strict and left_out:
        raise SystemExit(
            f"{title}: results missing on {len(left_out)} sessions, e.g. {left_out[:3]}"
        )
    fri = [i for i, d in enumerate(days) if d.weekday() == 4]
    print(f"\n== {title}: {len(days)} sessions ({days[0]} -> {days[-1]}), Fridays {len(fri)}, "
          f"sessions left out (a pick without a result) {len(left_out)}")  # fmt: skip
    base_net, base_dd = sum(series["R0"]) / len(days), worst_drawdown(series["R0"])
    passing = []
    for rule in RULES:
        x = series[rule]
        net, dd = sum(x) / len(x), worst_drawdown(x)
        fri_mean = sum(x[i] for i in fri) / len(fri) if fri else float("nan")
        line = (f"{rule}  net/session {net:,.0f}  total {sum(x):,.0f}  Friday mean {fri_mean:,.0f}  "
                f"worst {DD_WINDOW}-session drawdown {dd:,.0f}")  # fmt: skip
        if rule != "R0" and judge:
            net_ok = net >= base_net - NET_FLOOR * abs(base_net)
            dd_ok = dd <= (1 - DD_CUT) * base_dd
            line += (f"  | net {'ok' if net_ok else 'below the floor'}, "
                     f"drawdown {'ok' if dd_ok else 'not 10% smaller'} -> {'PASS' if net_ok and dd_ok else 'fail'}")  # fmt: skip
            if net_ok and dd_ok:
                passing.append((net, rule))
        print(line)
    return [r for _, r in sorted(passing, reverse=True)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["b", "a2", "insample", "dev"])
    ap.add_argument("dates", nargs="*", type=date.fromisoformat)
    args = ap.parse_args()
    root = data_dir()

    if args.mode == "dev":
        lo, hi = args.dates
        if hi > SPENT_TO:
            raise SystemExit(f"dev reads spent days only (to {SPENT_TO})")
        score(
            f"DEV (spent {lo} -> {hi}, no verdict)",
            journal_blocks(root, "t1", lo, hi),
            root,
            False,
            False,
        )
    elif args.mode == "b":
        blocks = journal_blocks(root, "t1", FIRST_FRIDAY - timedelta(days=4), date(2099, 1, 1))
        fridays = sorted(d for d in blocks if d.weekday() == 4 and d >= FIRST_FRIDAY)
        if len(fridays) < N_FRIDAYS:
            raise SystemExit(
                f"hold-out B not complete: {len(fridays)} of {N_FRIDAYS} Fridays recorded"
            )
        blocks = {d: b for d, b in blocks.items() if d <= fridays[N_FRIDAYS - 1]}
        passing = score("HOLD-OUT B, T1 (the verdict)", blocks, root, True, True)
        print("VERDICT: " + (f"PASS, propose {passing[0]}" if passing else "KILL: no rule passes"))
    elif args.mode == "a2":
        if root.name != "_bl214":
            raise SystemExit("a2 reads BL-214's store: run with TRADING_DATA_ROOT=<root>/_bl214")
        core_n = [n for n in variant_names() if n.startswith("N_")]
        t1_n = [*core_n, *[n for n in track_names("t1") if n.startswith("N_")]]
        passing = score(
            "A2, T1 NIFTY-only (registered)",
            bl214_blocks(root, t1_n, A2_FROM, A2_TO),
            root,
            True,
            False,
        )
        print("A2 T1: " + (f"passing {', '.join(passing)}" if passing else "no rule passes"))
        score(
            "A2, Core NIFTY-only (reported beside)",
            bl214_blocks(root, core_n, A2_FROM, A2_TO),
            root,
            True,
            False,
        )
    else:
        if root.name == "_bl214":
            raise SystemExit("insample reads the live store")
        for book in ("t1", "core"):
            title = f"IN-SAMPLE {book.upper()} (descriptive, no verdict)"
            score(title, insample_blocks(root, book, S_FROM, S_TO), root, False, False)


if __name__ == "__main__":
    main()
