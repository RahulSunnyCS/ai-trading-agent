"""BL-041 pattern detectors: adjustment, causal pivots, the three shapes, and no look-ahead."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import patterns
from momentum_backtesting.patterns import bars as bars_mod
from momentum_backtesting.patterns import cup_handle, features, flag, tight_range
from momentum_backtesting.patterns.bars import SymbolBars, adjust
from momentum_backtesting.patterns.pivots import zigzag


def _frame(closes, *, symbol="AAA", end="2023-06-30", volume=None, spread=0.01) -> pd.DataFrame:
    closes = np.asarray(closes, dtype=float)
    dates = pd.bdate_range(end=end, periods=len(closes))
    return pd.DataFrame(
        {
            "date": dates,
            "symbol": symbol,
            "open": closes,
            "high": closes * (1 + spread),
            "low": closes * (1 - spread),
            "close": closes,
            "volume": np.full(len(closes), 1e6) if volume is None else np.asarray(volume, float),
        }
    )


def _weekly_path(weekly_closes) -> np.ndarray:
    """Five identical daily closes per weekly close."""
    return np.repeat(np.asarray(weekly_closes, dtype=float), 5)


def _bars(frame: pd.DataFrame) -> SymbolBars:
    adjusted = adjust(frame, {})
    return SymbolBars.from_frame(adjusted["symbol"].iloc[0], adjusted)


# --- guard and adjustment ----------------------------------------------------------------------


def test_guard_refuses_the_holdout():
    patterns.guard("2023-12-29")
    with pytest.raises(ValueError, match="sealed"):
        patterns.guard("2024-01-05")
    assert patterns.guard("2024-01-05", allow_holdout=True) == pd.Timestamp("2024-01-05")


def test_split_is_adjusted_forward_and_unexplained_jump_is_bad():
    frame = _frame([100, 101, 50.5, 51, 52])  # a 1:2 split on day 3
    out = adjust(frame, {"AAA": [(frame["date"][2], 2.0)]})
    assert out["close"].tolist() == [100, 101, 101, 102, 104]
    assert out["volume"].iloc[2] == pytest.approx(0.5e6)
    assert not out["bad"].any()
    unexplained = adjust(frame, {})
    assert unexplained["bad"].tolist() == [False, False, True, False, False]


def test_a_long_gap_marks_the_bar_after_it_bad():
    a = _frame(np.full(30, 100.0), symbol="AAA")
    b = _frame(np.full(30, 100.0), symbol="BBB").drop(index=range(10, 20))
    out = adjust(pd.concat([a, b]), {})
    bad = out[out["symbol"] == "BBB"]["bad"]
    assert bad.sum() == 1


# --- pivots ------------------------------------------------------------------------------------


def test_zigzag_is_causal():
    rng = np.random.default_rng(3)
    path = 100 * np.exp(np.cumsum(rng.normal(0, 0.04, 300)))
    full = zigzag(path, 0.08)
    assert all(p.confirmed > p.index for p in full)
    for cut in (80, 150, 220):
        early = zigzag(path[: cut + 1], 0.08)
        assert early == [p for p in full if p.confirmed <= cut]


# --- shapes ------------------------------------------------------------------------------------


def _uptrend_then(base_weeks, *, swing=0.03, base_swing=0.005) -> np.ndarray:
    weeks = 60
    trend = 50 * (2 ** (np.arange(weeks) / weeks))
    trend = trend * (1 + swing * (-1) ** np.arange(weeks))
    top = trend[-1]
    base = top * (1 + base_swing * (-1) ** np.arange(base_weeks))
    return _weekly_path(np.r_[trend, base])


def test_tight_range_found_after_an_uptrend():
    out = tight_range.scan(_bars(_frame(_uptrend_then(5))))
    assert out[-1] is not None
    assert out[-1].geometry["range_vs_own_median"] <= 0.5


def test_wide_range_is_not_tight():
    out = tight_range.scan(_bars(_frame(_uptrend_then(5, base_swing=0.06))))
    assert out[-1] is None


def _flag_path(flag_end: float):
    flat = np.full(60, 100.0)
    pole = np.linspace(100, 130, 10)
    flag_days = np.linspace(129, flag_end, 8)
    closes = np.r_[flat, pole, flag_days]
    volume = np.r_[np.full(60, 1e6), np.full(10, 2e6), np.full(8, 5e5)]
    # end on a Friday so the last bar closes a week
    return _frame(closes, volume=volume, end="2023-06-30")


def test_flag_found():
    out = flag.scan(_bars(_flag_path(124)))
    assert out[-1] is not None
    assert out[-1].geometry["pole_rise"] >= 0.2


def test_flag_that_falls_too_far_is_rejected():
    assert flag.scan(_bars(_flag_path(108)))[-1] is None


def _cup_path(cup: list[float]) -> pd.DataFrame:
    advance = list(np.linspace(60, 100, 30))
    handle = [96, 95]
    return _frame(_weekly_path(advance + cup + handle))


U_CUP = [95, 88, 80, 77, 76, 75, 76, 78, 82, 90, 96, 99]
V_CUP = [97, 96, 95, 90, 80, 75, 85, 95, 98, 99]


def test_cup_and_handle_found():
    out = cup_handle.scan(_bars(_cup_path(U_CUP)))
    assert out[-1] is not None
    assert out[-1].geometry["handle_weeks"] == 2


def test_v_bottom_is_not_a_cup():
    assert cup_handle.scan(_bars(_cup_path(V_CUP)))[-1] is None


# --- states ------------------------------------------------------------------------------------


def test_breakout_on_volume_after_a_base():
    frame = _frame(_uptrend_then(5))
    extra = pd.bdate_range(start=frame["date"].iloc[-1] + pd.Timedelta(days=1), periods=5)
    top = frame["close"].iloc[-1]
    burst = pd.DataFrame(
        {
            "date": extra,
            "symbol": "AAA",
            "open": top,
            "high": top * 1.08,
            "low": top,
            "close": top * 1.07,
            "volume": 3e6,
        }
    )
    det = features.detect(adjust(pd.concat([frame, burst]), {}), ("tight_range",), workers=1)
    assert det.iloc[-1]["state"] == "broke_out"
    assert det.iloc[-1]["score"] == 1.0


# --- no look-ahead -----------------------------------------------------------------------------


def test_detections_up_to_a_cut_do_not_change_when_later_bars_exist():
    rng = np.random.default_rng(7)
    frames = []
    for n, symbol in enumerate(("AAA", "BBB", "CCC", "DDD")):
        steps = rng.normal(0.0012, 0.022, 900)
        volume = rng.lognormal(13.8, 0.3, 900)
        steps[300 + n * 50 : 330 + n * 50] = 0.012  # give each a run-up
        for start in (450 + n * 37, 650 + n * 29):  # pole, flag, breakout on volume
            steps[start : start + 15] = 0.02
            volume[start : start + 15] *= 2
            steps[start + 15 : start + 27] = -0.003
            volume[start + 15 : start + 27] *= 0.5
            steps[start + 27] = 0.05
            volume[start + 27] *= 4
        frame = _frame(100 * np.exp(np.cumsum(steps)), symbol=symbol, end="2023-12-29")
        frame["volume"] = volume
        frames.append(frame)
    daily = pd.concat(frames)
    split = {"BBB": [(daily["date"].iloc[500], 5.0)]}
    full = features.detect(adjust(daily, split), workers=1)
    covered = set(full["pattern"] + "/" + full["state"])
    for pattern in ("tight_range", "flag", "cup_handle"):
        assert {f"{pattern}/forming", f"{pattern}/near_pivot"} & covered, pattern
    assert any(item.endswith("broke_out") for item in covered)
    for cut in ("2022-06-24", "2023-02-17", "2023-08-25"):
        part = daily[daily["date"] <= cut]
        early = features.detect(adjust(part, split), workers=1)
        expected = full[full["week"] <= cut].reset_index(drop=True)
        assert len(expected) > 0
        pd.testing.assert_frame_equal(early, expected)


def test_score_table_takes_the_best_state_per_week():
    det = pd.DataFrame(
        {
            "symbol": ["AAA", "AAA"],
            "week": pd.to_datetime(["2023-01-06", "2023-01-06"]),
            "pattern": ["flag", "flag"],
            "score": [0.5, 1.0],
        }
    )
    weeks = pd.DatetimeIndex(pd.to_datetime(["2023-01-06", "2023-01-13"]))
    table = features.score_table(det, "flag", weeks, ["AAA", "BBB"])
    assert table.loc["2023-01-06", "AAA"] == 1.0
    assert table.loc["2023-01-13", "AAA"] == 0.0
    assert table["BBB"].eq(0).all()


def test_friday_labels():
    days = pd.to_datetime(["2023-06-26", "2023-06-30", "2023-07-01"])
    assert list(bars_mod.friday(days)) == [pd.Timestamp("2023-06-30")] * 3


def test_loosened_relaxes_every_float_threshold_and_nothing_else():
    from momentum_backtesting.patterns.gallery import LOOSEN, loosened

    p = patterns.detector_params("cup_handle")
    loose = loosened(p)
    assert loose["cup"]["max_depth"] == pytest.approx(p["cup"]["max_depth"] * LOOSEN)
    assert loose["cup"]["min_depth"] == pytest.approx(p["cup"]["min_depth"] / LOOSEN)
    assert loose["cup"]["min_weeks"] == p["cup"]["min_weeks"]  # counts stay
    assert loose["handle"]["must_be_in_upper_half"] is True  # switches stay
    tight = loosened(patterns.detector_params("tight_range"))
    assert tight["max_range"]["5"] == pytest.approx(0.12 * LOOSEN)
