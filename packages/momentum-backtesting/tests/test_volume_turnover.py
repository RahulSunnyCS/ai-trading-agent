"""Unit tests for scripts/volume_turnover_tests.py (TODO.md 3.9.27) on hand-built frames."""

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(_SCRIPTS))
import volume_turnover_tests as vtt  # noqa: E402

NAN = math.nan


@pytest.fixture
def small_windows(monkeypatch):
    monkeypatch.setattr(vtt, "RECENT2", 3)
    monkeypatch.setattr(vtt, "RECENT4", 4)
    monkeypatch.setattr(vtt, "PRIOR", 4)
    monkeypatch.setattr(vtt, "WINDOW13", 3)


def _daily(shares, close=None, symbol="AAA", start="2021-01-04"):
    dates = pd.bdate_range(start, periods=len(shares))
    close = close if close is not None else [100.0] * len(shares)
    return pd.DataFrame(
        {
            "date": dates,
            "symbol": symbol,
            "close": close,
            "high": [c * 1.01 for c in close],
            "low": [c * 0.99 for c in close],
            "shares": [float(s) for s in shares],
            "turnover": [s * c for s, c in zip(shares, close, strict=True)],
        }
    )


def test_friday_label_matches_w_fri_bins():
    dates = pd.Series(pd.to_datetime(["2021-01-04", "2021-01-08", "2021-01-09", "2021-01-10"]))
    assert vtt.friday_label(dates).dt.strftime("%Y-%m-%d").tolist() == [
        "2021-01-08",
        "2021-01-08",
        "2021-01-15",
        "2021-01-15",
    ]


def test_segment_columns_follow_the_price_split_and_ratios_never_straddle_it(small_windows):
    # 10 sessions, then a detected event on day 11 (a Monday): shares jump 5x at the split.
    daily = _daily([100] * 10 + [500] * 10)
    events = pd.DataFrame({"symbol": ["AAA"], "event_date": [daily["date"].iloc[10]]})
    daily["col"] = vtt.segment_columns(daily, events)
    assert daily["col"].tolist() == ["AAA"] * 10 + ["AAA#2"] * 10
    feats = vtt.daily_volume_features(daily)
    seg2 = feats[feats["col"] == "AAA#2"]
    # A full prior window plus the recent window fits only from the 7th session of AAA#2 on
    # (4 prior + 3 recent); before that there is no ratio, never a fake 5x across the split.
    assert seg2["VR2"].iloc[:6].isna().all()
    assert seg2["VR2"].iloc[6:].tolist() == pytest.approx([1.0] * 4)
    assert feats.loc[feats["col"] == "AAA", "VR2"].dropna().tolist() == pytest.approx([1.0] * 4)


def test_median_ratios_and_one_day_spike_is_blunted(small_windows):
    daily = _daily([10, 10, 10, 10, 10, 10, 30, 30, 30])
    daily["col"] = "AAA"
    f = vtt.daily_volume_features(daily)
    # Last row: median of the last 3 sessions = 30, median of the 4 before them = 10.
    assert f["VR2"].iloc[-1] == pytest.approx(3.0)
    # VR4: last 4 sessions (10, 30, 30, 30) -> 30; the 4 before them -> 10.
    assert f["VR4"].iloc[-1] == pytest.approx(3.0)
    spike = _daily([10, 10, 10, 10, 10, 10, 10, 10, 400])
    spike["col"] = "AAA"
    assert vtt.daily_volume_features(spike)["VR2"].iloc[-1] == pytest.approx(1.0)


def test_acc13_and_liq13(small_windows):
    daily = _daily([5, 10, 20, 30], close=[100.0, 101.0, 100.0, 102.0])
    daily["col"] = "AAA"
    f = vtt.daily_volume_features(daily)
    # Last 3 sessions: up 10, down 20, up 30 -> (10 + 30) / 20.
    assert f["ACC13"].iloc[-1] == pytest.approx(2.0)
    # Median turnover of the last 3 sessions: 1010, 2000, 3060.
    assert f["LIQ13"].iloc[-1] == pytest.approx(2000.0)


