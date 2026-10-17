"""BL-120 block 2: the checks required before any block-2 P&L is computed.

    uv run --with pandas python research/bl120/selfcheck_b.py            # synthetic checks only
    uv run --with pandas python research/bl120/selfcheck_b.py --real     # plus real-data checks

Synthetic: a spike already held before 14:30 that gives back after it fires; one already given back
before 14:30 does not; a new low resets the epoch; and the Phase 0 cases that still apply. Real: an
independently written implementation (epochs from the running-minimum records, numpy) agrees with
rule.detect_b on a sample of real days; truncation holds; the series up to the fire minute does not
change when later bars are removed; the scan agrees with the earlier counts.
"""

from __future__ import annotations

import argparse
import dataclasses
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from periods import assert_day
from rule import GIVEBACK, HOLD, M_0920, M_1528, RISE, detect_b

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))

N = 375
FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not ok:
        FAILS.append(name)


def flat(v: float = 100.0) -> list[float]:
    return [v] * N


def synthetic() -> None:
    r = RISE["NIFTY"]

    # a: a spike held and given back entirely before 14:30, flat afterwards -> already in place, no fire
    x = flat()
    for m in range(100, 111):
        x[m] = 125.0
    for m in range(111, N):
        x[m] = 108.0
    check(
        "a: give-back already in place before 14:30 does not fire at 14:30", detect_b(x, r) is None
    )

    # b: rise held before 14:30 and still up at 14:30; give-back after 14:30 fires
    x = flat()
    for m in range(300, 331):
        x[m] = 125.0
    for m in range(331, N):
        x[m] = 108.0
    ev = detect_b(x, r)
    check(
        "b: held before 14:30, still up at 14:30, gives back after: fires at the give-back",
        ev is not None and ev.fire == 331 and ev.held == 304 and ev.held < 315,
        str(ev),
    )

    # c: the rise starts at 14:25 and the hold completes at 14:29, just before the check starts
    x = flat()
    for m in range(310, 320):
        x[m] = 125.0
    for m in range(320, N):
        x[m] = 108.0
    ev = detect_b(x, r)
    check(
        "c: hold completing just before 14:30 counts",
        ev is not None and ev.held == 314 and ev.fire == 320,
        str(ev),
    )

    # d: a new low after the spike resets the epoch: no later event without a new spike
    x = flat()
    for m in range(100, 111):
        x[m] = 125.0
    for m in range(111, N):
        x[m] = 95.0
    check("d: a new low resets the epoch, no event", detect_b(x, r) is None)

    # e: given back before 14:30, recovers to the high, gives back again after 14:30: fresh crossing fires
    x = flat()
    for m in range(300, 310):
        x[m] = 125.0
    for m in range(310, 320):
        x[m] = 108.0
    for m in range(320, 340):
        x[m] = 125.0
    for m in range(340, N):
        x[m] = 108.0
    ev = detect_b(x, r)
    check(
        "e: a fresh crossing after an earlier give-back fires",
        ev is not None and ev.fire == 340,
        str(ev),
    )

    # f: rise 19 never counts; hold of 4 minutes never counts
    x = flat()
    for m in range(325, 345):
        x[m] = 119.0
    for m in range(345, N):
        x[m] = 100.0
    check("f: rise 19 (< 20) is never held", detect_b(x, r) is None)
    x = flat()
    for m in range(325, 329):
        x[m] = 125.0
    for m in range(329, N):
        x[m] = 100.0
    check("f: a rise held 4 minutes does not fire", detect_b(x, r) is None)

    # g: give-back of 14 does not fire, of 15 does
    for gb, fires in ((14.0, False), (15.0, True)):
        x = flat()
        for m in range(325, 335):
            x[m] = 125.0
        for m in range(335, N):
            x[m] = 125.0 - gb
        ev = detect_b(x, r)
        check(f"g: give-back {gb:g} fires={fires}", (ev is not None) == fires, str(ev))

    # h: tradable at 15:12 (index 357), not at 15:13
    for fire_at, tradable in ((356, True), (357, False)):
        x = flat()
        for m in range(fire_at - 12, fire_at):
            x[m] = 125.0
        for m in range(fire_at, N):
            x[m] = 108.0
        ev = detect_b(x, r)
        check(
            f"h: fire at {fire_at} tradable={tradable}",
            ev is not None and ev.fire == fire_at and ev.tradable == tradable,
            str(ev),
        )

    # i: SENSEX thresholds
    x = flat(300.0)
    for m in range(325, 335):
        x[m] = 330.0
    for m in range(335, N):
        x[m] = 310.0
    check("i: SENSEX rise 30 (< 50) does not fire", detect_b(x, RISE["SENSEX"]) is None)
    x = flat(300.0)
    for m in range(325, 335):
        x[m] = 355.0
    for m in range(335, N):
        x[m] = 335.0
    ev = detect_b(x, RISE["SENSEX"])
    check(
        "i: SENSEX rise 55 held then give-back 20 fires", ev is not None and ev.fire == 335, str(ev)
    )

    # j: the low is the DAY's low since 09:20, not the 14:30 value: a morning low far below counts
    x = flat(100.0)
    x[10] = 60.0
    for m in range(11, N):
        x[m] = 100.0  # up 40 from the day's low, flat for hours
    for m in range(340, N):
        x[m] = 83.0  # gives back 17 from the epoch high (100)
    ev = detect_b(x, r)
    check(
        "j: rise is measured from the morning low",
        ev is not None and ev.fire == 340 and ev.low == 60.0,
        str(ev),
    )

    # truncation on a firing case
    x = flat()
    for m in range(300, 331):
        x[m] = 125.0
    for m in range(331, N):
        x[m] = 108.0
    ev = detect_b(x, r)
    check(
        "truncation: cut at the fire minute gives the same event",
        ev is not None and detect_b(x, r, upto=ev.fire) == ev,
    )
    check(
        "truncation: cut one minute earlier gives none",
        ev is not None and detect_b(x, r, upto=ev.fire - 1) is None,
    )
    check("constants as registered", (HOLD, GIVEBACK, M_0920, M_1528) == (5, 15.0, 5, 373))


