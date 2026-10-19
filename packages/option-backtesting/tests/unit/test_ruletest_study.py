"""The event-study arithmetic of the rule tester (BL-120), on a fake lookup of simulated rows."""

from __future__ import annotations

import numpy as np
import pytest

from option_backtesting.ruletest import study


def days(n, start=1):
    return [
        f"2026-01-{k:02d}" if k <= 28 else f"2026-02-{k - 28:02d}" for k in range(start, start + n)
    ]


def test_placebo_days_are_the_nearest_ten_each_side_without_events():
    ds = days(40)
    event_days = {ds[20], ds[19], ds[22]}
    got = study.placebo_days(ds[20], ds, event_days)
    assert len(got) == 20 and ds[20] not in got and not (set(got) & event_days)
    assert got[:10] == [d for d in reversed(ds[:20]) if d not in event_days][:10]
    assert got[10:] == [d for d in ds[21:] if d not in event_days][:10]
    near_start = study.placebo_days(ds[2], ds, set())
    assert len(near_start) == 2 + 10  # fewer than ten days exist before the third day


def test_entry_grid_runs_every_five_minutes_from_the_first_possible_entry():
    grid = study.entry_grid(75, 285)
    assert grid[0] == "10:31" and grid[-1] == "14:01" and len(grid) == 43


def test_day_t_needs_five_days_and_some_spread():
    assert study.day_t({"a": 1.0})[1] is None
    mean, t = study.day_t({str(k): float(k) for k in range(10)})
    assert mean == 4.5 and round(t, 2) == round(4.5 / (np.std(range(10), ddof=1) / np.sqrt(10)), 2)
    assert study.day_t({str(k): 3.0 for k in range(10)})[1] is None


def fake_world(event_net=300.0, placebo_net=100.0, n_events=12, n_days=60):
    ds = days(n_days)
    ev_idx = list(range(25, 25 + n_events))
    events = [{"day": ds[i], "stamp": 80, "entry": "10:36", "side": "both"} for i in ev_idx]
    event_days = {e["day"] for e in events}

    def row(day, gross, stopped=""):
        return {
            "day": day,
            "entry": "",
            "side": "both",
            "gross": gross,
            "worst_mtm": -50.0,
            "stopped_by": stopped,
            "orders": 2,
            "buy_value": 0.0,
            "sell_value": 0.0,
            "weekly_expiry": "",
            "spot_entry": 23000.0,
            "spot_exit": 23100.0,
        }

    def lookup(day, entry, side, slip):
        base = event_net if day in event_days and entry == "10:36" else placebo_net
        if entry != "10:36":  # a deterministic spread of other-minute results
            return row(day, 60.0 + (hash((day, entry)) % 121))
        return row(day, base - 1000 * slip - 20.0 * slip, "SL" if slip else "")

    return ds, events, event_days, lookup


def test_summarise_reports_event_placebo_random_time_and_slippage():
    ds, events, event_days, lookup = fake_world()
    out = study.summarise(
        "NIFTY",
        events,
        ds,
        event_days,
        study.entry_grid(75, 285),
        lookup,
        draws=50,
        seed=1,
        slippage=(0.5, 1.0),
    )
    # every row has two orders and no turnover: charges = brokerage ₹26 + 18% GST on it
    fee = 26 * 1.18
    assert out["events"] == 12 and out["thin"]
    assert out["net_mean"] == pytest.approx(300 - fee) and out["gross_mean"] == 300
    assert out["placebo"]["events"] == 12 and out["placebo"]["diff_mean"] == 200.0
    assert out["placebo"]["diff_t"] is None  # constant difference: no spread to divide by
    rt = out["random_time"]
    assert rt["draws"] == 50 and rt["events"] == 12 and 0 <= rt["event_percentile"] <= 1
    assert rt["event_percentile"] == 1.0  # the event mean (274) is far above ~94 per random minute
    assert out["slippage"]["0.5"]["net_mean"] == pytest.approx(300 - 500 - 10 - fee)
    assert (
        out["by_side"]["both"]["events"] == 12
        and out["by_expiry_day"]["other days"]["events"] == 12
    )
    assert out["equity"][-1][1] == pytest.approx(12 * (300 - fee), abs=0.1)
    assert [r["day"] for r in out["rows"]] == sorted(r["day"] for r in out["rows"])


def test_events_without_enough_placebo_days_have_no_difference():
    ds, events, event_days, _ = fake_world()

    def lookup(day, entry, side, slip):
        if day not in event_days:
            return None  # no option data on ordinary days
        return {
            "day": day,
            "gross": 50.0,
            "worst_mtm": 0.0,
            "stopped_by": "",
            "orders": 2,
            "buy_value": 0.0,
            "sell_value": 0.0,
            "weekly_expiry": day,
            "spot_entry": "",
            "spot_exit": "",
        }

    out = study.summarise("NIFTY", events, ds, event_days, [], lookup, draws=0, seed=1, slippage=())
    assert (
        out["events"] == 12
        and out["placebo"]["diff_mean"] is None
        and out["placebo"]["events"] == 0
    )
    assert out["random_time"] == {"draws": 0}
    assert out["by_expiry_day"]["expiry day"]["events"] == 12  # weekly_expiry == the day itself


def test_no_events_is_a_message_not_a_crash():
    out = study.summarise("NIFTY", [], days(30), set(), [], lambda *a: None, 0, 1, ())
    assert out["events"] == 0 and out["rows"] == [] and "no event" in out["message"]


def test_random_time_is_reproducible_for_a_seed():
    ds, events, event_days, lookup = fake_world()
    args = ("NIFTY", events, ds, event_days, study.entry_grid(75, 285), lookup)
    a = study.summarise(*args, draws=40, seed=3, slippage=())
    b = study.summarise(*args, draws=40, seed=3, slippage=())
    assert a["random_time"]["mean"] == b["random_time"]["mean"]