def test_clv2_and_rise2():
    # Two full weeks: week 1 range 90-110, week 2 range 95-120, week 2 closes at 115.
    dates = pd.bdate_range("2021-01-04", periods=10)
    daily = pd.DataFrame(
        {
            "col": "AAA",
            "date": dates,
            "close": [100.0] * 9 + [115.0],
            "high": [110.0] * 5 + [120.0] * 5,
            "low": [90.0] * 5 + [95.0] * 5,
            "shares": [1.0] * 10,
            "turnover": [1.0] * 10,
        }
    )
    for name in ("VR2", "VR4", "ACC13", "LIQ13"):
        daily[name] = NAN
    w = vtt.weekly_volume_features(daily)
    assert math.isnan(w["CLV2"]["AAA"].iloc[0])  # no previous week yet
    assert w["CLV2"]["AAA"].iloc[1] == pytest.approx((115 - 90) / (120 - 90))
    # RISE2: weekly median shares 1, 2, 3 -> True in week 3; 1, 3, 2 -> False.
    three = pd.concat([daily, daily.assign(date=daily["date"] + pd.Timedelta(weeks=2))])
    three["shares"] = [1.0] * 5 + [2.0] * 5 + [3.0] * 5 + [9.0] * 5
    rise = vtt.weekly_volume_features(three.reset_index(drop=True))["RISE2"]["AAA"]
    assert rise.iloc[:2].isna().all()
    assert rise.iloc[2:].tolist() == [1.0, 1.0]
    three["shares"] = [1.0] * 5 + [3.0] * 5 + [2.0] * 5 + [9.0] * 5
    rise = vtt.weekly_volume_features(three.reset_index(drop=True))["RISE2"]["AAA"]
    assert rise.iloc[2:].tolist() == [0.0, 0.0]


def test_above10_dist10_and_history_gate(monkeypatch):
    monkeypatch.setattr(vtt, "MA_SHORT", 3)
    monkeypatch.setattr(vtt, "MIN_MA_WEEKS", 4)
    weeks = pd.date_range("2021-01-01", periods=6, freq="W-FRI")
    prices = pd.DataFrame(
        {"A": [10.0, 10.0, 10.0, 13.0, 7.0, 10.0], "B": [NAN] * 3 + [5.0] * 3}, index=weeks
    )
    ok = vtt.history_ok(prices, {"A": weeks[4]})
    f = vtt.ma_features(prices, ok)
    # A: MA3 at week 4 = 11 -> above, DIST 13/11 - 1; week 5 = 10 -> below; week 6 is past
    # A's stale cutoff -> NaN. B never has 4 of its own weeks -> NaN throughout.
    assert f["ABOVE10"]["A"].iloc[3:5].tolist() == [1.0, 0.0]
    assert math.isnan(f["ABOVE10"]["A"].iloc[5])
    assert f["DIST10"]["A"].iloc[3] == pytest.approx(13 / 11 - 1)
    assert f["DIST10"]["A"].iloc[4] == pytest.approx(7 / 10 - 1)
    assert f["ABOVE10"]["A"].iloc[:3].isna().all()
    assert f["ABOVE10"]["B"].isna().all()


def _stage(raw):
    s, w = vtt.stage_series(np.array(raw, dtype=float))
    return [None if math.isnan(x) else int(x) for x in s], [
        None if math.isnan(x) else int(x) for x in w
    ]


def test_stage_needs_two_weeks_and_counts_from_the_first_of_them():
    # The first classifiable week is neither trend, so the Stage 2 start is observed.
    assert _stage([NAN, 0, 2, 2, 2]) == ([None, None, None, 2, 2], [None, None, None, 2, 3])


def test_stage_one_week_flip_does_not_change_the_stage():
    stage, weeks = _stage([0, 2, 2, 4, 2, 2, 4, 4])
    assert stage == [None, None, 2, 2, 2, 2, 2, 4]
    assert weeks == [None, None, 2, 3, 4, 5, 6, 2]


