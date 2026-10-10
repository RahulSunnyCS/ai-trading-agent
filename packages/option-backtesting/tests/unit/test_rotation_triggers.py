"""The nightly intraday-trigger scoring (BL-083): trigger logic on synthetic bars, the look-ahead
invariance, template construction and the event-minus-placebo summary. No lake, no engine runs."""

from __future__ import annotations

import csv

import numpy as np
import pytest

from option_backtesting.rotation import triggers as T

N_SESSIONS = 300
I = N_SESSIONS - 1  # noqa: E741 - the session under test is the last one


def flat_grid(price: float = 20000.0, span: float = 200.0) -> T.Grid:
    """300 identical sessions: every bar at `price`, each session's range exactly `span`, so the
    14-session ATR is `span` and yesterday's P / R1 / S1 are price, price + span / 2, price - span / 2."""
    c = np.full((N_SESSIONS, T.N_BARS), price)
    h, lo = c.copy(), c.copy()
    h[:, 100] += span / 2
    lo[:, 101] -= span / 2
    return T.Grid([f"d{k}" for k in range(N_SESSIONS)], c.copy(), h, lo, c)


def context(grid: T.Grid, vix_open: float = 15.0, rsi_today=None, straddle=None, r30_today=None):
    atr = T.atr14(grid)
    r30 = np.full((N_SESSIONS, T.N_BARS), 1.0)  # a median of 1.0 at every stamp
    if r30_today is not None:
        r30[I] = r30_today
    rsi5 = np.full((N_SESSIONS, 75), 50.0)
    if rsi_today is not None:
        rsi5[I] = rsi_today
    vix_close = np.full(T.N_BARS, vix_open)
    return atr, r30, rsi5, vix_close


def test_atr_is_the_mean_true_range_of_the_previous_14_sessions():
    g = flat_grid()
    atr = T.atr14(g)
    assert np.isnan(atr[13]) and atr[14] == pytest.approx(200.0) and atr[I] == pytest.approx(200.0)


def test_t1_fires_on_the_first_cross_of_a_level_with_the_trend_and_not_on_a_later_one():
    g = flat_grid()
    atr, r30, rsi5, vix = context(g)
    r1 = 20100.0  # yesterday: P = 20000, R1 = 2P - L = 20100
    g.C[I, :] = 20010.0
    g.C[I, 100:] = 20105.0  # crosses R1 at stamp 100 with trend (20105 - 20000) / 200 = 0.52
    fired = T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)
    assert fired["T1"] == (100, "R1_up")
    assert g.C[I, 99] < r1 <= g.C[I, 100]
    # the same level crossed before 10:30 is "touched": a later cross does not fire
    g.C[I, :] = 20010.0
    g.C[I, 50:60] = 20105.0
    g.C[I, 60:100] = 20010.0
    g.C[I, 100:] = 20105.0
    assert "T1" not in T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)


def test_t1_needs_the_trend_to_agree_with_the_cross():
    g = flat_grid()
    atr, r30, rsi5, vix = context(g)
    g.O[I, 0] = 20300.0  # the day opened far above: the up-cross of R1 is against the day's trend
    g.C[I, :] = 20010.0
    g.C[I, 100:] = 20105.0
    assert "T1" not in T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)


def test_t2_fires_when_vix_is_up_on_its_open_and_has_turned_down_over_30_minutes():
    g = flat_grid()
    atr, r30, rsi5, vix = context(g)
    vix[:] = 15.6
    vix[101:] = 15.35  # +2.3% on the open, -1.6% on 30 minutes earlier, first true at stamp 101
    fired = T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)
    assert fired["T2"] == (101, "")


def test_t3_needs_the_straddle_turn_and_a_quiet_range():
    g = flat_grid()
    st = np.full(T.N_BARS, 100.0)
    st[46:90] = 106.0  # up 6% on 10:00
    st[90:] = 102.0  # 3.8% below its high
    atr, r30, rsi5, vix = context(g, r30_today=np.full(T.N_BARS, 0.5))
    assert T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, st)["T3"] == (90, "")
    atr, r30, rsi5, vix = context(g, r30_today=np.full(T.N_BARS, 2.0))  # a wide range: no signal
    assert "T3" not in T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, st)


def test_t4_fires_on_a_block_that_completes_the_rsi_cross_back():
    g = flat_grid()
    rsi_today = np.full(75, 50.0)
    k = 20  # block 20 completes at stamp 4 + 5 * 20 = 104
    rsi_today[k - 1] = 72.0
    rsi_today[k] = 68.0
    atr, r30, rsi5, vix = context(g, rsi_today=rsi_today)
    assert T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)["T4"] == (104, "from_over70")
    rsi_today[:] = 50.0
    rsi_today[k - 1], rsi_today[k] = 28.0, 33.0
    atr, r30, rsi5, vix = context(g, rsi_today=rsi_today)
    assert T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)["T4"] == (104, "from_under30")


