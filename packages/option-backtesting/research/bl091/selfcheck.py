"""BL-091 Phase 1: the checks that must pass before the census runs. Exits non-zero on any failure.

    uv run --with pandas python research/bl091/selfcheck.py

1-6 synthetic (episodes, the level series across a switch and over gaps, stale flag), 7 truncation on real P2/P3 days, 8 the 1-minute
rolling series against derived.straddle_series_5m at window closes, 9 the R0 template at 11:32 with
its own ₹2,500 stop reproduces the stored N_/S_wide_1132 results, 10 the period guard, 11 the R0
ladder on a synthetic day.
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq
from episodes import scan_episodes
from periods import SIZING, ForbiddenDay, assert_learning_day, learning_days
from r0 import ladder, wide_strategy
from series import (
    FRESH_MINUTES,
    ChainDay,
    _ffill,
    level,
    load_chain_day,
    rolling_straddle,
    splice,
    stale_mask,
)
from trading_data import derived

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import N_MINUTES, DayData, Series, _minutes, load_day
from option_backtesting.rotation.store import read_net

HERE = Path(__file__).parent
FAILS: list[str] = []
D0, EXP0 = date(2025, 3, 3), date(2025, 3, 6)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}")
    if not ok:
        FAILS.append(name)


def early_reference():
    sys.path.insert(0, str(HERE.parent / "common"))
    from early_ref import early_reference as er

    return er()


def ramp(points: list[tuple[int, float]]) -> list[float]:
    """Piecewise-linear x over 0..374 through (minute, value) points, flat before and after."""
    x = [points[0][1]] * N_MINUTES
    for (m0, v0), (m1, v1) in zip(points, points[1:], strict=False):
        for m in range(m0, m1 + 1):
            x[m] = v0 + (v1 - v0) * (m - m0) / (m1 - m0)
    for m in range(points[-1][0], N_MINUTES):
        x[m] = points[-1][1]
    return x


def synth_chain(spot: list[float], pairs: dict[float, tuple[list, list, list, list]]) -> ChainDay:
    """pairs: strike -> (ce closes, pe closes, ce real, pe real)."""
    close, real = {}, {}
    for k, (ce, pe, rc, rp) in pairs.items():
        close[(k, "CE")], close[(k, "PE")] = ce, pe
        real[(k, "CE")], real[(k, "PE")] = rc, rp
    return ChainDay(D0, "NIFTY", EXP0, 50.0, spot, close, real)


def synthetic() -> None:
    flat = [0.0] * N_MINUTES
    check("1 flat -> 0 episodes", scan_episodes(flat) == [])

    eps = scan_episodes(ramp([(5, 0), (35, 30)]))
    ok = len(eps) == 1 and eps[0].trigger_min == 30 and eps[0].high_x - eps[0].low_x == 30
    check("2 ramp 30 -> 1 episode", ok and eps[0].outcome == "no_pause", str(eps[:1]))

    spot = [24020.0 if m < 21 else 24030.0 for m in range(N_MINUTES)]
    s_old = [100 + max(0, min(m, 20) - 5) for m in range(N_MINUTES)]  # 100 -> 115 by 09:35
    s_new = [115 + max(0, min(m, 35) - 20) for m in range(N_MINUTES)]  # 116 at the switch -> 130
    t = [True] * N_MINUTES

    def halves(s):
        return [None if v is None else v / 2 for v in s]

    ch = synth_chain(spot, {24000.0: (halves(s_old), halves(s_old), t, t),
                            24050.0: (halves(s_new), halves(s_new), t, t)})  # fmt: skip
    r = rolling_straddle(ch)
    lv = level(r)
    eps = scan_episodes(lv.x)
    sp = splice(r, ch)
    ok = (len(eps) == 1 and abs(eps[0].high_x - eps[0].low_x - 30) < 1e-9 and sum(lv.switch) == 1
          and lv.x[21] == 116 and abs(sp.x[35] - 30) < 1e-9)  # fmt: skip
    check("3 level follows the rolling pair across a switch", ok,
          f"rise={eps[0].high_x - eps[0].low_x if eps else None}")  # fmt: skip

    gap = [None if 15 <= m <= 18 else v for m, v in enumerate(s_old)]
    ch = synth_chain(spot, {24000.0: (halves(gap), halves(gap), t, t),
                            24050.0: (halves(s_new), halves(s_new), t, t)})  # fmt: skip
    r = rolling_straddle(ch)
    lv = level(r)
    eps = scan_episodes(lv.x)
    ok = (sum(lv.missing) == 4 and lv.x[16] == lv.x[14] and len(eps) == 1
          and abs(eps[0].high_x - eps[0].low_x - 30) < 1e-9)  # fmt: skip
    check(
        "4 unpriced minutes hold the last value and are flagged", ok, f"missing={sum(lv.missing)}"
    )

    spot = [24000.0] * N_MINUTES
    ce_flat = [50.0] * N_MINUTES
    pe_flat = [50.0] * N_MINUTES
    sparse = [m % 4 == 0 for m in range(N_MINUTES)]  # PE trades every 4th minute
    ch = synth_chain(spot, {24000.0: (ce_flat, pe_flat, t, sparse)})
    r = rolling_straddle(ch)
    sp = level(r)
    st = stale_mask(r.pair_real)
    ok_a = scan_episodes(sp.x) == [] and sum(st) > 0 and not any(sp.missing)
    ce_up = [50.0 + max(0, min(m, 35) - 5) for m in range(N_MINUTES)]
    ch = synth_chain(spot, {24000.0: (ce_up, pe_flat, t, sparse)})
    r = rolling_straddle(ch)
    sp = level(r)
    st = stale_mask(r.pair_real)
    eps = scan_episodes(sp.x)
    ok_b = len(eps) == 1 and sum(st[m] for m in range(eps[0].start_min, eps[0].end_min + 1)) > 0
    check("5 sparse trading is flagged stale, still priced, never invents a rise", ok_a and ok_b)

    # the expiry-day artifact: the ATM switches onto a strike whose last real trade is hours old
    spot = [24000.0 if m < 50 else 24060.0 for m in range(N_MINUTES)]
    old_real = [m <= 20 for m in range(N_MINUTES)]
    pairs = {24000.0: ([20.0] * N_MINUTES, [20.0] * N_MINUTES, t, t),
             24050.0: ([50.0] * N_MINUTES, [50.0] * N_MINUTES, old_real, old_real)}  # fmt: skip
    close, real = {}, {}
    for k, (ce, pe, rc, rp) in pairs.items():
        for kind, vals, rr in (("CE", ce, rc), ("PE", pe, rp)):
            raw = [v if rr[m] else None for m, v in enumerate(vals)]
            close[(k, kind)] = _ffill(raw, FRESH_MINUTES)
            real[(k, kind)] = rr
    ch = ChainDay(D0, "NIFTY", EXP0, 50.0, spot, close, real)
    r = rolling_straddle(ch)
    sp = level(r)
    ok = scan_episodes(sp.x) == [] and sp.x[60] == 40.0 and sp.missing[60]
    check("5b a stale price on the new ATM pair does not make a spike", ok, f"x60={sp.x[60]}")

    eps = scan_episodes(ramp([(5, 0), (45, 40), (65, 20), (95, 50)]))
    ok_a = (len(eps) == 1 and eps[0].n_pauses == 1 and eps[0].outcome == "resumed_open"
            and abs(eps[0].high_x - 50) < 1e-9)  # fmt: skip
    eps = scan_episodes(ramp([(5, 0), (45, 40), (75, 10), (100, 35)]))
    ok_b = (len(eps) == 2 and eps[0].outcome == "decayed" and eps[0].end_reason == "new_episode"
            and eps[1].start_min == 75 and abs(eps[1].low_x - 10) < 1e-9)  # fmt: skip
    check(
        "6 pause/resume and decay/new episode",
        ok_a and ok_b,
        str([(e.outcome, e.start_min) for e in eps]),
    )


def sample_days(root: Path) -> list[tuple[str, date]]:
    out: list[tuple[str, date]] = []
    for und, period, n in (("NIFTY", "P2", 10), ("SENSEX", "P2", 5), ("NIFTY", "P3", 5)):
        days, _ = learning_days(root, und, period)
        days = [d for d in days if d.weekday() < 5]
        stride = max(1, len(days) // n)
        out += [(und, d) for d in days[::stride][:n]]
    return out


def truncation(root: Path) -> None:
    bad = []
    for und, day in sample_days(root):
        ch = load_chain_day(root, und, day)
        r = rolling_straddle(ch)
        sp = level(r)
        full = scan_episodes(sp.x)
        for T in (120, 200, 300, 373):
            cut = ChainDay(ch.day, ch.underlying, ch.expiry, ch.step,
                           ch.spot[: T + 1] + [ch.spot[T]] * (N_MINUTES - T - 1),
                           {k: v[: T + 1] + [v[T]] * (N_MINUTES - T - 1) for k, v in ch.close.items()},
                           ch.real)  # fmt: skip
            sp_cut = level(rolling_straddle(cut))
            if sp_cut.x[: T + 1] != sp.x[: T + 1]:
                bad.append((und, day, T, "series"))
            part = scan_episodes(sp.x, end=T)
            a = [(e.start_min, e.low_x, e.trigger_min, e.rise_at_trigger) for e in part]
            b = [
                (e.start_min, e.low_x, e.trigger_min, e.rise_at_trigger)
                for e in full
                if e.trigger_min <= T
            ]
            if a != b:
                bad.append((und, day, T, "episodes"))
    check("7 truncation: nothing depends on later bars", not bad, str(bad[:5]))


def derived_cross(root: Path) -> None:
    rows = mism_atm = mism_s = 0
    shown = 0
    days = [(u, d) for u, d in sample_days(root) if d >= date(2024, 10, 9)]
    for und, day in days:
        path = derived.derived_path(root, "straddle_series_5m", und, day)
        if not path.exists():
            print(f"   no derived file {und} {day}")
            continue
        ch = load_chain_day(root, und, day)
        r = rolling_straddle(ch)
        t = pq.read_table(path, columns=["bucket", "expiry", "atm", "straddle"])
        mins = _minutes(t.rename_columns(["ts", "expiry", "atm", "straddle"]))
        exps, atms, sts = (t.column(c).to_pylist() for c in ("expiry", "atm", "straddle"))
        for w0, e, a, s in zip(mins, exps, atms, sts, strict=True):
            if e != ch.expiry:
                continue
            m = w0 + 4
            if not 0 <= m < N_MINUTES or ch.spot[m] is None:
                continue
            rows += 1
            if r.atm[m] != a:
                mism_atm += 1
                if shown < 10:
                    shown += 1
                    print(f"   atm {und} {day} m={m} ours={r.atm[m]} derived={a}")
            if s is not None and r.s[m] is not None and abs(r.s[m] - s) > 0.01:
                mism_s += 1
                if shown < 10:
                    shown += 1
                    print(f"   straddle {und} {day} m={m} ours={r.s[m]} derived={s}")
    n_days = len(days)
    ok = n_days >= 15 and rows > 0 and mism_atm == 0 and mism_s <= 0.01 * rows
    check(
        "8 matches derived.straddle_series_5m at window closes",
        ok,
        f"{n_days} days, {rows} windows, atm mismatches {mism_atm}, straddle mismatches {mism_s}",
    )


def reproduce_1132(root: Path) -> None:
    ref = early_reference()
    bad, n = [], 0
    for und, name in (("NIFTY", "N_wide_1132"), ("SENSEX", "S_wide_1132")):
        stored = read_net(name, root)
        days = [d for d in sorted(stored) if date(2025, 3, 3) <= d <= date(2025, 3, 28)][:12]
        for d in days:
            assert_learning_day(und, d)
            data = load_day(root, und, d)
            res = simulate_day(wide_strategy(und, "11:32", 2500.0), data, ref, SIZING)
            n += 1
            if abs((res.gross - res.costs) - stored[d]) > 0.01:
                bad.append((und, d, round(res.gross - res.costs, 2), stored[d]))
    check(
        "9 R0 template at 11:32 reproduces stored results",
        n >= 24 and not bad,
        f"{n} days, differ {bad[:4]}",
    )


def guard() -> None:
    refused = [("NIFTY", date(2025, 12, 3)), ("NIFTY", date(2025, 9, 1)), ("NIFTY", date(2025, 8, 30)),
               ("NIFTY", date(2022, 4, 4)), ("SENSEX", date(2023, 8, 1)), ("NIFTY", date(2026, 10, 8))]  # fmt: skip
    allowed = [
        ("NIFTY", date(2024, 10, 8)),
        ("NIFTY", date(2025, 8, 29)),
        ("SENSEX", date(2025, 1, 10)),
    ]
    ok = True
    for u, d in refused:
        try:
            assert_learning_day(u, d)
            ok = False
            print(f"   not refused: {u} {d}")
        except ForbiddenDay:
            pass
    for u, d in allowed:
        try:
            assert_learning_day(u, d)
        except ForbiddenDay:
            ok = False
            print(f"   refused: {u} {d}")
    try:
        load_chain_day(Path("/nonexistent"), "NIFTY", date(2026, 1, 5))
        ok = False
    except ForbiddenDay:
        pass
    check("10 period guard", ok)


def _series(values: list[float]) -> Series:
    return Series(list(values), list(values), list(values), list(values))


def synthetic_r0() -> None:
    ref = early_reference()
    e = 100  # entry minute 10:55
    ce = [50.0] * N_MINUTES
    pe = [50.0] * N_MINUTES
    for m in range(e, N_MINUTES):
        ce[m] = pe[m] = 56.0
    chain = {(EXP0, 24050.0, "CE"): _series(ce), (EXP0, 23950.0, "PE"): _series(pe)}
    data = DayData(D0, "NIFTY", _series([24000.0] * N_MINUTES), chain, [EXP0], None)
    rows = ladder(data, "NIFTY", e - 1, ref)
    ok = (len(rows) >= 2 and rows[0]["outcome"] == "OVERALL_SL" and rows[0]["exit_min"] == e
          and abs(rows[0]["net0"] + 780) < 0.01 and rows[1]["entry_min"] == e + 1
          and rows[1]["ce_entry_price"] == 56.0 and rows[1]["outcome"] == "HELD")  # fmt: skip
    flat = {
        (EXP0, 24050.0, "CE"): _series([50.0] * N_MINUTES),
        (EXP0, 23950.0, "PE"): _series([50.0] * N_MINUTES),
    }
    rows_flat = ladder(
        DayData(D0, "NIFTY", _series([24000.0] * N_MINUTES), flat, [EXP0], None),
        "NIFTY",
        e - 1,
        ref,
    )
    ok_flat = (
        len(rows_flat) == 1 and rows_flat[0]["outcome"] == "HELD" and rows_flat[0]["n_orders"] == 4
    )
    check(
        "11 R0 ladder on a synthetic day",
        ok and ok_flat,
        str([(r["attempt"], r["outcome"], r["net0"], r["entry"]) for r in rows]),
    )


def main() -> int:
    root = data_dir()
    synthetic()
    guard()
    synthetic_r0()
    truncation(root)
    derived_cross(root)
    reproduce_1132(root)
    print(f"{'ALL PASS' if not FAILS else 'FAILED: ' + ', '.join(FAILS)}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