def test_stage_three_after_two_and_stage_one_after_four():
    stage, _ = _stage([2, 2, 0, 0, 0, 4, 4, 0, 0, 2, 2])
    assert stage == [None, 2, 2, 3, 3, 3, 4, 4, 1, 1, 2]


def test_stage_unknown_until_a_trend_is_recorded():
    stage, _ = _stage([0, 0, 0, 4, 4, 0])
    assert stage == [None, None, None, None, 4, 4]


def test_stage_nan_week_keeps_the_state():
    stage, weeks = _stage([0, 2, 2, NAN, 2])
    assert stage == [None, None, 2, None, 2]
    assert weeks == [None, None, 2, None, 4]


def test_stage_spell_starting_at_the_first_classified_week_is_censored():
    # Stage 2 from the segment's first classifiable week: its true start is unknown, so the
    # whole spell has no weeks-in-stage. The later Stage 3 and Stage 4 spells are observed.
    stage, weeks = _stage([NAN, 2, 2, 2, 0, 0, 4, 4])
    assert stage == [None, None, 2, 2, 2, 3, 3, 4]
    assert weeks == [None, None, None, None, None, 2, 3, 2]
    # A one-week dip does not end the censored spell.
    _, weeks = _stage([2, 2, 0, 2, 2])
    assert weeks == [None] * 5


