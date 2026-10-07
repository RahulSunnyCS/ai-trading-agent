"""T4 acceptance: TRI + equal-weight price benchmarks, the cash backfill, and the
session-set equality assertion (plan.md §1, QA F04/F06/F07).

No network: `fetch_tri`/`fetch_equal_weight_price` are exercised against a stubbed
`urllib.request.urlopen` that records the request it was given; `cash_weekly` is
exercised against a stubbed `amfi_nav` and `fetch.backfill`. The date-set-equality
check (F06) is instead proven against the real, committed raw fixtures under
data/stocks/raw/benchmarks/ — no network and no synthetic approximation needed
since the actual NSE responses are already on disk.
"""

import ast
import io
import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting import sources
from momentum_backtesting.sources import parse_niftyindices_tri
from momentum_backtesting.stocks import benchmarks

FIXTURES = Path(__file__).resolve().parents[2] / "data/stocks/raw/benchmarks"

#: `data/` is not tracked in git (it is rebuilt by `mbt stocks fetch`), so a clean checkout - CI
#: included - has no raw fixtures. The tests that read them skip there instead of failing.
needs_raw_fixtures = pytest.mark.skipif(
    not FIXTURES.exists(), reason="data/stocks/raw/benchmarks not present (run `mbt stocks fetch`)"
)


#: plan.md §1 recorded 3,900 sessions from 2011-01-03 when the raw files were first fetched;
#: every refresh adds sessions (BL-018), so that count is a floor, not an exact length.
FIRST_SESSION = pd.Timestamp("2011-01-03")
MIN_SESSIONS = 3900
#: Longest closure in the history: 2014-10-01 -> 2014-10-07 (Gandhi Jayanti, Dussehra and Bakri
#: Id around a weekend). A longer gap means a missing session, not a holiday.
MAX_SESSION_GAP = pd.Timedelta(days=6)


def _assert_full_session_history(index: pd.DatetimeIndex) -> None:
    """A gap-free daily session history from 2011-01-03, however recently it was refreshed.
    Weekends are allowed: NSE has held Saturday/Sunday sessions (Muhurat trading, budget days)."""
    assert index.is_unique and index.is_monotonic_increasing
    assert index[0] == FIRST_SESSION
    assert len(index) >= MIN_SESSIONS
    assert index.to_series().diff().max() <= MAX_SESSION_GAP


def _fake_urlopen(rows: list[dict], seen: list):
    def urlopen(request, timeout):
        seen.append(request)
        return io.BytesIO(json.dumps(rows).encode())

    return urlopen


def test_fetch_tri_hits_the_total_return_endpoint_with_the_right_index_name(monkeypatch):
    rows = [
        {
            "Index Name": "Nifty 50",
            "Date": "04 Jan 2016",
            "TotalReturnsIndex": "10000.00",
            "NTR_Value": "-",
        },
        {
            "Index Name": "Nifty 50",
            "Date": "05 Jan 2016",
            "TotalReturnsIndex": "10050.00",
            "NTR_Value": "-",
        },
    ]
    seen: list = []
    monkeypatch.setattr(sources.urllib.request, "urlopen", _fake_urlopen(rows, seen))
    monkeypatch.setattr(sources.time, "sleep", lambda _seconds: None)

    series = benchmarks.fetch_tri(benchmarks.NIFTY_50_TRI, date(2016, 1, 1), date(2016, 1, 31))

    assert len(seen) == 1
    request = seen[0]
    assert request.full_url == sources.NIFTYINDICES_TRI_URL
    body = json.loads(request.data)
    cinfo = ast.literal_eval(body["cinfo"])
    assert cinfo["name"] == "NIFTY 50"
    assert list(series.round(2)) == [10000.00, 10050.00]
    assert list(series.index.strftime("%Y-%m-%d")) == ["2016-01-04", "2016-01-05"]


def test_fetch_equal_weight_price_hits_the_existing_price_endpoint(monkeypatch):
    rows = [{"HistoricalDate": "04 Jan 2016", "CLOSE": "8135.08"}]
    seen: list = []
    monkeypatch.setattr(sources.urllib.request, "urlopen", _fake_urlopen(rows, seen))
    monkeypatch.setattr(sources.time, "sleep", lambda _seconds: None)

    series = benchmarks.fetch_equal_weight_price(date(2016, 1, 1), date(2016, 1, 31))

    assert len(seen) == 1
    assert seen[0].full_url == sources.NIFTYINDICES_URL
    body = json.loads(seen[0].data)
    cinfo = ast.literal_eval(body["cinfo"])
    assert cinfo["name"] == benchmarks.NIFTY_50_EQUAL_WEIGHT_PRICE
    assert series.iloc[0] == pytest.approx(8135.08)


def test_assert_same_session_set_passes_when_indices_match():
    idx = pd.to_datetime(["2016-01-04", "2016-01-05"])
    tri = pd.Series([1.0, 2.0], index=idx)
    price = pd.Series([3.0, 4.0], index=idx)
    benchmarks.assert_same_session_set(tri, price)  # must not raise