def test_a_firing_does_not_depend_on_bars_after_its_stamp():
    g = flat_grid()
    atr, r30, rsi5, vix = context(g)
    g.C[I, :] = 20010.0
    g.C[I, 100:] = 20105.0
    base = T.first_firings(g, 15.0, vix, I, atr, r30, rsi5, None)
    g2 = flat_grid()
    g2.C[I, :] = g.C[I]
    g2.C[I, 101:] = 25000.0  # the future after the firing bar changes completely
    g2.H[I, 101:] = 25000.0
    g2.L[I, 101:] = 10000.0
    again = T.first_firings(g2, 15.0, vix, I, atr, r30, rsi5, None)
    assert again["T1"] == base["T1"]


def test_wilder_rsi_is_100_on_a_pure_rise_and_0_on_a_pure_fall():
    up = T.wilder_rsi(np.arange(1.0, 40.0))
    down = T.wilder_rsi(np.arange(40.0, 1.0, -1.0))
    assert np.isnan(up[13]) and up[14] == 100.0 and up[-1] == 100.0
    assert down[-1] == pytest.approx(0.0)


def test_template_is_the_live_shape_entered_at_the_trigger_minute():
    s = T.make_strategy("NIFTY", "wide", "11:38")
    assert s.entry_time == "11:38" and s.exit_time == "15:28"
    b = T.make_strategy("SENSEX", "buy", "11:38")
    assert b.entry_time == "11:38" and b.exit_time == "15:14"
    assert all(leg.range_breakout.until == "11:48" for leg in b.legs)  # entry + 10 minutes


def _write(path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(columns)
        for r in rows:
            w.writerow([r.get(c, "") for c in columns])


def test_summary_is_event_minus_placebo_and_clusters_the_two_indices_by_day(tmp_path):
    d = T.triggers_dir(tmp_path)
    ev, sims = [], []
    for k in range(12):
        day = f"2026-09-{k + 1:02d}"
        for und in ("NIFTY", "SENSEX"):
            ev.append(dict(day=day, underlying=und, trigger="T1", entry="11:38"))
            sims.append(
                dict(
                    kind="event",
                    ref_day=day,
                    trigger="T1",
                    underlying=und,
                    day=day,
                    template="dir",
                    entry="11:38",
                    net=500 + 10 * k,
                )
            )
            for p in range(12):
                sims.append(
                    dict(
                        kind="placebo",
                        ref_day=day,
                        trigger="T1",
                        underlying=und,
                        day=f"2026-08-{p + 1:02d}",
                        template="dir",
                        entry="11:38",
                        net=100,
                    )
                )
    _write(d / "events.csv", T.EVENT_COLUMNS, ev)
    _write(d / "sims.csv", T.SIM_COLUMNS, sims)
    rows = T.summary(tmp_path)
    assert len(rows) == 1
    r = rows[0]
    assert (r["trigger"], r["template"], r["events"], r["days"]) == ("T1", "dir", 24, 12)
    assert r["placebo"] == pytest.approx(100.0)
    assert r["diff"] == pytest.approx(r["event"] - 100.0) and r["diff"] > 0
    assert r["t"] is not None and r["t"] > 3  # a steady +400 against zero spread of placebo


def test_summary_needs_ten_placebo_days_per_event(tmp_path):
    d = T.triggers_dir(tmp_path)
    _write(
        d / "events.csv",
        T.EVENT_COLUMNS,
        [dict(day="2026-09-01", underlying="NIFTY", trigger="T2", entry="11:00")],
    )
    sims = [
        dict(
            kind="event",
            ref_day="2026-09-01",
            trigger="T2",
            underlying="NIFTY",
            day="2026-09-01",
            template="wide",
            entry="11:00",
            net=50,
        )
    ]
    sims += [
        dict(
            kind="placebo",
            ref_day="2026-09-01",
            trigger="T2",
            underlying="NIFTY",
            day=f"2026-08-{p + 1:02d}",
            template="wide",
            entry="11:00",
            net=10,
        )
        for p in range(9)
    ]
    _write(d / "sims.csv", T.SIM_COLUMNS, sims)
    assert T.summary(tmp_path) == []


def test_t3_is_not_evaluated_without_252_prior_sessions():
    g = flat_grid()
    atr, r30, rsi5, vix = context(g, r30_today=np.full(T.N_BARS, 0.5))
    st = np.full(T.N_BARS, 100.0)
    st[46:90] = 106.0
    st[90:] = 102.0
    # session 100 has only 100 sessions before it: the trailing-252 median does not exist
    assert "T3" not in T.first_firings(g, 15.0, vix, 100, atr, r30, rsi5, st)


def test_a_trigger_scoring_failure_never_fails_the_nightly_update(monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting.rotation import triggers as trig
    from option_backtesting.rotation import update as upd
    from option_backtesting.rotation.cli import rotation_app

    monkeypatch.setattr(upd, "default_day", lambda: __import__("datetime").date(2026, 10, 8))
    monkeypatch.setattr(
        upd, "update_day", lambda d: {"written": 3, "already": 0, "skipped": None, "errors": []}
    )

    def boom(*a, **k):
        raise RuntimeError("lake unreadable")

    monkeypatch.setattr(trig, "score_day", boom)
    r = CliRunner().invoke(rotation_app, ["update"])
    assert r.exit_code == 0
    assert "trigger scoring skipped" in r.output and "lake unreadable" in r.output
