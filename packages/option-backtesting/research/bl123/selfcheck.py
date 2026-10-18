"""BL-123: the checks the item's Phase 1 requires before any result is read.

    uv run --with pandas python research/bl123/selfcheck.py            # synthetic checks only
    uv run --with pandas python research/bl123/selfcheck.py --real     # plus real-data checks (needs out/events.csv)

Synthetic: a series that must fire at a known minute, and seven that must not or must fire differently.
Real: (1) truncation: the detector on the series cut at the fire minute gives the same event, cut one
minute earlier gives none; (2) an independent numpy implementation of the rule agrees with rule.detect on
every scanned day; (3) the series at minutes <= the fire minute does not change when later bars are
removed; (4) a Widesl at 12:02 on five P2 days equals the stored N_wide_1202 gross.
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
from rule import GIVEBACK, HOLD, M_1430, M_1512, M_1528, RISE, detect

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
    # a: rise to 125 at 14:40 (m=325), held 125..126 for 7 minutes, then a drop of 15 from the high
    x = flat()
    for m in range(325, 332):
        x[m] = 125.0 if m != 326 else 126.0
    for m in range(332, N):
        x[m] = 110.0
    ev = detect(x, r)
    # high 126 at 326; first minute with 126 - x >= 15 is 332 (x = 110 -> 16)
    check(
        "a: held rise then give-back fires at the drop",
        ev is not None and ev.fire == 332 and ev.entry == 333,
        str(ev),
    )
    check(
        "a: hold completes at the fifth minute",
        ev is not None and ev.held == 329,
        str(ev and ev.held),
    )

    # b: rise of 20 for only 4 minutes, then back to the low: never held
    x = flat()
    for m in range(325, 329):
        x[m] = 120.0
    check("b: rise held 4 minutes does not fire", detect(x, r) is None)

    # c: held, but the give-back is only 14
    x = flat()
    for m in range(325, 331):
        x[m] = 125.0
    for m in range(331, N):
        x[m] = 111.0
    check("c: give-back of 14 does not fire", detect(x, r) is None)

    # d: rise of 19 (< 20) held long, then a big drop
    x = flat()
    for m in range(325, 340):
        x[m] = 119.0
    for m in range(340, N):
        x[m] = 100.0
    check("d: rise 19 never counts as held", detect(x, r) is None)

    # e: the straddle falls inside the hold: the run resets, so no fire before a completed hold
    x = flat()
    x[325] = x[326] = x[327] = 125.0
    for m in range(328, N):
        x[m] = 108.0
    check("e: fall inside the hold resets it, no event", detect(x, r) is None)

    # f: a one-minute jump of +30 (a strike switch) counts as movement and can fire
    x = flat()
    for m in range(325, 335):
        x[m] = 130.0
    for m in range(335, N):
        x[m] = 112.0
    ev = detect(x, r)
    check(
        "f: a jump held 5 minutes then a give-back fires",
        ev is not None and ev.fire == 335,
        str(ev),
    )

    # g: fire at 15:12 bar (m=356) trades at 357; a fire at m=357 is not tradable
    for fire_at, tradable in ((356, True), (357, False)):
        x = flat()
        for m in range(fire_at - 8, fire_at):
            x[m] = 125.0
        for m in range(fire_at, N):
            x[m] = 108.0
        ev = detect(x, r)
        check(
            f"g: fire at {fire_at} tradable={tradable}",
            ev is not None and ev.fire == fire_at and ev.tradable == tradable,
            str(ev),
        )

    # h: a spike before 14:30 is ignored
    x = flat()
    for m in range(300, 312):
        x[m] = 130.0
    for m in range(312, N):
        x[m] = 100.0
    check("h: a rise before 14:30 is ignored", detect(x, r) is None)

    # i: SENSEX uses 50: a rise of 30 held does not fire, a rise of 55 held does
    x = flat(300.0)
    for m in range(325, 335):
        x[m] = 330.0
    for m in range(335, N):
        x[m] = 310.0
    check("i: SENSEX rise 30 (< 50) does not fire", detect(x, RISE["SENSEX"]) is None)
    x = flat(300.0)
    for m in range(325, 335):
        x[m] = 355.0
    for m in range(335, N):
        x[m] = 335.0
    ev = detect(x, RISE["SENSEX"])
    check(
        "i: SENSEX rise 55 held then give-back 20 fires", ev is not None and ev.fire == 335, str(ev)
    )

    # truncation on the synthetic firing case
    x = flat()
    for m in range(325, 332):
        x[m] = 125.0
    for m in range(332, N):
        x[m] = 108.0
    ev = detect(x, r)
    check(
        "truncation: cut at the fire minute gives the same event",
        ev is not None and detect(x, r, upto=ev.fire) == ev,
    )
    check(
        "truncation: cut one minute earlier gives none",
        ev is not None and detect(x, r, upto=ev.fire - 1) is None,
    )
    check(
        "constants as registered",
        (HOLD, GIVEBACK, M_1430, M_1512, M_1528) == (5, 15.0, 315, 357, 373),
    )


def vectorised(x: np.ndarray, rise: float) -> tuple[int, int] | None:
    """The same rule written differently (running min / max arrays, run lengths): (held, fire) or None."""
    seg = np.asarray(x[M_1430 : M_1528 + 1], dtype=float)
    low = np.minimum.accumulate(seg)
    high = np.maximum.accumulate(seg)
    above = (seg - low) >= rise
    run = np.zeros(len(seg), dtype=int)
    for i in range(len(seg)):
        run[i] = run[i - 1] + 1 if (above[i] and i > 0) else (1 if above[i] else 0)
    held_idx = np.flatnonzero(run >= HOLD)
    if len(held_idx) == 0:
        return None
    h = int(held_idx[0])
    gave = np.flatnonzero((high - seg)[h:] >= GIVEBACK)
    if len(gave) == 0:
        return None
    return h + M_1430, int(gave[0]) + h + M_1430


def real() -> None:
    from straddle_series import level, load_chain_day, rolling_straddle

    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.market import load_day

    ev = pd.read_csv(HERE / "out" / "events.csv")
    ok = ev[ev.status == "ok"]
    root = data_dir()

    # (2) independent implementation vs rule.detect on every scanned day, and (1) truncation
    mism, trunc_bad, n = 0, 0, 0
    sample = ok.sample(min(len(ok), 400), random_state=1)
    for r in sample.itertuples(index=False):
        d = date.fromisoformat(r.day)
        assert_day(r.underlying, d)
        x = level(rolling_straddle(load_chain_day(root, r.underlying, d))).x
        mine = detect(x, RISE[r.underlying])
        theirs = vectorised(np.asarray(x), RISE[r.underlying])
        got = None if mine is None else (mine.held, mine.fire)
        n += 1
        if got != theirs:
            mism += 1
        if mine is not None:
            same = detect(x, RISE[r.underlying], upto=mine.fire) == mine
            earlier = detect(x, RISE[r.underlying], upto=mine.fire - 1) is None
            if not (same and earlier):
                trunc_bad += 1
        # the scan file agrees with a fresh detection
        fire_csv = None if pd.isna(r.fire) else int(r.fire)
        if (mine.fire if mine else None) != fire_csv:
            mism += 1
    check(
        f"independent numpy rule agrees with detect and with events.csv on {n} days",
        mism == 0,
        f"{mism} mismatches",
    )
    check("truncation holds on every real event in the sample", trunc_bad == 0, f"{trunc_bad} bad")

    # (3) series at minutes <= fire does not change when later bars are removed
    evs = ok[ok.fire.notna()].head(6)
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
        if any(abs(full[m] - part[m]) > 1e-9 for m in range(M_1430, j + 1)):
            bad += 1
    check(
        f"series up to the fire minute unchanged without later bars ({len(evs)} events)",
        bad == 0,
        f"{bad} bad",
    )

    # (4) a Widesl at 12:02 equals the stored N_wide_1202 gross
    from early_ref import early_reference  # noqa: PLC0415
    from widesl_trade import run_wide, template_stop

    from option_backtesting.rotation.store import results_dir

    stored = pd.read_csv(Path(results_dir(root)) / "N_wide_1202.csv").set_index("day")
    ref = early_reference()
    days = [
        d for d in ok[(ok.underlying == "NIFTY") & (ok.period == "P2")].day if d in stored.index
    ][::30][:5]
    bad = 0
    for d in days:
        data = load_day(root, "NIFTY", date.fromisoformat(d))
        mine = run_wide(data, "NIFTY", 167, template_stop("NIFTY"), ref)  # 12:02 = minute 167
        if abs(mine["gross"] - float(stored.loc[d, "gross"])) > 0.01:
            bad += 1
            print("   ", d, "mine", mine["gross"], "stored", float(stored.loc[d, "gross"]))
    check(
        f"Widesl at 12:02 equals the stored N_wide_1202 gross ({len(days)} P2 days)",
        bad == 0 and len(days) > 0,
        f"{bad} differ",
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--real", action="store_true")
    a = ap.parse_args()
    synthetic()
    if a.real:
        sys.path.insert(0, str(HERE.parent / "common"))
        real()
    print("ALL PASS" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
