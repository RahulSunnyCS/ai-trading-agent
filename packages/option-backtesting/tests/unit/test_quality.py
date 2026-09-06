"""
Quality gate tests. bar_gaps has a real regression case: the very first
90-day backfill run (see docs/epics/ once it lands) flagged every single
overnight boundary as a gap before this fix, because it compared consecutive
bars without checking they were on the same calendar date.
"""

from datetime import datetime, timedelta

from option_backtesting.data.providers.base import Bar, SessionFlag
from option_backtesting.data.quality import bar_gaps, identical_series, zero_volume_regular_bars


def _bar(ts: str, close: float = 100.0, volume: float = 1000.0) -> Bar:
    return Bar(
        ts=datetime.fromisoformat(ts),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=volume,
        session=SessionFlag.REGULAR,
    )


class TestBarGaps:
    def test_overnight_boundary_is_not_a_gap(self) -> None:
        bars = [
            _bar("2026-06-08T15:15:00"),
            _bar("2026-06-09T09:30:00"),  # next trading day, ~18h later
        ]
        assert bar_gaps(bars, timedelta(minutes=15)) == []

    def test_real_intraday_gap_is_flagged(self) -> None:
        bars = [
            _bar("2026-06-08T09:30:00"),
            _bar("2026-06-08T09:45:00"),
            _bar("2026-06-08T10:15:00"),  # missing the 10:00 bar
        ]
        flags = bar_gaps(bars, timedelta(minutes=15))
        assert len(flags) == 1
        assert flags[0].gate == "bar_gaps"

    def test_no_gap_when_bars_are_contiguous(self) -> None:
        bars = [_bar("2026-06-08T09:30:00"), _bar("2026-06-08T09:45:00")]
        assert bar_gaps(bars, timedelta(minutes=15)) == []


class TestIdenticalSeries:
    def test_flags_byte_identical_series(self) -> None:
        a = [_bar("2026-09-03T09:30:00", close=98.05), _bar("2026-09-03T09:45:00", close=82.5)]
        b = [_bar("2026-09-03T09:30:00", close=98.05), _bar("2026-09-03T09:45:00", close=82.5)]
        flags = identical_series("ATM PE", a, "OTM1 PE", b)
        assert len(flags) == 1
        assert flags[0].severity == "error"

    def test_does_not_flag_distinct_series(self) -> None:
        a = [_bar("2026-09-03T09:30:00", close=98.05)]
        b = [_bar("2026-09-03T09:30:00", close=95.0)]
        assert identical_series("ATM PE", a, "OTM1 PE", b) == []

    def test_no_shared_timestamps_is_not_flagged(self) -> None:
        a = [_bar("2026-09-03T09:30:00", close=98.05)]
        b = [_bar("2026-09-04T09:30:00", close=98.05)]
        assert identical_series("A", a, "B", b) == []


class TestZeroVolumeRegularBars:
    def test_flags_zero_volume_regular_bar(self) -> None:
        bars = [_bar("2026-06-08T09:30:00", volume=0)]
        flags = zero_volume_regular_bars(bars)
        assert len(flags) == 1
        assert flags[0].severity == "warning"

    def test_does_not_flag_nonzero_volume(self) -> None:
        bars = [_bar("2026-06-08T09:30:00", volume=1000)]
        assert zero_volume_regular_bars(bars) == []