def independent(x: np.ndarray, rise: float) -> tuple[int, int] | None:
    """Block 2's rule written differently: epochs from running-minimum records, then a scan per
    epoch. Returns (held, fire) or None."""
    seg = np.asarray(x[M_0920 : M_1528 + 1], dtype=float)
    n = len(seg)
    running_min = np.minimum.accumulate(seg)
    new_low = np.zeros(n, dtype=bool)
    new_low[0] = True
    new_low[1:] = seg[1:] < running_min[:-1]
    starts = np.flatnonzero(new_low)
    ends = np.append(starts[1:], n)
    best: tuple[int, int] | None = None
    for a, b in zip(starts, ends, strict=True):
        part = seg[a:b]
        low = part[0]
        high = np.maximum.accumulate(part)
        above = (part - low) >= rise
        run = 0
        held_i = None
        gave_prev = False
        for i in range(len(part)):
            run = run + 1 if above[i] else 0
            if held_i is None and run >= HOLD:
                held_i = i
            gave = held_i is not None and (high[i] - part[i]) >= GIVEBACK
            minute = M_0920 + a + i
            if gave and not gave_prev and minute >= 315:
                cand = (M_0920 + a + held_i, minute)
                if best is None or cand[1] < best[1]:
                    best = cand
                break
            gave_prev = gave
        # epochs are disjoint and in time order, so the first fire found is the earliest overall
        if best is not None:
            return best
    return best


def real() -> None:
    from straddle_series import level, load_chain_day, rolling_straddle

    from option_backtesting.fyers.daily import data_dir

    ev = pd.read_csv(HERE / "out" / "events_b.csv")
    ok = ev[ev.status == "ok"]
    root = data_dir()

    mism, trunc_bad, n = 0, 0, 0
    sample = pd.concat([ok[ok.fire.notna()], ok[ok.fire.isna()].sample(300, random_state=2)])
    for r in sample.itertuples(index=False):
        d = date.fromisoformat(r.day)
        assert_day(r.underlying, d)
        x = level(rolling_straddle(load_chain_day(root, r.underlying, d))).x
        mine = detect_b(x, RISE[r.underlying])
        theirs = independent(np.asarray(x), RISE[r.underlying])
        got = None if mine is None else (mine.held, mine.fire)
        n += 1
        if got != theirs:
            mism += 1
            print("   mismatch", r.underlying, r.day, got, theirs)
        fire_csv = None if pd.isna(r.fire) else int(r.fire)
        if (mine.fire if mine else None) != fire_csv:
            mism += 1
        if mine is not None:
            same = detect_b(x, RISE[r.underlying], upto=mine.fire) == mine
            earlier = detect_b(x, RISE[r.underlying], upto=mine.fire - 1) is None
            if not (same and earlier):
                trunc_bad += 1
    check(
        f"independent implementation agrees on {n} real days (all events + 300 no-event days)",
        mism == 0,
        f"{mism} mismatches",
    )
    check("truncation holds on every real event", trunc_bad == 0, f"{trunc_bad} bad")

    evs = ok[ok.fire.notna()].head(8)
    bad = 0
    for r in evs.itertuples(index=False):
        d = date.fromisoformat(r.day)
        chain = load_chain_day(root, r.underlying, d)
        full = level(rolling_straddle(chain)).x
        j = int(r.fire)
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
        part = level(rolling_straddle(cut)).x
        if any(abs(full[m] - part[m]) > 1e-9 for m in range(M_0920, j + 1)):
            bad += 1
    check(
        f"series up to the fire minute unchanged without later bars ({len(evs)} events)",
        bad == 0,
        f"{bad} bad",
    )

    tr = ok[ok.fire.notna() & (ok.tradable == 1)].groupby(["period", "underlying"]).size().to_dict()
    expect = {("P2", "NIFTY"): 9, ("P3", "NIFTY"): 27, ("P2", "SENSEX"): 18}
    check(
        "tradable counts equal the counts logged before block 2 was registered",
        tr == expect,
        f"{tr}",
    )
    pre = ok[ok.fire.notna() & (ok.held_before_1430 == 1)]
    print(
        f"   events whose hold completed before 14:30: {len(pre)} of {int(ok.fire.notna().sum())}"
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