def test_assert_same_session_set_raises_on_mismatch():
    tri = pd.Series([1.0, 2.0], index=pd.to_datetime(["2016-01-04", "2016-01-05"]))
    price = pd.Series([3.0], index=pd.to_datetime(["2016-01-04"]))
    with pytest.raises(ValueError, match="session sets differ"):
        benchmarks.assert_same_session_set(tri, price)


@needs_raw_fixtures
def test_nifty_50_equal_weight_tri_and_price_share_an_identical_date_set():
    """QA F06, against the real raw fixtures (plan.md §1: "3,900 dates,
    identical date set to its TRI"). No network - both files are already on disk."""
    tri_rows = json.loads((FIXTURES / "NIFTY50_EQUAL_WEIGHT_TRI.json").read_text())
    tri_series = parse_niftyindices_tri(tri_rows)

    price_df = pd.read_csv(FIXTURES / "NIFTY50_EQUAL_WEIGHT_PRICE.csv", parse_dates=["date"])
    price_series = pd.Series(price_df["close"].to_numpy(), index=price_df["date"])

    benchmarks.assert_same_session_set(tri_series, price_series)  # must not raise
    _assert_full_session_history(tri_series.index)


@needs_raw_fixtures
def test_nifty_50_tri_and_nifty200_momentum_30_tri_fixtures_share_the_same_session_set():
    """The three TRI feeds (plan.md §1) share one session set."""
    n50 = parse_niftyindices_tri(json.loads((FIXTURES / "NIFTY_50_TRI.json").read_text()))
    momentum30 = parse_niftyindices_tri(
        json.loads((FIXTURES / "NIFTY200_MOMENTUM_30_TRI.json").read_text())
    )
    ew = parse_niftyindices_tri(
        json.loads((FIXTURES / "NIFTY50_EQUAL_WEIGHT_TRI.json").read_text())
    )
    assert n50.index.equals(momentum30.index)
    assert n50.index.equals(ew.index)
    _assert_full_session_history(n50.index)


def test_is_back_calculated_flags_dates_before_the_nifty200_momentum_30_launch():
    idx = pd.to_datetime(["2019-01-01", "2020-08-11", "2020-08-12"])
    flags = benchmarks.is_back_calculated(idx)
    assert list(flags) == [True, False, False]


def test_cash_weekly_delegates_to_backfill_and_resamples_to_weekly_closes(monkeypatch):
    direct = pd.Series([1.0], index=pd.to_datetime(["2013-01-04"]))
    regular = pd.Series([1.0], index=pd.to_datetime(["2011-01-03"]))
    seen_codes: list[str] = []

    def fake_amfi_nav(scheme_code, start):
        seen_codes.append(scheme_code)
        assert start == date(2011, 1, 1)
        if scheme_code == benchmarks.UTI_LIQUID_DIRECT_GROWTH_SCHEME_CODE:
            return direct
        if scheme_code == benchmarks.UTI_LIQUID_REGULAR_GROWTH_SCHEME_CODE:
            return regular
        raise AssertionError(f"unexpected scheme code {scheme_code!r}")

    # (2011-01-03 is a Monday, 2011-01-10 a Monday, 2013-01-04 a Friday) - exercises
    # `weekly`'s W-FRI resampling independent of `fetch.backfill`'s own join math,
    # which already has dedicated coverage in tests/test_data.py.
    combined = pd.Series(
        [10.0, 20.0, 30.0],
        index=pd.to_datetime(["2011-01-03", "2011-01-10", "2013-01-04"]),
    )

    def fake_backfill(primary, older):
        assert primary.equals(direct)
        assert older.equals(regular)
        return combined, 0.5

    monkeypatch.setattr(benchmarks, "amfi_nav", fake_amfi_nav)
    monkeypatch.setattr(benchmarks.fetch, "backfill", fake_backfill)

    weekly_series, ratio = benchmarks.cash_weekly(date(2011, 1, 1))

    assert ratio == 0.5
    assert set(seen_codes) == {
        benchmarks.UTI_LIQUID_DIRECT_GROWTH_SCHEME_CODE,
        benchmarks.UTI_LIQUID_REGULAR_GROWTH_SCHEME_CODE,
    }
    # `weekly` resamples every calendar week in range (leaving NaN gaps where there's
    # no underlying data, same as every other consumer of `sources.weekly`) - drop
    # those gap weeks to check just the three weeks that carry real values.
    non_empty = weekly_series.dropna()
    assert list(non_empty.index.strftime("%Y-%m-%d")) == [
        "2011-01-07",
        "2011-01-14",
        "2013-01-04",
    ]
    assert list(non_empty) == [10.0, 20.0, 30.0]


def test_cash_weekly_uses_the_verified_regular_plan_scheme_code():
    # mfapi.in/mf/search?q=UTI Liquid Fund Growth -> 102012 "UTI - Liquid Fund - Regular
    # Plan - Growth" is the only Regular-plan Growth scheme whose NAV history reaches
    # back before 2011 (verified live during T4; see benchmarks.py's docstring).
    assert benchmarks.UTI_LIQUID_REGULAR_GROWTH_SCHEME_CODE == "102012"
    assert benchmarks.UTI_LIQUID_DIRECT_GROWTH_SCHEME_CODE == "120304"
