import math
from datetime import date

import pytest

from option_backtesting.legwise import anatomy
from option_backtesting.legwise.market import N_MINUTES, Series


def series(closes: list[float]) -> Series:
    opens = [closes[0], *closes[:-1]]
    highs = [max(o, c) for o, c in zip(opens, closes, strict=True)]
    lows = [min(o, c) for o, c in zip(opens, closes, strict=True)]
    return Series(opens, highs, lows, list(closes))


def flat(value: float) -> Series:
    return series([value] * N_MINUTES)


def test_ramp_is_trend_up_and_zigzag_is_chop():
    ramp = series([20000 + i * 2 for i in range(N_MINUTES)])  # steady climb
    zig = series([20000 + (60 if i % 2 else -60) for i in range(N_MINUTES)])
    vix = flat(14.0)
    up = anatomy.segment_metrics(ramp, vix, 0, 75)
    chop = anatomy.segment_metrics(zig, vix, 0, 75)
    assert up is not None and chop is not None
    assert up.er == pytest.approx(1.0, abs=1e-6) and up.label == "TREND_UP"
    assert chop.er < 0.05 and chop.label == "CHOP"


def test_flat_day_is_quiet_and_missing_vix_is_unknown():
    seg = anatomy.segment_metrics(flat(20000), flat(14.0), 0, 75)
    assert seg is not None and seg.label == "QUIET"
    ramp = series([20000 + i * 2 for i in range(N_MINUTES)])
    assert anatomy.segment_metrics(ramp, None, 0, 75).label == "UNKNOWN"


def test_down_ramp_is_trend_down():
    ramp = series([20000 - i * 2 for i in range(N_MINUTES)])
    assert anatomy.segment_metrics(ramp, flat(14.0), 0, 75).label == "TREND_DOWN"


def test_implied_move_scales_with_vix_so_the_same_range_labels_differently():
    ramp = series([20000 + i * 2 for i in range(N_MINUTES)])
    calm = anatomy.segment_metrics(ramp, flat(10.0), 0, 75)
    stressed = anatomy.segment_metrics(ramp, flat(60.0), 0, 75)
    assert calm.implied_pct == pytest.approx(10 / 100 * math.sqrt(75 / (252 * 375)) * 100)
    assert calm.range_over_implied > stressed.range_over_implied
    # a path whose range IS the expected range for VIX-level vol reads ~1.0, not ~1.6
    expected = calm.implied_pct * math.sqrt(8 / math.pi)
    assert calm.range_over_implied == pytest.approx(calm.range_pct / expected)
    assert calm.label == "TREND_UP" and stressed.label == "QUIET"


def test_cuts_are_honoured_and_validated():
    assert anatomy.parse_cuts(["10:30", "13:30"]) == [75, 255]
    assert anatomy.segment_bounds([75, 255]) == [(0, 75), (75, 255), (255, N_MINUTES)]
    for bad in (["13:30", "10:30"], ["09:15"], ["16:00"], ["10:30", "10:30"], ["x"]):
        with pytest.raises(ValueError):
            anatomy.parse_cuts(bad)


def test_day_anatomy_gap_segments_and_dte_guard():
    ramp = series([20100 + i for i in range(N_MINUTES)])
    out = anatomy.day_anatomy(date(2026, 9, 29), ramp, flat(14.0), [75, 255], prev_close=20000)
    assert out["gap_pct"] == pytest.approx(0.5, abs=0.001)
    assert [s["start"] for s in out["segments"]] == ["09:15", "10:30", "13:30"]
    assert out["whole"]["label"] in {"TREND_UP", "QUIET", "CHOP"}
    # NIFTY's reference expiry weekday is only right from Sep 2025: earlier -> None
    assert anatomy.dte_for("NIFTY", date(2024, 3, 5)) is None
    assert anatomy.dte_for("NIFTY", date(2026, 9, 29)) == 0  # a Tuesday: expiry day


def test_realised_equal_to_implied_vol_reads_about_one():
    """The calibration the ratio exists for: simulate a random walk whose per-minute vol
    is exactly what VIX implies and check the AVERAGE ratio is ~1 (it was ~1.6 when the
    range was divided by the 1-sigma move instead of the expected range)."""
    import random

    rng = random.Random(1)
    vix = 15.0
    sigma = vix / 100 / math.sqrt(252 * 375)
    ratios = []
    for _ in range(300):
        s, closes = 20000.0, []
        for _ in range(N_MINUTES):
            s *= 1 + rng.gauss(0, sigma)
            closes.append(s)
        seg = anatomy.segment_metrics(series(closes), flat(vix), 0, 180)
        ratios.append(seg.range_over_implied)
    assert sum(ratios) / len(ratios) == pytest.approx(1.0, abs=0.12)
