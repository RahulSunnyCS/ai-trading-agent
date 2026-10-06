from datetime import date, datetime, timedelta, timezone

import pytest
from trading_data import lake

from option_backtesting.fyers import history
from option_backtesting.fyers.client import Candle

IST = timezone(timedelta(hours=5, minutes=30))


def day_candles(day: date, n: int = 375, base: float = 100.0) -> list[Candle]:
    t0 = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    return [
        Candle(
            int((t0 + timedelta(minutes=i)).timestamp()), base, base + 1, base - 1, base, 0, None
        )
        for i in range(n)
    ]


class FakeClient:
    """Serves candles for weekdays on/after `first`, nothing before; counts calls."""

    def __init__(self, first: date, short: set[date] = frozenset()):
        self.calls, self.first, self.short = 0, first, short

    def minute_candles_range(self, symbol, start, end):
        self.calls += 1
        out = []
        d = max(start, self.first)
        while d <= end:
            if d.weekday() < 5:
                out += day_candles(d, 120 if d in self.short else 375)
            d += timedelta(days=1)
        return out


def test_chunks_are_newest_first_and_cover_the_range_exactly():
    chunks = history.chunk_ranges(date(2026, 1, 1), date(2026, 9, 30))
    assert chunks[0][1] == date(2026, 9, 30) and chunks[-1][0] == date(2026, 1, 1)
    assert all((hi - lo).days < history.CHUNK_DAYS for lo, hi in chunks)
    for (lo_a, _), (_, hi_b) in zip(chunks, chunks[1:], strict=False):
        assert hi_b == lo_a - timedelta(days=1)  # contiguous, no gap or overlap


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    return tmp_path


def test_backfill_writes_both_series_stops_at_the_start_and_resumes(root):
    first = date(2026, 6, 1)
    client = FakeClient(first, short={date(2026, 6, 3)})
    out = history.backfill_index(client, root, "NIFTY", end=date(2026, 9, 30), log=lambda _: None)
    days = lake.available_days(root, "index", "NIFTY")
    assert days[0] == first + timedelta(days=0 if first.weekday() < 5 else 7 - first.weekday())
    assert date(2026, 6, 3) not in days  # short day skipped, reported
    assert any("2026-06-03" in s for s in out["short_days"])
    assert lake.available_days(root, "index", "INDIAVIX") == days
    calls_first = client.calls

    again = FakeClient(first, short={date(2026, 6, 3)})
    out2 = history.backfill_index(again, root, "NIFTY", end=date(2026, 9, 30), log=lambda _: None)
    assert out2["written_days"] == {"NIFTY": 0, "INDIAVIX": 0}  # nothing rewritten
    assert again.calls == calls_first  # cheap: same requests, no writes


def test_unknown_history_stops_after_consecutive_empty_chunks(root):
    client = FakeClient(date(2026, 9, 1))
    history.backfill_index(client, root, "NIFTY", end=date(2026, 9, 30), log=lambda _: None)
    # 1 chunk with data + EMPTY_CHUNKS_TO_STOP empty ones, x2 series each — not a walk to 2015
    assert client.calls <= 2 * (1 + history.EMPTY_CHUNKS_TO_STOP)


def test_the_short_session_threshold_is_shared_with_data_quality():
    """Two definitions of 'too few bars to be a day' would let the backfill and the
    data_quality verdict disagree; there is one, in trading_data.quality."""
    from trading_data import quality

    from option_backtesting.fyers import history

    assert history.MIN_BARS is quality.MIN_BARS
