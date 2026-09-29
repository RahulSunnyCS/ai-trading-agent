"""T7: the dividend verifier (plan.md §4.1, QA F13) and the Yahoo adjclose
cross-check (plan.md §4.3, QA N03).

Unit tests run on small synthetic fixtures built here (no files, no network) --
`dividend_check`'s math is exact on a two-company toy index, so the fixtures below
construct `tri_index`/`price_index` directly from the same weighted-average return
formula the function reconstructs, rather than random data, so expected residuals
are known exactly.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.stocks import validate
from momentum_backtesting.stocks.schemas import CURATED_HEADERS

# --------------------------------------------------------------------------
# Synthetic two-company fixture
# --------------------------------------------------------------------------

_START = "2011-01-03"  # before EW_LAUNCH_DATE (2017-04-13) -> exercises back-calc tagging
_SESSIONS = pd.bdate_range(_START, periods=12)


def _membership(companies: tuple[str, ...] = ("C0001", "C0002")) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "company_id": list(companies),
            "symbol": [f"SYM{c[-1]}" for c in companies],
            "from": [_START] * len(companies),
            "to": [""] * len(companies),
            "kind": ["investable"] * len(companies),
            "source": ["test"] * len(companies),
            "source2": [""] * len(companies),
        }
    )


def _daily(closes: dict[str, pd.Series]) -> pd.DataFrame:
    """closes: symbol -> Series of close prices indexed by _SESSIONS (flat 100 by
    default; callers pass overrides for the sessions they want to move)."""
    rows = []
    for symbol, series in closes.items():
        prevclose = series.shift(1).bfill()
        for day, close, prev in zip(series.index, series, prevclose, strict=True):
            rows.append(
                {
                    "date": day.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "close": float(close),
                    "prevclose": float(prev),
                }
            )
    return pd.DataFrame(rows)


def _flat_two_company_daily(overrides: dict[tuple[str, int], float] | None = None):
    """Two companies (SYM1, SYM2), each flat at 100 across _SESSIONS, with optional
    (symbol, session_index) -> close overrides."""
    overrides = overrides or {}
    closes = {}
    for symbol in ("SYM1", "SYM2"):
        series = pd.Series(100.0, index=_SESSIONS)
        for (sym, i), value in overrides.items():
            if sym == symbol:
                series.iloc[i] = value
        closes[symbol] = series
    return _daily(closes)


def _weighted_indices(daily: pd.DataFrame, dividend_day_idx: int, dividend: float) -> tuple[
    pd.Series, pd.Series
]:
    """Build tri_index/price_index for the two-company 50/50 basket directly from
    `daily`'s close/prevclose, so the expected spread is known exactly: on the
    dividend day, price return reflects the raw close drop, tri_index instead
    reinvests the dividend (chained return uses (close + dividend) / prevclose for
    the paying company), giving observed_spread_bp == 0.5 * dividend / prevclose *
    1e4 by construction.
    """
    piv_close = daily.pivot(index="date", columns="symbol", values="close")
    piv_prev = daily.pivot(index="date", columns="symbol", values="prevclose")
    piv_close.index = pd.to_datetime(piv_close.index)
    piv_prev.index = pd.to_datetime(piv_prev.index)
    piv_close = piv_close.reindex(_SESSIONS)
    piv_prev = piv_prev.reindex(_SESSIONS)

    price_growth = piv_close / piv_prev
    tr_growth = price_growth.copy()
    div_day = _SESSIONS[dividend_day_idx]
    if dividend:
        tr_growth.loc[div_day, "SYM1"] = (
            piv_close.loc[div_day, "SYM1"] + dividend
        ) / piv_prev.loc[div_day, "SYM1"]

    price_index = (0.5 * price_growth).sum(axis=1).cumprod() * 100.0
    tri_index = (0.5 * tr_growth).sum(axis=1).cumprod() * 100.0
    price_index.iloc[0] = 100.0
    tri_index.iloc[0] = 100.0
    return tri_index, price_index


def _events(rows: list[dict]) -> pd.DataFrame:
    cols = [
        "company_id",
        "symbol_at_ex",
        "session",
        "ex_date",
        "kind",
        "factor",
        "dividend",
        "source",
        "subject_sha1",
    ]
    if not rows:
        return pd.DataFrame(columns=cols)
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df:
            df[c] = np.nan
    return df[cols]


# --------------------------------------------------------------------------
# Dividend verifier
# --------------------------------------------------------------------------


def test_dividend_check_matches_expected_on_a_clean_dividend_day():
    """SYM1 pays a 5-rupee dividend (5% of its 100 close) on session 5; the
    reconstructed weight is 0.5 (two equal members, no rebalance in the window), so
    expected_spread_bp should equal observed_spread_bp to within floating-point
    noise, and the day should pass."""
    daily = _flat_two_company_daily({("SYM1", 5): 95.0})
    tri, price = _weighted_indices(daily, dividend_day_idx=5, dividend=5.0)
    events = _events(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "SYM1",
                "session": _SESSIONS[5].strftime("%Y-%m-%d"),
                "ex_date": _SESSIONS[5].strftime("%Y-%m-%d"),
                "kind": "dividend",
                "dividend": 5.0,
                "source": "feed",
                "subject_sha1": "x",
            }
        ]
    )
    membership = _membership()

    result = validate.dividend_check(tri, price, events, membership, daily)

    day_row = result[result["date"] == _SESSIONS[5]].iloc[0]
    assert day_row["verdict"] == "pass"
    assert day_row["expected_spread_bp"] == pytest.approx(day_row["observed_spread_bp"], abs=0.05)
    assert day_row["expected_spread_bp"] == pytest.approx(0.5 * 5.0 / 100.0 * 1e4, rel=1e-6)


def test_dividend_check_flags_when_the_dividend_event_is_removed_from_the_fixture():
    """QA F13: removing the dividend event from `events` (but leaving the actual
    price move in `daily`/the indices unchanged) must flag that date -- expected
    drops to 0 while the observed TRI-vs-price spread is unchanged, so the residual
    exceeds the ex-date floor."""
    daily = _flat_two_company_daily({("SYM1", 5): 95.0})
    tri, price = _weighted_indices(daily, dividend_day_idx=5, dividend=5.0)
    membership = _membership()

    with_event = validate.dividend_check(
        tri,
        price,
        _events(
            [
                {
                    "company_id": "C0001",
                    "symbol_at_ex": "SYM1",
                    "session": _SESSIONS[5].strftime("%Y-%m-%d"),
                    "ex_date": _SESSIONS[5].strftime("%Y-%m-%d"),
                    "kind": "dividend",
                    "dividend": 5.0,
                    "source": "feed",
                    "subject_sha1": "x",
                }
            ]
        ),
        membership,
        daily,
    )
    assert with_event[with_event["date"] == _SESSIONS[5]].iloc[0]["verdict"] == "pass"

    without_event = validate.dividend_check(tri, price, _events([]), membership, daily)
    removed_row = without_event[without_event["date"] == _SESSIONS[5]].iloc[0]
    assert removed_row["verdict"] == "flag"
    assert removed_row["expected_spread_bp"] == pytest.approx(0.0)


def test_dividend_check_no_event_day_uses_the_tight_no_event_floor():
    """A day with no dividend event at all: a sub-floor spread (rounding noise)
    passes; anything above the 0.3bp floor flags even though there is no event to
    compare against (nothing explains the spread)."""
    daily = _flat_two_company_daily()
    tri = pd.Series(100.0, index=_SESSIONS)
    price = pd.Series(100.0, index=_SESSIONS)
    # A tiny bit of unexplained drift on session 4 -- under the 0.3bp floor.
    tri.iloc[4] = 100.0 * (1 + 0.29e-4)
    # A larger unexplained jump on session 6 -- over the floor, no event -> flag.
    tri.iloc[6] = 100.0 * (1 + 5e-4)

    result = validate.dividend_check(tri, price, _events([]), _membership(), daily)

    assert result[result["date"] == _SESSIONS[4]].iloc[0]["verdict"] == "pass"
    assert result[result["date"] == _SESSIONS[6]].iloc[0]["verdict"] == "flag"


def test_dividend_check_exempts_and_tags_a_special_dividend():
    """A dividend above 10% of the prior close is exempt from the expected sum (NSE
    divisor-adjusts these) but still tagged for review; constructing the indices so
    the actual spread is small on that day (mirroring NSE's own divisor adjustment)
    should still pass since the day is excluded from ex-date scoring."""
    daily = _flat_two_company_daily({("SYM1", 5): 85.0})  # 15-rupee dividend, 15% of 100
    tri = pd.Series(100.0, index=_SESSIONS)
    price = pd.Series(100.0, index=_SESSIONS)  # both legs flat: mirrors NSE's divisor adjustment
    events = _events(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "SYM1",
                "session": _SESSIONS[5].strftime("%Y-%m-%d"),
                "ex_date": _SESSIONS[5].strftime("%Y-%m-%d"),
                "kind": "dividend",
                "dividend": 15.0,
                "source": "feed",
                "subject_sha1": "x",
            }
        ]
    )

    result = validate.dividend_check(tri, price, events, _membership(), daily)

    day_row = result[result["date"] == _SESSIONS[5]].iloc[0]
    assert "special-dividend-exempt" in day_row["tag"]
    assert day_row["expected_spread_bp"] == pytest.approx(0.0)
    assert day_row["verdict"] == "pass"


def test_dividend_check_tags_sessions_before_the_ew_launch_date_as_back_calc():
    daily = _flat_two_company_daily()
    tri = pd.Series(100.0, index=_SESSIONS)
    price = pd.Series(100.0, index=_SESSIONS)

    result = validate.dividend_check(tri, price, _events([]), _membership(), daily)

    # _SESSIONS starts 2011-01-03, well before EW_LAUNCH_DATE (2017-04-13).
    assert (result["tag"] == "back-calc").all()


def test_dividend_check_flags_a_whole_year_on_yearly_imbalance():
    """Two dividend-paying years, built independently of the module-level
    `_SESSIONS` fixture: year 2018's event is correctly recorded (its observed and
    expected spreads match), year 2019's identical event is left out of `events`
    entirely -- only 2019 should show year-imbalance tags."""
    sessions = pd.bdate_range("2018-06-01", periods=8).append(
        pd.bdate_range("2019-06-03", periods=8)
    )
    daily = pd.concat(
        [
            _daily(
                {
                    "SYM1": pd.Series(100.0, index=sessions).where(
                        ~sessions.isin([sessions[3], sessions[11]]), 95.0
                    ),
                    "SYM2": pd.Series(100.0, index=sessions),
                }
            )
        ],
        ignore_index=True,
    )

    piv_close = daily.pivot(index="date", columns="symbol", values="close")
    piv_prev = daily.pivot(index="date", columns="symbol", values="prevclose")
    piv_close.index = pd.to_datetime(piv_close.index)
    piv_prev.index = pd.to_datetime(piv_prev.index)
    piv_close, piv_prev = piv_close.reindex(sessions), piv_prev.reindex(sessions)

    price_growth = piv_close / piv_prev
    tr_growth = price_growth.copy()
    # Reinvest the dividend only for the 2018 ex-day (session 3) -- 2019's identical
    # price move (session 11) is left un-reinvested in the TRI, as if the dividend
    # that caused it were simply never recorded downstream.
    tr_growth.loc[sessions[3], "SYM1"] = (piv_close.loc[sessions[3], "SYM1"] + 5.0) / piv_prev.loc[
        sessions[3], "SYM1"
    ]
    tr_growth.loc[sessions[11], "SYM1"] = (
        piv_close.loc[sessions[11], "SYM1"] + 5.0
    ) / piv_prev.loc[sessions[11], "SYM1"]

    price_index = (0.5 * price_growth).sum(axis=1).cumprod() * 100.0
    tri_index = (0.5 * tr_growth).sum(axis=1).cumprod() * 100.0
    price_index.iloc[0], tri_index.iloc[0] = 100.0, 100.0

    events = _events(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "SYM1",
                "session": sessions[3].strftime("%Y-%m-%d"),
                "ex_date": sessions[3].strftime("%Y-%m-%d"),
                "kind": "dividend",
                "dividend": 5.0,
                "source": "feed",
                "subject_sha1": "x",
            }
        ]
    )
    membership = pd.DataFrame(
        {
            "company_id": ["C0001", "C0002"],
            "symbol": ["SYM1", "SYM2"],
            "from": [sessions[0].strftime("%Y-%m-%d")] * 2,
            "to": ["", ""],
            "kind": ["investable", "investable"],
            "source": ["test", "test"],
            "source2": ["", ""],
        }
    )

    result = validate.dividend_check(tri_index, price_index, events, membership, daily)

    year_2018 = result[result["date"].dt.year == 2018]
    year_2019 = result[result["date"].dt.year == 2019]
    assert not year_2018["tag"].str.contains("year-imbalance").any()
    assert year_2019["tag"].str.contains("year-imbalance").any()


def test_dividend_check_rejects_mismatched_tri_and_price_indices():
    daily = _flat_two_company_daily()
    tri = pd.Series(100.0, index=_SESSIONS)
    price = pd.Series(100.0, index=_SESSIONS[:-1])  # one date short
    with pytest.raises(ValueError, match="identical date index"):
        validate.dividend_check(tri, price, _events([]), _membership(), daily)


# --------------------------------------------------------------------------
# Yahoo adjclose cross-check (deferrable, QA N03)
# --------------------------------------------------------------------------


def _yahoo_membership() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "company_id": ["C0001"],
            "symbol": ["SYM1"],
            "from": [_START],
            "to": [""],
            "kind": ["investable"],
            "source": ["test"],
            "source2": [""],
        }
    )


def _yahoo_exceptions_empty() -> pd.DataFrame:
    return pd.DataFrame(columns=list(CURATED_HEADERS["yahoo_exceptions.csv"]))


def test_yahoo_adjclose_check_never_raises_when_yahoo_is_unreachable(monkeypatch):
    """QA N03 / the T7 brief: a blocked or rate-limited Yahoo must degrade to a
    skip row, never raise and never fail the run."""

    def _boom(symbol, start):
        raise RuntimeError("HTTP 429: rate limited")

    monkeypatch.setattr("momentum_backtesting.sources.yahoo_daily", _boom)

    daily = _flat_two_company_daily()
    result = validate.yahoo_adjclose_check(daily, _yahoo_membership(), _yahoo_exceptions_empty())

    assert not result.empty
    assert (result["verdict"] == "skip").all()
    assert result.iloc[0]["skip_reason"]


def test_yahoo_adjclose_check_flags_a_large_residual_and_reuses_exceptions(monkeypatch):
    daily = _flat_two_company_daily()

    def _fake_yahoo_daily(symbol, start):
        # A materially different series from `daily`'s flat 100 -> large residuals.
        idx = pd.date_range(_SESSIONS.min(), _SESSIONS.max(), freq="D")
        return pd.Series(np.linspace(100.0, 90.0, len(idx)), index=idx)

    monkeypatch.setattr("momentum_backtesting.sources.yahoo_daily", _fake_yahoo_daily)

    flagged = validate.yahoo_adjclose_check(daily, _yahoo_membership(), _yahoo_exceptions_empty())
    assert (flagged["verdict"] == "flag").any()

    exceptions = pd.DataFrame(
        {
            "company_id": ["C0001"],
            "symbol": ["SYM1"],
            "reason": ["known Yahoo gap"],
            "source": ["t"],
        }
    )
    reviewed = validate.yahoo_adjclose_check(daily, _yahoo_membership(), exceptions)
    assert (reviewed["verdict"] == "reviewed").all()