def test_raw_trend_and_early2(monkeypatch):
    monkeypatch.setattr(vtt, "MA_STAGE", 3)
    monkeypatch.setattr(vtt, "SLOPE_LAG", 1)
    monkeypatch.setattr(vtt, "EARLY_WEEKS", 2)
    idx = pd.date_range("2021-01-01", periods=10, freq="W-FRI")
    prices = pd.DataFrame(
        {
            "flat_then_up": [10.0, 10, 10, 10, 10, 11, 12, 13, 14, 15],
            "up_from_start": [10.0, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        },
        index=idx,
    )
    ok = prices.notna()
    raw = vtt.raw_trend(prices, ok)
    # MA3 needs 3 weeks and the slope one more: the first code is week 4.
    assert raw["up_from_start"].iloc[:3].isna().all()
    assert (raw["up_from_start"].iloc[3:] == 2).all()
    assert raw["flat_then_up"].iloc[3:6].tolist() == [0.0, 0.0, 2.0]
    st, wk = vtt.stages(prices, ok)
    e2 = vtt.early2(st, wk)
    assert st["flat_then_up"].iloc[6:].tolist() == [2.0] * 4
    assert e2["flat_then_up"].iloc[:6].isna().all()
    assert e2["flat_then_up"].iloc[6:].tolist() == [1.0, 0.0, 0.0, 0.0]
    # Stage 2 from the first classifiable week: left-censored, so EARLY2 is unknown.
    assert st["up_from_start"].iloc[4:].tolist() == [2.0] * 6
    assert e2["up_from_start"].isna().all()
    spells = vtt.stage2_spells(st, wk)
    assert spells.set_index("column")["censored"].to_dict() == {
        "flat_then_up": False,
        "up_from_start": True,
    }


def test_rank_residual_removes_the_controls():
    y = pd.Series([1.0, 2, 3, 4, 5, 6])
    controls = pd.DataFrame({"m": [1.0, 2, 3, 4, 5, 6]})
    assert vtt.rank_residual(y, controls).abs().max() == pytest.approx(0.0, abs=1e-12)
    rng = np.random.default_rng(0)
    y = pd.Series(rng.normal(size=50))
    controls = pd.DataFrame({"m": rng.normal(size=50), "r": rng.normal(size=50)})
    y.iloc[3] = NAN
    res = vtt.rank_residual(y, controls)
    assert math.isnan(res.iloc[3])
    kept = res.dropna()
    ranks = controls.loc[kept.index].rank(pct=True)
    assert kept.mean() == pytest.approx(0.0, abs=1e-12)
    assert float((kept * ranks["m"]).sum()) == pytest.approx(0.0, abs=1e-10)
    assert float((kept * ranks["r"]).sum()) == pytest.approx(0.0, abs=1e-10)


def test_spearman_and_weekly_ic():
    assert vtt.spearman(pd.Series([1.0, 2, 3, 4]), pd.Series([10.0, 20, 30, 40])) == 1.0
    # Ranks (1, 2, 3, 4) vs (2, 1, 4, 3): 1 - 6 * 4 / (4 * 15) = 0.6.
    assert vtt.spearman(pd.Series([1.0, 2, 3, 4]), pd.Series([2.0, 1, 4, 3])) == pytest.approx(0.6)
    weeks = pd.date_range("2021-01-01", periods=2, freq="W-FRI")
    feature = pd.DataFrame({"A": [1.0, 1], "B": [2.0, 2], "C": [3.0, 3], "D": [9.0, 0]}, weeks)
    target = pd.DataFrame({"A": [1.0, 3], "B": [2.0, 2], "C": [3.0, 1], "D": [0.0, 0]}, weeks)
    universe = pd.DataFrame(True, index=weeks, columns=list("ABCD"))
    universe["D"] = False  # D is outside the universe and must not count
    ic = vtt.weekly_ic(feature, target, universe)
    assert ic.tolist() == pytest.approx([1.0, -1.0])


def test_run_lengths():
    idx = pd.date_range("2021-01-01", periods=5, freq="W-FRI")
    runs = vtt.run_lengths(pd.Series([NAN, 2.0, 2.0, 3.0, 3.0], index=idx))
    assert [(lab, n) for _, _, lab, n in runs] == [("?", 1), ("S2", 2), ("S3", 2)]


def test_forward_returns_stop_at_a_stale_cutoff():
    idx = pd.date_range("2021-01-01", periods=6, freq="W-FRI")
    prices = pd.DataFrame({"A": [1.0, 2, 4, 8, 8, 8], "B": [1.0, 2, 4, 8, 16, 32]}, index=idx)
    fwd = vtt.forward_returns(prices, 1, {"A": idx[3]})
    # A's real prices end at week 4; the flat ffilled tail must not read as a 0% return.
    assert fwd["A"].iloc[:3].tolist() == [1.0, 1.0, 1.0]
    assert fwd["A"].iloc[3:].isna().all()
    assert fwd["B"].iloc[:5].tolist() == [1.0] * 5
    assert math.isnan(fwd["B"].iloc[5])


def test_flag_coefficient_recovers_the_gap_after_controls():
    m = pd.Series(np.arange(12, dtype=float))
    flag = pd.Series([1.0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0])
    y = 0.02 * m.rank(pct=True) + 0.05 * flag
    assert vtt.flag_coefficient(y, pd.DataFrame({"m": m}), flag) == pytest.approx(0.05)
    too_few = pd.Series([1.0, 1] + [0.0] * 10)
    assert math.isnan(vtt.flag_coefficient(y, pd.DataFrame({"m": m}), too_few))


def test_tercile_spread():
    score = pd.Series(np.arange(1.0, 10.0))
    assert vtt.tercile_spread(score, score * 2) == pytest.approx(2 * (8 - 2))
    assert math.isnan(vtt.tercile_spread(score.iloc[:5], score.iloc[:5]))


def test_position_pnl_carries_units_through_a_skipped_week():
    idx = pd.date_range("2021-01-01", periods=4, freq="W-FRI")
    prices = pd.DataFrame({"A": [10.0, 11, 12, 12], "CASH": [1.0, 1, 1, 1.01]}, index=idx)
    # Engine weeks 1 and 3 (week 2 skipped): all in A, then half in A and half idle.
    weights = pd.DataFrame({"A": [1.0, 0.5], "IDLE": [0.0, 0.5]}, index=idx[[0, 2]])
    equity = pd.Series([1.0, 1.2], index=idx[[0, 2]])
    pnl = vtt.position_pnl(weights, equity, prices, "CASH", "IDLE")
    assert pnl["A"].tolist() == pytest.approx([0.1, 0.1, 0.0, 0.0])
    assert pnl["IDLE"].tolist() == pytest.approx([0.0, 0.0, 0.006, 0.0])
    assert pnl.to_numpy().sum() == pytest.approx(0.206)
