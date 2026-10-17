"""BL-121: the checks Phase 1 requires before any result is read.

    uv run --with pandas python research/bl121/selfcheck.py            # synthetic checks only
    uv run --with pandas python research/bl121/selfcheck.py --real     # plus real-data checks (needs out/events.csv)

Synthetic: each arm fires where it should and not where it should not. Real: (1) an independent numpy
implementation of both arms agrees with rule.detect on a sample of real days and with the scan file; (2)
truncation holds on every real event; (3) x(<= fire) does not change when later bars are removed; (4) the
long straddle's legs, re-simulated independently from the raw option bars with the engine's documented
stop and trail conventions, match the engine's entry price, exit price, exit minute and reason on a sample
of (day, entry minute) pairs.
"""

from __future__ import annotations

import argparse
import dataclasses
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from periods import UNDERLYING, assert_day
from rule import FIRST_WATCH, LAST_WATCH, MOVE, detect, opening

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))

N = 375
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILS.append(name)


def base(s0: float = 100.0, high: float = 104.0) -> list[float]:
    """Flat at s0 except a high of `high` at 09:25 (index 10), until the end."""
    x = [s0] * N
    x[10] = high
    return x


def synthetic() -> None:
    # a: 09:17 value 100, opening high 104; the straddle goes to 106 (break of H, only 6 over S0) then 111
    x = base()
    x[40] = 106.0
    for m in range(41, N):
        x[m] = 111.0
    e1, e2 = detect(x, "R1"), detect(x, "R2")
    check(
        "a: R1 fires when above H and 10 over S0 (at 110+)",
        e1 is not None and e1.fire == 41,
        str(e1),
    )
    check("a: R2 needs H + 10 = 114: not reached", e2 is None, str(e2))

    # b: 10 points over S0 but no break of H (H = 120 at 09:25)
    x = base(100.0, 120.0)
    for m in range(40, N):
        x[m] = 112.0
    check("b: 10 over S0 without breaking H does not fire R1", detect(x, "R1") is None)
    check("b: nor R2", detect(x, "R2") is None)

    # c: R2 fires at H + 10 exactly; R1 fired earlier at S0 + 10 when above H
    x = base(100.0, 104.0)
    x[30] = 110.0
    for m in range(31, 60):
        x[m] = 110.0
    for m in range(60, N):
        x[m] = 114.0
    e1, e2 = detect(x, "R1"), detect(x, "R2")
    check("c: R1 fires first (110 >= S0 + 10 and > H)", e1 is not None and e1.fire == 30, str(e1))
    check("c: R2 fires at H + 10 = 114", e2 is not None and e2.fire == 60, str(e2))

    # d: a break at 09:30 itself (index 15) is part of the opening high, not a trigger; 09:31 (16) is
    x = base(100.0, 104.0)
    x[15] = 125.0  # raises H to 125 at 09:30
    for m in range(16, N):
        x[m] = 124.0
    check(
        "d: a spike at 09:30 raises H and does not fire",
        detect(x, "R1") is None and detect(x, "R2") is None,
    )
    x = base(100.0, 104.0)
    x[16] = 112.0
    e1 = detect(x, "R1")
    check("d: a qualifying bar at 09:31 fires R1", e1 is not None and e1.fire == 16, str(e1))

    # e: nothing after 14:00 counts (index 285 is the last watch bar)
    for fire_at, fires in ((285, True), (286, False)):
        x = base()
        x[fire_at] = 130.0
        e1 = detect(x, "R1")
        check(
            f"e: qualifying bar at index {fire_at} fires={fires}",
            (e1 is not None) == fires,
            str(e1),
        )

    # f: the noted value is 09:17 (index 2): a different value at 09:16 / 09:18 does not move S0
    x = base()
    x[1], x[3] = 50.0, 200.0
    check("f: S0 is index 2 and H uses indices 2..15", opening(x) == (100.0, 200.0))

    # g: exactly H (no strict break) does not fire R1 even when S0 + 10 is met
    x = base(100.0, 112.0)  # H = 112 at 09:25, S0 = 100
    x[50] = 112.0
    check("g: equal to H is not a break for R1", detect(x, "R1") is None)
    x[51] = 112.01
    e1 = detect(x, "R1")
    check("g: just above H and over S0 + 10 fires R1", e1 is not None and e1.fire == 51, str(e1))

    # truncation
    x = base()
    for m in range(70, N):
        x[m] = 130.0
    ev = detect(x, "R1")
    check(
        "truncation: cut at the fire bar gives the same event",
        ev is not None and detect(x, "R1", upto=ev.fire) == ev,
    )
    check(
        "truncation: cut one bar earlier gives none",
        ev is not None and detect(x, "R1", upto=ev.fire - 1) is None,
    )
    check("constants as registered", (MOVE, FIRST_WATCH, LAST_WATCH) == (10.0, 16, 285))


def independent(x: np.ndarray, arm: str) -> int | None:
    """Both arms written differently (array masks): the first fire index or None."""
    s0, high = float(x[2]), float(np.max(x[2:16]))
    seg = np.asarray(x[FIRST_WATCH : LAST_WATCH + 1], dtype=float)
    mask = (seg > high) & (seg - s0 >= 10.0) if arm == "R1" else seg >= high + 10.0
    idx = np.flatnonzero(mask)
    return None if len(idx) == 0 else int(idx[0]) + FIRST_WATCH


