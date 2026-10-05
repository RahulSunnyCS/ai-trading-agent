"""categories/prices.py: per-stock weekly price series + corporate-action-like
detection. Pure in-memory/tmp_path fixtures -- no network, no real
daily.parquet (the real-data sanity checks that justified the thresholds and
found the carry-forward mitigation live in this task's own verification, not
here; see the module docstring for the real numbers)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories.prices import (
    EVENT_COLUMNS,
    build_stock_weekly_prices,
    build_symbol_segments,
    detect_events,
    load_daily_prices,
)


def _write_daily_parquet(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(path)


def _row(date: str, symbol: str, close: float, turnover: float) -> dict:
    return {"date": date, "symbol": symbol, "close": close, "turnover": turnover}


# --------------------------------------------------------------------------
# load_daily_prices
# --------------------------------------------------------------------------


def test_load_daily_prices_filters_to_requested_symbols_only(tmp_path):
    _write_daily_parquet(
        tmp_path / "daily.parquet",
        [
            _row("2021-01-04", "ABC", 100.0, 1000.0),
            _row("2021-01-04", "XYZ", 50.0, 500.0),
            _row("2021-01-04", "OTHER", 10.0, 100.0),
        ],
    )
    out = load_daily_prices(["ABC", "XYZ"], stocks_data_dir=tmp_path)
    assert set(out["symbol"]) == {"ABC", "XYZ"}


def test_load_daily_prices_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_daily_prices(["ABC"], stocks_data_dir=tmp_path / "no_such_dir")


def test_load_daily_prices_empty_symbol_set_returns_empty_frame(tmp_path):
    _write_daily_parquet(tmp_path / "daily.parquet", [_row("2021-01-04", "ABC", 100.0, 1000.0)])
    out = load_daily_prices([], stocks_data_dir=tmp_path)
    assert out.empty


# --------------------------------------------------------------------------
# detect_events
# --------------------------------------------------------------------------


def test_detect_events_flags_a_big_drop_with_no_turnover_spike():
    # Mirrors ONGC's real 2011-02-08 bonus+split: close -76%, turnover roughly halved.
    daily = pd.DataFrame(
        [
            _row("2021-01-04", "ABC", 100.0, 1000.0),
            _row("2021-01-05", "ABC", 24.0, 500.0),  # -76% drop, turnover ratio 0.5
        ]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    events = detect_events(daily)
    assert len(events) == 1
    assert events.iloc[0]["symbol"] == "ABC"
    assert events.iloc[0]["turnover_ratio"] == pytest.approx(0.5)


def test_detect_events_does_not_flag_a_genuine_crash_with_turnover_spike():
    # Mirrors Policybazaar's real 2026-09-24 crash: close -36%, turnover ~7.6x.
    daily = pd.DataFrame(
        [
            _row("2021-01-04", "XYZ", 100.0, 1000.0),
            _row("2021-01-05", "XYZ", 64.0, 7600.0),  # -36% drop, turnover ratio 7.6
        ]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    events = detect_events(daily)
    assert events.empty


def test_detect_events_ignores_drops_below_the_threshold():
    daily = pd.DataFrame(
        [
            _row("2021-01-04", "ABC", 100.0, 1000.0),
            _row("2021-01-05", "ABC", 90.0, 400.0),  # only -10%, below default 15%
        ]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    events = detect_events(daily)
    assert events.empty


def test_detect_events_respects_custom_thresholds():
    daily = pd.DataFrame(
        [
            _row("2021-01-04", "ABC", 100.0, 1000.0),
            _row("2021-01-05", "ABC", 88.0, 3500.0),  # -12% drop, turnover ratio 3.5
        ]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    # Default thresholds (15% / 3x): neither condition met -> no event.
    assert detect_events(daily).empty
    # Loosen both: -12% clears a 10% floor, and 3.5x clears a 4x spike floor.
    loose = detect_events(daily, min_drop_pct=0.10, turnover_spike_multiple=4.0)
    assert len(loose) == 1


def test_detect_events_requires_a_prior_row():
    daily = pd.DataFrame([_row("2021-01-04", "ABC", 100.0, 1000.0)])
    daily["date"] = pd.to_datetime(daily["date"])
    assert detect_events(daily).empty


def test_detect_events_zero_current_turnover_is_still_a_valid_ca_signal():
    # An ex-date price adjustment with literally no trades that day (illiquid name) --
    # ratio is 0, well under the spike threshold, so it's still flagged.
    daily = pd.DataFrame(
        [
            _row("2021-01-04", "ABC", 100.0, 1000.0),
            _row("2021-01-05", "ABC", 20.0, 0.0),
        ]
    )
    daily["date"] = pd.to_datetime(daily["date"])
    events = detect_events(daily)
    assert len(events) == 1
    assert events.iloc[0]["turnover_ratio"] == 0.0


def test_detect_events_empty_input_returns_empty_with_columns():
    out = detect_events(pd.DataFrame(columns=["date", "symbol", "close", "turnover"]))
    assert out.empty
    assert list(out.columns) == list(EVENT_COLUMNS[:4])


# --------------------------------------------------------------------------
# build_symbol_segments
# --------------------------------------------------------------------------


def _close_series(pairs: list[tuple[str, float]]) -> pd.Series:
    idx = pd.to_datetime([d for d, _ in pairs])
    return pd.Series([v for _, v in pairs], index=idx)


def test_build_symbol_segments_no_events_returns_one_segment():
    close = _close_series([("2021-01-04", 100.0), ("2021-01-05", 101.0)])
    segments, boundary_names, non_terminal = build_symbol_segments(close, "ABC", [])
    assert list(segments) == ["ABC"]
    assert boundary_names == []
    assert non_terminal == []


def test_build_symbol_segments_splits_at_the_week_monday_boundary():
    # Week 1: Mon 2021-01-04 .. Fri 2021-01-08. Week 2: Mon 2021-01-11 .. Fri 2021-01-15.
    close = _close_series(
        [
            ("2021-01-04", 100.0),
            ("2021-01-05", 101.0),
            ("2021-01-08", 102.0),
            ("2021-01-11", 20.0),  # event lands here (Monday of week 2)
            ("2021-01-13", 21.0),  # Wednesday of week 2 -- same week
            ("2021-01-15", 22.0),
        ]
    )
    event_date = pd.Timestamp("2021-01-13")  # mid-week-2 event, snapped to that week's Monday
    segments, boundary_names, non_terminal = build_symbol_segments(close, "ABC", [event_date])

    assert set(segments) == {"ABC", "ABC#2"}
    # Old segment: only week-1 dates.
    week1_dates = pd.to_datetime(["2021-01-04", "2021-01-05", "2021-01-08"])
    assert list(segments["ABC"].index) == list(week1_dates)
    # New segment: the whole of week 2, including days before the exact event date.
    assert list(segments["ABC#2"].index) == list(
        pd.to_datetime(["2021-01-11", "2021-01-13", "2021-01-15"])
    )
    assert boundary_names == [(pd.Timestamp("2021-01-11"), "ABC#2")]
    assert non_terminal == ["ABC"]


def test_build_symbol_segments_same_week_events_collapse_to_one_boundary():
    close = _close_series(
        [
            ("2021-01-04", 100.0),
            ("2021-01-11", 20.0),
            ("2021-01-12", 19.0),
            ("2021-01-18", 5.0),
        ]
    )
    # Two events, both inside the 2021-01-11..15 week -> one split, not two.
    events = [pd.Timestamp("2021-01-11"), pd.Timestamp("2021-01-12")]
    segments, boundary_names, _ = build_symbol_segments(close, "ABC", events)
    assert set(segments) == {"ABC", "ABC#2"}
    assert len(boundary_names) == 1


def test_build_symbol_segments_multiple_events_produce_hash_numbered_columns():
    close = _close_series(
        [
            ("2021-01-04", 100.0),
            ("2021-01-11", 20.0),
            ("2021-01-18", 5.0),
        ]
    )
    events = [pd.Timestamp("2021-01-11"), pd.Timestamp("2021-01-18")]
    segments, boundary_names, non_terminal = build_symbol_segments(close, "ABC", events)
    assert set(segments) == {"ABC", "ABC#2", "ABC#3"}
    assert non_terminal == ["ABC", "ABC#2"]


def test_build_symbol_segments_drops_a_boundary_at_or_before_the_first_date():
    # Event detected on the symbol's 2nd-ever trading day: its week-Monday boundary
    # falls before the series' first date -- must not produce an empty leading segment.
    close = _close_series([("2021-01-06", 100.0), ("2021-01-07", 20.0)])
    event_date = pd.Timestamp("2021-01-07")  # week-Monday = 2021-01-04, before first date
    segments, boundary_names, non_terminal = build_symbol_segments(close, "ABC", [event_date])
    assert list(segments) == ["ABC"]
    assert boundary_names == []
    assert non_terminal == []


def test_build_symbol_segments_empty_close_returns_nothing():
    segments, boundary_names, non_terminal = build_symbol_segments(
        pd.Series(dtype=float), "ABC", []
    )
    assert segments == {}
    assert boundary_names == []
    assert non_terminal == []


# --------------------------------------------------------------------------
# build_stock_weekly_prices (end to end)
# --------------------------------------------------------------------------


def test_build_stock_weekly_prices_end_to_end_with_a_split(tmp_path):
    rows = [
        _row("2021-01-04", "ABC", 100.0, 1000.0),
        _row("2021-01-05", "ABC", 101.0, 1000.0),
        _row("2021-01-06", "ABC", 102.0, 1000.0),
        _row("2021-01-07", "ABC", 103.0, 1000.0),
        _row("2021-01-08", "ABC", 104.0, 1000.0),
        _row("2021-01-11", "ABC", 20.0, 500.0),  # event: -80.8% drop, turnover ratio 0.5
        _row("2021-01-12", "ABC", 21.0, 600.0),
        _row("2021-01-13", "ABC", 22.0, 600.0),
        _row("2021-01-14", "ABC", 23.0, 600.0),
        _row("2021-01-15", "ABC", 24.0, 600.0),
    ]
    _write_daily_parquet(tmp_path / "daily.parquet", rows)

    frame, events, stale_columns = build_stock_weekly_prices(
        ["ABC"], stocks_data_dir=tmp_path, series_breaks="legacy"
    )

    assert set(frame.columns) == {"ABC", "ABC#2"}
    assert len(events) == 1
    assert events.iloc[0]["new_column"] == "ABC#2"
    # Week-1 Friday close on the old segment.
    assert frame.loc["2021-01-08", "ABC"] == pytest.approx(104.0)
    # Week-2 Friday close on the new segment.
    assert frame.loc["2021-01-15", "ABC#2"] == pytest.approx(24.0)
    # "ABC" (the old, event-split segment) is also reported as stale -- its own last real
    # week is short of the frame's last week, same as "Why forward-fill" documents.
    assert stale_columns["ABC"] == pd.Timestamp("2021-01-08")
    assert "ABC#2" not in stale_columns  # the terminal/currently-active segment


def test_build_stock_weekly_prices_carries_forward_the_old_segment_by_default(tmp_path):
    rows = [
        _row("2021-01-04", "ABC", 100.0, 1000.0),
        _row("2021-01-08", "ABC", 104.0, 1000.0),
        _row("2021-01-11", "ABC", 20.0, 500.0),
        _row("2021-01-15", "ABC", 21.0, 500.0),
        _row("2021-01-18", "ABC", 22.0, 500.0),
        _row("2021-01-22", "ABC", 23.0, 500.0),
    ]
    _write_daily_parquet(tmp_path / "daily.parquet", rows)

    frame, _events, _stale = build_stock_weekly_prices(
        ["ABC"], stocks_data_dir=tmp_path, series_breaks="legacy"
    )

    # The old "ABC" segment (real data only through 2021-01-08) is forward-filled flat
    # through the rest of the frame -- never NaN once started -- so a currently-held
    # position never has its price vanish mid-backtest (see the module docstring "Why
    # forward-fill a stopped segment").
    assert frame["ABC"].isna().sum() == 0
    assert frame.loc["2021-01-15":, "ABC"].eq(104.0).all()
    # The new segment is unaffected and still reflects real, moving prices.
    assert frame.loc["2021-01-22", "ABC#2"] == pytest.approx(23.0)


def test_build_stock_weekly_prices_can_opt_out_of_carry_forward(tmp_path):
    rows = [
        _row("2021-01-04", "ABC", 100.0, 1000.0),
        _row("2021-01-08", "ABC", 104.0, 1000.0),
        _row("2021-01-11", "ABC", 20.0, 500.0),
        _row("2021-01-15", "ABC", 21.0, 500.0),
    ]
    _write_daily_parquet(tmp_path / "daily.parquet", rows)

    frame, _events, _stale = build_stock_weekly_prices(
        ["ABC"],
        stocks_data_dir=tmp_path,
        carry_forward_stopped_segments=False,
        series_breaks="legacy",
    )

    assert frame.loc["2021-01-15", "ABC"] != frame.loc["2021-01-15", "ABC"]  # NaN


def test_build_stock_weekly_prices_no_symbols_found_returns_empty(tmp_path):
    _write_daily_parquet(tmp_path / "daily.parquet", [_row("2021-01-04", "OTHER", 1.0, 1.0)])
    frame, events, stale_columns = build_stock_weekly_prices(["ABC"], stocks_data_dir=tmp_path)
    assert frame.empty
    assert list(events.columns) == list(EVENT_COLUMNS)
    assert stale_columns == {}


def test_build_stock_weekly_prices_flags_a_stale_column_with_no_detected_event(tmp_path):
    """Regression test for a real bug found in verification: a plain symbol rename
    (IDFCBANK -> IDFCFIRSTB, 2019-01-16 in the real dataset) produces no detected event at
    all (no unusual price move on the last day of the old symbol's data) but the old
    symbol's column still needs to go through the same stale/forward-fill/buy-ineligible
    treatment as a detected split, or a held position in it corrupts to NaN exactly the same
    way -- see the module docstring "Any column can go stale, not just a detected event's".
    `XYZ` here never has a big move at all -- it just stops, like a rename or a delisting.
    """
    rows = [
        _row("2021-01-04", "XYZ", 100.0, 1000.0),
        _row("2021-01-08", "XYZ", 101.0, 1000.0),  # last real row -- a normal, small move
        _row("2021-01-04", "OTHER", 50.0, 1000.0),
        _row("2021-01-08", "OTHER", 51.0, 1000.0),
        _row("2021-01-15", "OTHER", 52.0, 1000.0),  # OTHER keeps going -> frame extends past XYZ
    ]
    _write_daily_parquet(tmp_path / "daily.parquet", rows)

    frame, events, stale_columns = build_stock_weekly_prices(
        ["XYZ", "OTHER"], stocks_data_dir=tmp_path
    )

    assert events.empty  # no unusual move to detect -- this is the whole point
    assert stale_columns == {"XYZ": pd.Timestamp("2021-01-08")}
    assert frame["XYZ"].isna().sum() == 0  # forward-filled, not left to go NaN
    assert frame.loc["2021-01-15", "XYZ"] == pytest.approx(101.0)  # flat at its last real close


def test_verified_series_breaks_keep_one_continuous_series_for_an_unexplained_fall(tmp_path):
    rows = [
        _row("2021-01-04", "ABC", 100.0, 1000.0),
        _row("2021-01-08", "ABC", 104.0, 1000.0),
        _row("2021-01-11", "ABC", 80.0, 900.0),  # -23% on normal volume, no corporate action
        _row("2021-01-15", "ABC", 82.0, 900.0),
        _row("2021-01-22", "ABC", 85.0, 900.0),
    ]
    _write_daily_parquet(tmp_path / "daily.parquet", rows)

    legacy, legacy_events, _ = build_stock_weekly_prices(
        ["ABC"], stocks_data_dir=tmp_path, series_breaks="legacy"
    )
    frame, events, stale = build_stock_weekly_prices(["ABC"], stocks_data_dir=tmp_path)  # default

    assert len(legacy_events) == 1 and set(legacy.columns) == {"ABC", "ABC#2"}
    assert events.empty and list(frame.columns) == ["ABC"]
    assert stale == {}
    # The fall is a real fall, so a held position is valued at the real price, not frozen.
    assert frame.loc["2021-01-15", "ABC"] == pytest.approx(82.0)
    assert frame.loc["2021-01-22", "ABC"] == pytest.approx(85.0)


def test_series_breaks_rejects_an_unknown_policy(tmp_path):
    _write_daily_parquet(tmp_path / "daily.parquet", [_row("2021-01-04", "ABC", 100.0, 1000.0)])
    with pytest.raises(ValueError):
        build_stock_weekly_prices(["ABC"], stocks_data_dir=tmp_path, series_breaks="nope")
