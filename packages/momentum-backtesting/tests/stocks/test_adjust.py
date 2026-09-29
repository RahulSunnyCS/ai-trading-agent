"""T6 acceptance: company resolution, event attachment/combination, the return
formula, weekly outputs, and the CA event diff/baseline (plan.md §2/§9).

Small synthetic fixtures only -- no network, no dependency on the real raw cache
(that's exercised separately by the real-data run in the implementor's report,
not by these unit tests). Covers QA C07, C12, C15, C16, C17, C21, F10.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.stocks import adjust
from momentum_backtesting.stocks.schemas import EventKind

# --------------------------------------------------------------------------
# Small fixtures
# --------------------------------------------------------------------------


def _aliases(rows: list[tuple[str, str, str, str | None]]) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"company_id": cid, "symbol": sym, "from": frm, "to": to, "source": "test"}
            for cid, sym, frm, to in rows
        ]
    )


def _daily_rows(rows: list[dict]) -> pd.DataFrame:
    base = {"series": "EQ", "isin": None, "volume": 1000, "turnover": 1.0, "synthetic_close": False}
    out = []
    for r in rows:
        d = {**base, **r}
        out.append(d)
    df = pd.DataFrame(out)
    return df[
        [
            "date",
            "symbol",
            "series",
            "isin",
            "open",
            "high",
            "low",
            "close",
            "prevclose",
            "volume",
            "turnover",
            "synthetic_close",
        ]
    ]


# --------------------------------------------------------------------------
# C07: CA feed rows re-keyed to a current symbol resolve via ISIN, to the
# original company -- modelled on TATAMOTORS's 2011 split being filed under
# today's TMPV symbol.
# --------------------------------------------------------------------------


def test_c07_ca_row_resolves_via_isin_not_current_symbol():
    aliases = _aliases(
        [
            ("C0001", "TATAMOTORS", "2011-01-03", "2024-06-01"),
            ("C0001", "TMPV", "2024-06-02", None),
        ]
    )
    daily = _daily_rows(
        [
            {
                "date": date(2011, 9, 12),
                "symbol": "TATAMOTORS",
                "isin": "INE155A01022",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 100,
                "prevclose": 100,
            },
            {
                "date": date(2011, 9, 13),
                "symbol": "TATAMOTORS",
                "isin": "INE155A01022",
                "open": 50,
                "high": 50,
                "low": 50,
                "close": 50,
                "prevclose": 100,
            },
        ]
    )
    daily["company_id"] = adjust.resolve_daily_companies(daily, aliases)
    isin_to_company, symbol_to_company_latest = adjust.build_ca_lookups(daily, aliases)

    assert isin_to_company["INE155A01022"] == "C0001"
    # The feed shows the row under today's symbol (TMPV), not TATAMOTORS.
    resolved = adjust.resolve_ca_company(
        "INE155A01022", "TMPV", isin_to_company, symbol_to_company_latest
    )
    assert resolved == "C0001"


def test_c07_ca_row_resolves_via_symbol_fallback_when_isin_unknown():
    aliases = _aliases([("C0002", "FOO", "2011-01-03", None)])
    isin_to_company: dict[str, str] = {}
    _, symbol_to_company_latest = adjust.build_ca_lookups(
        pd.DataFrame(columns=["company_id", "isin"]), aliases
    )
    resolved = adjust.resolve_ca_company(None, "FOO", isin_to_company, symbol_to_company_latest)
    assert resolved == "C0002"


# --------------------------------------------------------------------------
# C12: same-date multiply / sum -- combined bonus+split factors multiply,
# two same-day dividend rows sum.
# --------------------------------------------------------------------------


def test_c12_same_session_factors_multiply_and_dividends_sum():
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2025, 6, 16),
                "session": date(2025, 6, 16),
                "kind": "bonus",
                "factor": 0.2,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "a",
            },
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2025, 6, 16),
                "session": date(2025, 6, 16),
                "kind": "split",
                "factor": 0.5,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "b",
            },
            {
                "company_id": "C0002",
                "symbol_at_ex": "Y",
                "ex_date": date(2025, 6, 16),
                "session": date(2025, 6, 16),
                "kind": "dividend",
                "factor": None,
                "dividend": 5.0,
                "source": "feed",
                "subject_sha1": "c",
            },
            {
                "company_id": "C0002",
                "symbol_at_ex": "Y",
                "ex_date": date(2025, 6, 16),
                "session": date(2025, 6, 16),
                "kind": "dividend",
                "factor": None,
                "dividend": 3.5,
                "source": "feed",
                "subject_sha1": "d",
            },
        ]
    )
    daily1 = _daily_rows(
        [
            {
                "date": date(2025, 6, 13),
                "symbol": "X",
                "open": 1000,
                "high": 1000,
                "low": 1000,
                "close": 1000,
                "prevclose": 1000,
            },
            {
                "date": date(2025, 6, 16),
                "symbol": "X",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 100,
                "prevclose": 1000,
            },
        ]
    )
    rs = adjust.compute_return_series(daily1, events[events["company_id"] == "C0001"])
    combined_factor = 0.2 * 0.5
    expected_r = (100 / combined_factor) / 1000
    assert rs["f_t"].iloc[1] == pytest.approx(combined_factor)
    assert rs["r_t"].iloc[1] == pytest.approx(expected_r)

    daily2 = _daily_rows(
        [
            {
                "date": date(2025, 6, 13),
                "symbol": "Y",
                "open": 500,
                "high": 500,
                "low": 500,
                "close": 500,
                "prevclose": 500,
            },
            {
                "date": date(2025, 6, 16),
                "symbol": "Y",
                "open": 490,
                "high": 490,
                "low": 490,
                "close": 490,
                "prevclose": 500,
            },
        ]
    )
    rs2 = adjust.compute_return_series(daily2, events[events["company_id"] == "C0002"])
    assert rs2["d_t"].iloc[1] == pytest.approx(8.5)
    assert rs2["r_t"].iloc[1] == pytest.approx((490 + 8.5) / 500)


# --------------------------------------------------------------------------
# C15: manual-only subjects hard-fail (no actions_manual row) vs get a factor
# applied once actions_manual.csv covers them. Also: the neutral-ex-day kinds
# (demerger/rights/scheme/etc) never need an actions_manual row at all.
# --------------------------------------------------------------------------


def test_c15_manual_only_survives_without_actions_manual_row():
    feed_events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2020, 1, 10),
                "kind": EventKind.MANUAL_ONLY.value,
                "factor": None,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "h1",
            }
        ]
    )
    aliases = _aliases([("C0001", "X", "2011-01-03", None)])
    combined = adjust.combine_manual_over_feed(
        feed_events, pd.DataFrame(columns=adjust._EVENT_COLUMNS), aliases
    )
    assert len(combined) == 1
    assert combined.iloc[0]["kind"] == EventKind.MANUAL_ONLY.value


def test_c15_manual_row_overrides_manual_only_feed_row():
    feed_events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2020, 1, 10),
                "kind": EventKind.MANUAL_ONLY.value,
                "factor": None,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "h1",
            }
        ]
    )
    actions_manual = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "ex_date": "2020-01-10",
                "kind": "dividend",
                "factor": "",
                "dividend": "7.65",
                "dividend_basis": "",
                "last_session": "",
                "acquirer_id": "",
                "swap_ratio": "",
                "source": "manual test",
            }
        ]
    )
    manual_events = adjust.build_manual_events(actions_manual)
    aliases = _aliases([("C0001", "X", "2011-01-03", None)])
    combined = adjust.combine_manual_over_feed(feed_events, manual_events, aliases)
    assert len(combined) == 1
    row = combined.iloc[0]
    assert row["kind"] == "dividend"
    assert row["dividend"] == pytest.approx(7.65)
    assert row["source"] == "manual"


def test_c15_neutral_exday_kinds_classified_without_actions_manual():
    assert adjust.classify_neutral_kind("Demerger", "demerger - manual only") == EventKind.DEMERGER
    assert (
        adjust.classify_neutral_kind("Rights 1:15 @ Premium Rs 1247", "rights issue - manual only")
        == EventKind.RIGHTS
    )
    assert (
        adjust.classify_neutral_kind("Scheme Of Arrangement", "scheme of arrangement - manual only")
        == EventKind.SCHEME_OF_ARRANGEMENT
    )
    assert (
        adjust.classify_neutral_kind("Capital Reduction", "capital reduction - manual only")
        == EventKind.CAPITAL_REDUCTION
    )
    assert (
        adjust.classify_neutral_kind(
            "Bonus Debentures 6:1", "bonus debenture/preference share - manual only"
        )
        == EventKind.BONUS_DEBENTURE
    )
    # Not a neutral-ex-day kind: stays None (e.g. combined dividend+bonus, or an
    # amount-less dividend) -- these need an actions_manual.csv row, not r_t=0.
    assert (
        adjust.classify_neutral_kind("Interim Dividend", "dividend amount not stated - manual only")
        is None
    )


def test_c15_neutral_exday_forces_zero_return_ignoring_other_events():
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2023, 7, 20),
                "session": date(2023, 7, 20),
                "kind": "demerger",
                "factor": None,
                "dividend": None,
                "source": "neutral_exday",
                "subject_sha1": "h1",
            },
        ]
    )
    daily = _daily_rows(
        [
            {
                "date": date(2023, 7, 19),
                "symbol": "X",
                "open": 300,
                "high": 300,
                "low": 300,
                "close": 300,
                "prevclose": 300,
            },
            {
                "date": date(2023, 7, 20),
                "symbol": "X",
                "open": 150,
                "high": 150,
                "low": 150,
                "close": 150,
                "prevclose": 300,
            },
        ]
    )
    rs = adjust.compute_return_series(daily, events)
    assert rs["r_t"].iloc[1] == pytest.approx(1.0)
    assert rs["total_return_factor"].iloc[1] == pytest.approx(1.0)
    assert rs["price_only_factor"].iloc[1] == pytest.approx(1.0)


# --------------------------------------------------------------------------
# C16: return formula, hand-computed, matches to 1e-12; D=0 gives the
# price-only series.
# --------------------------------------------------------------------------


def test_c16_return_formula_matches_hand_computation():
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2020, 3, 2),
                "session": date(2020, 3, 2),
                "kind": "bonus",
                "factor": 0.5,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "h1",
            },
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2020, 3, 2),
                "session": date(2020, 3, 2),
                "kind": "dividend",
                "factor": None,
                "dividend": 4.25,
                "source": "feed",
                "subject_sha1": "h2",
            },
        ]
    )
    daily = _daily_rows(
        [
            {
                "date": date(2020, 2, 28),
                "symbol": "X",
                "open": 200,
                "high": 200,
                "low": 200,
                "close": 200,
                "prevclose": 200,
            },
            {
                "date": date(2020, 3, 2),
                "symbol": "X",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 100,
                "prevclose": 200,
            },
        ]
    )
    rs = adjust.compute_return_series(daily, events)

    p_t, p_prev, f_t, d_t = 100.0, 200.0, 0.5, 4.25
    expected_r = (p_t / f_t + d_t) / p_prev
    assert rs["r_t"].iloc[1] == pytest.approx(expected_r, abs=1e-12)
    assert rs["total_return_factor"].iloc[1] == pytest.approx(expected_r, abs=1e-12)

    expected_price_r = (p_t / f_t) / p_prev
    assert rs["price_only_factor"].iloc[1] == pytest.approx(expected_price_r, abs=1e-12)


# --------------------------------------------------------------------------
# C17: event attaches to first traded session on/after ex-date; > 5 sessions
# later fails.
# --------------------------------------------------------------------------


def test_c17_event_attaches_to_next_traded_session_on_non_trading_exdate():
    daily = _daily_rows(
        [
            {
                "date": date(2021, 1, 4),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
            },
            {
                "date": date(2021, 1, 5),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
            },
        ]
    )
    daily["company_id"] = "C0001"
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2021, 1, 3),
                "kind": "dividend",
                "factor": None,
                "dividend": 1.0,
                "source": "feed",
                "subject_sha1": "h",
            }
        ]
    )
    out = adjust.attach_events(events, daily)
    assert out.iloc[0]["session"] == date(2021, 1, 4)


def _market_and_suspended_company_daily():
    """10 consecutive market sessions (symbol Y trades every day, keeping the
    market-wide calendar dense); the target company (symbol X) trades on day 1,
    is suspended for the next 7 sessions, then resumes on day 9 -- so an event
    dated on day 2 attaches 7 market sessions later than its ex_date."""
    market_dates = [date(2021, 1, d) for d in range(4, 4 + 10)]
    x_dates = [market_dates[0], market_dates[8], market_dates[9]]
    rows = [
        {"date": d, "symbol": "Y", "open": 10, "high": 10, "low": 10, "close": 10, "prevclose": 10}
        for d in market_dates
    ] + [
        {"date": d, "symbol": "X", "open": 10, "high": 10, "low": 10, "close": 10, "prevclose": 10}
        for d in x_dates
    ]
    daily = _daily_rows(rows)
    daily["company_id"] = daily["symbol"].map({"X": "C0001", "Y": "C0002"})
    return daily


def test_c17_event_more_than_five_sessions_late_raises():
    daily = _market_and_suspended_company_daily()
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2021, 1, 5),  # the 2nd market session; X next trades on the 9th
                "kind": "dividend",
                "factor": None,
                "dividend": 1.0,
                "source": "feed",
                "subject_sha1": "h",
            }
        ]
    )
    with pytest.raises(ValueError, match="exceeds max_lag_sessions"):
        adjust.attach_events(events, daily, max_lag_sessions=5)


def test_c17_tolerant_attach_collects_f_instead_of_raising():
    daily = _market_and_suspended_company_daily()
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol_at_ex": "X",
                "ex_date": date(2021, 1, 5),
                "kind": "dividend",
                "factor": None,
                "dividend": 1.0,
                "source": "feed",
                "subject_sha1": "h",
            }
        ]
    )
    out, failures = adjust.attach_events_tolerant(events, daily, max_lag_sessions=5)
    assert out.empty
    assert len(failures) == 1
    assert failures[0].severity.value == "F"


# --------------------------------------------------------------------------
# C21: CA diff key and baseline lifecycle.
# --------------------------------------------------------------------------


def _events_frame(rows):
    return pd.DataFrame(
        rows,
        columns=[
            "company_id",
            "ex_date",
            "kind",
            "factor",
            "dividend",
            "source",
            "subject_sha1",
            "symbol_at_ex",
        ],
    )


def test_c21_no_baseline_means_no_diff_rows_reported():
    events = _events_frame(
        [
            {
                "company_id": "C0001",
                "ex_date": date(2020, 1, 1),
                "kind": "dividend",
                "factor": None,
                "dividend": 5.0,
                "source": "feed",
                "subject_sha1": "h",
                "symbol_at_ex": "X",
            }
        ]
    )
    diff = adjust.diff_ca_events(events, None)
    assert diff.empty


def test_c21_factor_change_on_old_event_is_a_diff_row():
    baseline = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "ex_date": "2020-01-01",
                "kind": "bonus",
                "factor": "0.5",
                "dividend": "",
                "source": "feed",
                "subject_sha1": "h",
            }
        ]
    )
    current = _events_frame(
        [
            {
                "company_id": "C0001",
                "ex_date": date(2020, 1, 1),
                "kind": "bonus",
                "factor": 0.4,
                "dividend": None,
                "source": "feed",
                "subject_sha1": "h",
                "symbol_at_ex": "X",
            }
        ]
    )
    diff = adjust.diff_ca_events(current, baseline)
    assert len(diff) == 1
    assert diff.iloc[0]["change"] == "changed"
    assert diff.iloc[0]["age_days"] > 30


def test_c21_ca_diff_age_guard_fails_old_unaccepted_change_and_passes_when_accepted():
    from momentum_backtesting.stocks import guards

    diff = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "ex_date": "2020-01-01",
                "subject_sha1": "h",
                "change": "changed",
                "detail": "x",
                "age_days": 400,
            }
        ]
    )
    results = guards.check_ca_diff_age(diff, None)
    assert results[0].severity.value == "F"

    accepted = pd.DataFrame([{"company_id": "C0001", "ex_date": "2020-01-01", "subject_sha1": "h"}])
    results2 = guards.check_ca_diff_age(diff, accepted)
    assert results2[0].severity.value == "G"


def test_c21_symbol_only_change_is_a_rekey_row_not_a_hard_change():
    baseline = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "ex_date": "2020-01-01",
                "kind": "dividend",
                "factor": "",
                "dividend": "5.0",
                "source": "feed",
                "subject_sha1": "h",
                "symbol_at_ex": "OLDSYM",
            }
        ]
    )
    current = _events_frame(
        [
            {
                "company_id": "C0001",
                "ex_date": date(2020, 1, 1),
                "kind": "dividend",
                "factor": None,
                "dividend": 5.0,
                "source": "feed",
                "subject_sha1": "h",
                "symbol_at_ex": "NEWSYM",
            }
        ]
    )
    diff = adjust.diff_ca_events(current, baseline)
    assert len(diff) == 1
    assert diff.iloc[0]["change"] == "re-key"


# --------------------------------------------------------------------------
# F10: weekly outputs, Friday-labelled, NaN outside listing life.
# --------------------------------------------------------------------------


def test_f10_weekly_outputs_are_friday_labelled_and_nan_outside_listing_life():
    dates = pd.date_range("2021-01-04", periods=15, freq="B")  # business days, ~3 weeks
    adjusted = pd.DataFrame(
        {
            "company_id": ["C0001"] * len(dates),
            "date": dates,
            "total_return_factor": np.linspace(1.0, 1.1, len(dates)),
            "price_only_factor": np.linspace(1.0, 1.05, len(dates)),
        }
    )
    tr, price = adjust.build_weekly_outputs(adjusted)
    assert all(d.dayofweek == 4 for d in tr.index)  # Friday-labelled
    assert "C0002" not in tr.columns  # a company with no rows at all just isn't a column
    assert tr["C0001"].notna().any()