def leg_resim(series, entry_min: int, exit_idx: int) -> dict:
    """A bought leg's life re-simulated from its bars with the engine's documented conventions:
    entry at the close of the bar ending at entry_min; SL = 25 % below entry (to the 0.05 tick); checked
    on every bar from the entry bar against the low, filled at the SL or at the open if it gapped; the
    trail [3, 2] moves the SL up 2 for every full 3 points of the highest high since entry, updated after
    the bar's check and never loosening; otherwise exit at the close of the bar ending at exit time."""
    from option_backtesting.legwise.engine import to_tick

    price = (
        series.close[entry_min - 1]
        if entry_min > 0 and series.close[entry_min - 1] is not None
        else series.open[entry_min]
    )
    sl0 = to_tick(price - price * 25.0 / 100)
    sl, best = sl0, price
    for m in range(entry_min, exit_idx):
        o, h, lo = series.open[m], series.high[m], series.low[m]
        if o is None or h is None or lo is None:
            continue
        if lo <= sl:
            return {"entry": price, "exit": o if o <= sl else sl, "reason": "SL", "exit_min": m}
        best = max(best, h)
        moved = best - price
        steps = math.floor(moved / 3.0 + 1e-9) if moved > 0 else 0
        sl = max(sl, to_tick(sl0 + steps * 2.0))
    close_prev = (
        series.close[exit_idx - 1]
        if exit_idx > 0 and series.close[exit_idx - 1] is not None
        else series.open[exit_idx]
    )
    return {"entry": price, "exit": close_prev, "reason": "EXIT_TIME", "exit_min": exit_idx}


def real() -> None:
    from early_ref import early_reference
    from long_straddle_trade import long_straddle_strategy
    from straddle_series import level, load_chain_day, rolling_straddle

    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day, minute_index

    ev = pd.read_csv(HERE / "out" / "events.csv")
    ok = ev[ev.status == "ok"]
    root = data_dir()

    # (1) independent implementation vs detect and vs the scan file; (2) truncation on every event
    mism, bad_trunc, n = 0, 0, 0
    for r in ok.sample(min(len(ok), 500), random_state=3).to_dict("records"):
        d = date.fromisoformat(r["day"])
        assert_day(UNDERLYING, d)
        x = level(rolling_straddle(load_chain_day(root, UNDERLYING, d)), start=2).x
        n += 1
        for arm in ("R1", "R2"):
            mine = detect(x, arm)
            theirs = independent(np.asarray(x), arm)
            csv = r[f"{arm.lower()}_fire"]
            csv = None if pd.isna(csv) else int(csv)
            if (mine.fire if mine else None) != theirs or theirs != csv:
                mism += 1
                print("   mismatch", arm, r["day"], mine and mine.fire, theirs, csv)
            if mine is not None:
                same = detect(x, arm, upto=mine.fire) == mine
                earlier = detect(x, arm, upto=mine.fire - 1) is None
                if not (same and earlier):
                    bad_trunc += 1
    check(
        f"independent implementation agrees (both arms) on {n} real days and with the scan",
        mism == 0,
        f"{mism} mismatches",
    )
    check("truncation holds on every real event in the sample", bad_trunc == 0, f"{bad_trunc} bad")

    # (3) series up to the fire bar unchanged when later bars are removed
    events = ok[ok.r1_fire.notna()].head(8)
    bad = 0
    for r in events.to_dict("records"):
        d = date.fromisoformat(r["day"])
        chain = load_chain_day(root, UNDERLYING, d)
        full = level(rolling_straddle(chain), start=2).x
        j = int(r["r1_fire"])
        cut = dataclasses.replace(
            chain,
            spot=[v if m <= j else None for m, v in enumerate(chain.spot)],
            close={
                k: [v if m <= j else None for m, v in enumerate(a)] for k, a in chain.close.items()
            },
            real={
                k: [b if m <= j else False for m, b in enumerate(a)] for k, a in chain.real.items()
            },
        )
        part = level(rolling_straddle(cut), start=2).x
        if any(abs(full[m] - part[m]) > 1e-9 for m in range(2, j + 1)):
            bad += 1
    check(
        f"series up to the fire bar unchanged without later bars ({len(events)} events)",
        bad == 0,
        f"{bad} bad",
    )

    # (4) the long straddle's legs, re-simulated independently, match the engine
    ref = early_reference()
    pairs = []
    rng = np.random.default_rng(7)
    for r in ok[ok.r1_fire.notna()].sample(12, random_state=5).to_dict("records"):
        pairs.append((r["day"], int(r["r1_entry"])))
    for r in ok.sample(12, random_state=6).to_dict("records"):
        pairs.append((r["day"], int(rng.integers(30, 280))))
    exit_idx = minute_index("15:14")
    legs_checked, legs_bad = 0, 0
    for day_s, entry in pairs:
        d = date.fromisoformat(day_s)
        data = load_day(root, UNDERLYING, d)
        strat = long_straddle_strategy(f"{9 + (15 + entry) // 60:02d}:{(15 + entry) % 60:02d}")
        res = simulate_day(strat, data, ref, date(2026, 10, 12))
        for t in res.trades:
            series = data.chain[t.contract]
            mine = leg_resim(series, entry, exit_idx)
            legs_checked += 1
            same = (
                abs(mine["entry"] - t.entry_price) < 1e-9
                and abs(mine["exit"] - t.exit_price) < 1e-9
                and mine["reason"] == t.exit_reason
                and mine["exit_min"] == t.exit_min
            )
            if not same:
                legs_bad += 1
                print(
                    "   leg differs",
                    day_s,
                    entry,
                    t.contract,
                    "engine",
                    t.entry_price,
                    t.exit_price,
                    t.exit_reason,
                    t.exit_min,
                    "mine",
                    mine,
                )
    check(
        f"independent leg re-simulation matches the engine on {legs_checked} legs ({len(pairs)} straddles)",
        legs_bad == 0 and legs_checked > 0,
        f"{legs_bad} differ",
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", action="store_true")
    a = ap.parse_args()
    synthetic()
    if a.real:
        real()
    print("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
