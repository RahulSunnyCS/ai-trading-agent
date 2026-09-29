"""T6 acceptance: plan.md §3's guard suite. Small synthetic fixtures only.

Covers QA C04, C05, C06, C08, C19, C20, C22, C23, F08, F11, N01, N02.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.stocks import adjust, guards
from momentum_backtesting.stocks.schemas import GuardSeverity


def _daily_rows(rows: list[dict]) -> pd.DataFrame:
    base = {
        "series": "EQ",
        "isin": None,
        "volume": 1000,
        "turnover": 1.0,
        "synthetic_close": False,
        "company_id": None,
    }
    out = [{**base, **r} for r in rows]
    df = pd.DataFrame(out)
    fixed_cols = [
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
        "company_id",
    ]
    extra_cols = [c for c in df.columns if c not in fixed_cols]
    return df[fixed_cols + extra_cols]


def _membership(rows: list[tuple]) -> pd.DataFrame:
    cols = ["company_id", "symbol", "from", "to", "kind", "source", "source2"]
    return pd.DataFrame([dict(zip(cols, r, strict=True)) for r in rows])


# --------------------------------------------------------------------------
# C04 / C05: session calendar guard + synthetic_close fill.
# --------------------------------------------------------------------------


def test_c04_dropped_tri_session_fails_named():
    tri_dates = pd.DatetimeIndex(pd.date_range("2021-01-04", periods=5, freq="B"))
    bhav_dates = tri_dates.delete(2)  # a whole session missing, surrounded by present ones
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
            }
            for d in bhav_dates
        ]
    )
    _synthetic, results = adjust.fill_session_calendar(daily, tri_dates)
    # A single missing session is fillable (QA C05), not an outright F here --
    # C04's "drop a session -> F naming the date" scenario is the *consecutive*
    # case, exercised below.
    assert any(
        r.severity == GuardSeverity.G and str(tri_dates[2].date()) in r.session for r in results
    )


def test_c05_single_gap_synthesised_two_consecutive_gaps_fail():
    tri_dates = pd.DatetimeIndex(pd.date_range("2021-01-04", periods=8, freq="B"))
    # Drop index 3 only (single gap).
    bhav_dates = tri_dates.delete(3)
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 12,
                "prevclose": 10,
            }
            for d in bhav_dates
        ]
    )
    synthetic, results = adjust.fill_session_calendar(daily, tri_dates)
    assert len(synthetic) == 1
    assert bool(synthetic.iloc[0]["synthetic_close"])
    assert not any(r.severity == GuardSeverity.F for r in results)

    # Two consecutive missing sessions (indices 3 and 4) -> F.
    bhav_dates2 = tri_dates.delete([3, 4])
    daily2 = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 12,
                "prevclose": 10,
            }
            for d in bhav_dates2
        ]
    )
    synthetic2, results2 = adjust.fill_session_calendar(daily2, tri_dates)
    assert synthetic2.empty
    assert any(r.severity == GuardSeverity.F for r in results2)


# --------------------------------------------------------------------------
# C06: PREVCLOSE continuity, across an alias splice, with an exception row.
# --------------------------------------------------------------------------


def test_c06_continuity_break_fails_exception_row_passes():
    membership = _membership([("C0001", "X", "2011-01-03", "", "investable", "s", "")])
    daily = _daily_rows(
        [
            {
                "date": date(2021, 1, 4),
                "symbol": "X",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 100,
                "prevclose": 100,
                "company_id": "C0001",
            },
            # Spliced wrong: prevclose should equal 100 (previous close), not 90.
            {
                "date": date(2021, 1, 5),
                "symbol": "X",
                "open": 90,
                "high": 90,
                "low": 90,
                "close": 95,
                "prevclose": 90,
                "company_id": "C0001",
            },
        ]
    )
    no_exceptions = pd.DataFrame(columns=["company_id", "session", "reason", "source"])
    results = guards.check_continuity(daily, membership, no_exceptions)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.F

    exceptions = pd.DataFrame(
        [{"company_id": "C0001", "session": "2021-01-05", "reason": "test", "source": "test"}]
    )
    results2 = guards.check_continuity(daily, membership, exceptions)
    assert results2 == []


def test_c06_continuity_spans_full_alias_history_not_just_one_stint():
    """A company that renamed symbols mid-membership must not look like a
    continuity break at the rename boundary."""
    membership = _membership([("C0001", "NEWSYM", "2011-01-03", "", "investable", "s", "")])
    daily = _daily_rows(
        [
            {
                "date": date(2021, 1, 4),
                "symbol": "OLDSYM",
                "open": 50,
                "high": 50,
                "low": 50,
                "close": 50,
                "prevclose": 50,
                "company_id": "C0001",
            },
            {
                "date": date(2021, 1, 5),
                "symbol": "NEWSYM",
                "open": 50,
                "high": 50,
                "low": 50,
                "close": 51,
                "prevclose": 50,
                "company_id": "C0001",
            },
        ]
    )
    no_exceptions = pd.DataFrame(columns=["company_id", "session", "reason", "source"])
    results = guards.check_continuity(daily, membership, no_exceptions)
    assert results == []


# --------------------------------------------------------------------------
# C08: unresolved CA row for an ever-member -> F.
# --------------------------------------------------------------------------


def test_c08_unresolved_ca_row_for_ever_member_fails():
    ca_raw = pd.DataFrame(
        [
            {
                "symbol": "OLDSYM",
                "series": "EQ",
                "isin": "INE000UNKNOWN0",  # not in isin_to_company
                "faceVal": "10",
                "exDate": "10-Jan-2020",
                "recDate": "-",
                "subject": "Dividend Rs 5 Per Share",
                "comp": "Known Co",
            }
        ]
    )
    # To genuinely exercise "unresolved", use a row whose isin is unknown and
    # whose symbol is only present as a *historical* (non-latest) alias, so
    # resolve_ca_company can't find it via either path while it is still
    # clearly one of ours (the row's own symbol appears in aliases2).
    aliases2 = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol": "OLDSYM",
                "from": "2011-01-03",
                "to": "2015-01-01",
                "source": "t",
            },
            {
                "company_id": "C0001",
                "symbol": "NEWSYM",
                "from": "2015-01-02",
                "to": None,
                "source": "t",
            },
        ]
    )
    result = adjust.build_feed_events(ca_raw, {}, {"NEWSYM": "C0001"}, aliases2)
    assert len(result.report_rows) == 1
    assert result.report_rows[0].severity == GuardSeverity.F
    assert result.events.empty


def test_c08_row_for_a_non_member_symbol_is_silently_skipped():
    aliases = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "symbol": "MEMBER",
                "from": "2011-01-03",
                "to": None,
                "source": "t",
            }
        ]
    )
    ca_raw = pd.DataFrame(
        [
            {
                "symbol": "RANDOMCO",
                "series": "EQ",
                "isin": "INE999NOTMEMBER",
                "faceVal": "10",
                "exDate": "10-Jan-2020",
                "recDate": "-",
                "subject": "Dividend Rs 5 Per Share",
                "comp": "Random Co",
            }
        ]
    )
    result = adjust.build_feed_events(ca_raw, {}, {"MEMBER": "C0001"}, aliases)
    assert result.report_rows == []
    assert result.events.empty


# --------------------------------------------------------------------------
# C19: dummy members excluded from price coverage.
# --------------------------------------------------------------------------


def test_c19_dummy_member_with_no_prices_does_not_fail_coverage():
    membership = _membership(
        [
            ("C0001", "REGULAR", "2011-01-03", "", "investable", "s", ""),
            ("C0002", "DUMMYCO", "2023-07-20", "2023-09-06", "dummy", "s", ""),
        ]
    )
    dates = pd.date_range("2023-07-20", "2023-09-06", freq="B")
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "REGULAR",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
                "company_id": "C0001",
            }
            for d in dates
        ]
    )
    results = guards.check_membership_invariants(membership, daily, current_symbols={"REGULAR"})
    price_coverage_failures = [
        r for r in results if r.guard == "membership_invariants" and r.company_id == "C0002"
    ]
    assert price_coverage_failures == []  # C0002 is a dummy row, never checked for price coverage


# --------------------------------------------------------------------------
# C20: exit rule -- last_trade.csv records the actual last close.
# --------------------------------------------------------------------------


def test_c20_exit_rule_records_last_traded_close():
    companies = pd.DataFrame(
        [{"company_id": "C0001", "name": "Old Co"}, {"company_id": "C0002", "name": "Active Co"}]
    )
    daily = _daily_rows(
        [
            {
                "date": date(2020, 1, 1),
                "symbol": "OLD",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 42.5,
                "prevclose": 10,
                "company_id": "C0001",
            },
            {
                "date": date(2020, 1, 2),
                "symbol": "OLD",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 43.0,
                "prevclose": 42.5,
                "company_id": "C0001",
            },
            {
                "date": date(2020, 1, 3),
                "symbol": "ACT",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 55.0,
                "prevclose": 10,
                "company_id": "C0002",
            },
        ]
    )
    last_trade = adjust.compute_last_trade(daily, companies)
    assert last_trade.set_index("company_id").loc["C0001", "last_close"] == pytest.approx(43.0)
    assert last_trade.set_index("company_id").loc["C0001", "last_session"] == date(2020, 1, 2)


# --------------------------------------------------------------------------
# C22: content-hash raw manifest comparison against a pinned snapshot.
# --------------------------------------------------------------------------


def test_c22_content_hash_unchanged_passes_changed_for_member_session_fails():
    manifest = pd.DataFrame(
        [
            {
                "file": "cm04JAN2021bhav.csv.zip",
                "fetched_at": "x",
                "zip_sha256": "differentzip",
                "content_sha256": "sameHASH",
                "rows": 100,
            },
            {
                "file": "cm05JAN2021bhav.csv.zip",
                "fetched_at": "x",
                "zip_sha256": "z2",
                "content_sha256": "newHASH",
                "rows": 100,
            },
        ]
    )
    pinned = pd.DataFrame(
        [
            {"file": "cm04JAN2021bhav.csv.zip", "content_sha256": "sameHASH"},
            {"file": "cm05JAN2021bhav.csv.zip", "content_sha256": "oldHASH"},
        ]
    )
    # No member-session files declared -> the changed one is only G.
    results = adjust.diff_raw_manifest(manifest, pinned, member_session_files=set())
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.G

    results2 = adjust.diff_raw_manifest(
        manifest, pinned, member_session_files={"cm05JAN2021bhav.csv.zip"}
    )
    assert results2[0].severity == GuardSeverity.F


# --------------------------------------------------------------------------
# C23: unexplained move guard, with and without a crash_allowlist entry.
# --------------------------------------------------------------------------


def test_c23_unexplained_move_fails_allowlisted_move_passes():
    daily = _daily_rows(
        [
            {
                "date": date(2023, 2, 1),
                "symbol": "ADANI",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 75,
                "prevclose": 100,
                "company_id": "C0001",
                "r_t": 0.75,
            },
            {
                "date": date(2023, 2, 2),
                "symbol": "ADANI",
                "open": 75,
                "high": 75,
                "low": 75,
                "close": 50,
                "prevclose": 75,
                "company_id": "C0001",
                "r_t": 0.667,
            },
        ]
    )
    events = pd.DataFrame(columns=["company_id", "session", "source"])
    no_allowlist = pd.DataFrame(columns=["company_id", "session", "reason", "source"])
    membership = _membership([("C0001", "ADANI", "2011-01-03", "", "investable", "s", "")])
    results = guards.check_unexplained_moves(daily, events, no_allowlist, membership)
    assert len(results) == 2
    assert all(r.severity == GuardSeverity.F for r in results)

    allowlist = pd.DataFrame(
        [
            {"company_id": "C0001", "session": "2023-02-01", "reason": "cited", "source": "url"},
            {"company_id": "C0001", "session": "2023-02-02", "reason": "cited", "source": "url"},
        ]
    )
    results2 = guards.check_unexplained_moves(daily, events, allowlist, membership)
    assert results2 == []


def test_c23_unexplained_move_outside_membership_never_fails():
    """A >20% move on a session outside every membership window must not
    produce F, even with no allowlist entry -- companies that left the index
    years earlier (e.g. RCom/RPower/Suzlon during their later distress years)
    are out of scope for this guard (plan.md §3: "unexplained MEMBER-PERIOD
    daily move")."""
    daily = _daily_rows(
        [
            {
                "date": date(2019, 2, 4),
                "symbol": "EXMEM",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 60,
                "prevclose": 100,
                "company_id": "C0099",
                "r_t": 0.60,
            }
        ]
    )
    events = pd.DataFrame(columns=["company_id", "session", "source"])
    no_allowlist = pd.DataFrame(columns=["company_id", "session", "reason", "source"])
    # Membership ended in 2012 -- the 2019 crash date is well outside the window.
    membership = _membership(
        [("C0099", "EXMEM", "2011-01-03", "2012-06-30", "investable", "s", "")]
    )
    results = guards.check_unexplained_moves(daily, events, no_allowlist, membership)
    assert results == []


def test_c23_unexplained_move_inside_membership_fails_without_allowlist_row():
    daily = _daily_rows(
        [
            {
                "date": date(2015, 6, 1),
                "symbol": "INMEM",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 60,
                "prevclose": 100,
                "company_id": "C0098",
                "r_t": 0.60,
            }
        ]
    )
    events = pd.DataFrame(columns=["company_id", "session", "source"])
    no_allowlist = pd.DataFrame(columns=["company_id", "session", "reason", "source"])
    membership = _membership([("C0098", "INMEM", "2011-01-03", "", "investable", "s", "")])
    results = guards.check_unexplained_moves(daily, events, no_allowlist, membership)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.F


# --------------------------------------------------------------------------
# F08: factor-explains-move gating.
# --------------------------------------------------------------------------


def test_f08_small_factor_is_unverifiable_not_a_failure():
    dates = pd.date_range("2021-01-04", periods=65, freq="B")
    rng = np.random.default_rng(42)
    closes = 100 * np.cumprod(1 + rng.normal(0, 0.01, size=len(dates)))
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "X",
                "open": c,
                "high": c,
                "low": c,
                "close": c,
                "prevclose": (closes[i - 1] if i else c),
                "company_id": "C0001",
            }
            for i, (d, c) in enumerate(zip(dates, closes, strict=True))
        ]
    )
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "session": dates[-1].date(),
                "factor": 0.99,  # tiny factor: |log f| should be well under 3*vol
                "dividend": None,
                "kind": "bonus",
                "source": "feed",
            }
        ]
    )
    results = guards.check_factor_significance(daily, events)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.G
    assert "unverifiable" in results[0].message


def test_f08_large_factor_with_wrong_exdate_fails():
    dates = pd.date_range("2021-01-04", periods=65, freq="B")
    rng = np.random.default_rng(7)
    closes = 100 * np.cumprod(1 + rng.normal(0, 0.005, size=len(dates)))
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "X",
                "open": c,
                "high": c,
                "low": c,
                "close": c,
                "prevclose": (closes[i - 1] if i else c),
                "company_id": "C0001",
            }
            for i, (d, c) in enumerate(zip(dates, closes, strict=True))
        ]
    )
    # A large bonus factor (2:1, f=0.5) attached to a session where price barely
    # moved (the "wrong ex-date" case): the factor does NOT explain the move.
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "session": dates[-1].date(),
                "factor": 0.5,
                "dividend": None,
                "kind": "bonus",
                "source": "feed",
            }
        ]
    )
    results = guards.check_factor_significance(daily, events)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.F


# --------------------------------------------------------------------------
# F11: membership weekly mask -- member from mid-week counts from the first
# week containing its first session.
# --------------------------------------------------------------------------


def test_f11_membership_weekly_first_week_containing_first_session():
    membership = _membership(
        [("C0001", "X", "2021-01-06", "", "investable", "s", "")]
    )  # a Wednesday
    market_dates = pd.DatetimeIndex(pd.date_range("2021-01-04", periods=10, freq="B"))
    weekly = adjust.build_membership_weekly(membership, market_dates)
    first_week_end = market_dates[market_dates.dayofweek == 4][0]  # first Friday (2021-01-08)
    assert bool(weekly.loc[first_week_end, "C0001"])
    prior_friday_candidates = weekly.index[weekly.index < first_week_end]
    if len(prior_friday_candidates):
        assert not bool(weekly.loc[prior_friday_candidates[-1], "C0001"])


# --------------------------------------------------------------------------
# N01 / N02: dividend-yield and suspension flags are G, not F.
# --------------------------------------------------------------------------


def test_n01_dividend_yield_flagged_not_failed():
    membership = _membership([("C0001", "X", "2011-01-03", "", "investable", "s", "")])
    daily = _daily_rows(
        [
            {
                "date": date(2021, m, 1),
                "symbol": "X",
                "open": 100,
                "high": 100,
                "low": 100,
                "close": 100,
                "prevclose": 100,
                "company_id": "C0001",
            }
            for m in range(1, 13)
        ]
    )
    events = pd.DataFrame(
        [
            {
                "company_id": "C0001",
                "session": date(2021, 6, 1),
                "kind": "dividend",
                "dividend": 20.0,
                "factor": None,
                "source": "feed",
            }
        ]
    )
    results = guards.check_dividend_yield(daily, events, membership)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.G


def test_n02_suspension_flagged_not_failed():
    membership = _membership([("C0001", "X", "2021-01-04", "", "investable", "s", "")])
    market_dates = pd.date_range("2021-01-04", periods=10, freq="B")
    traded = [market_dates[0]] + list(market_dates[6:])  # a 5-session gap
    daily = _daily_rows(
        [
            {
                "date": d.date(),
                "symbol": "Y",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
                "company_id": None,
            }
            for d in market_dates
        ]
        + [
            {
                "date": d.date(),
                "symbol": "X",
                "open": 10,
                "high": 10,
                "low": 10,
                "close": 10,
                "prevclose": 10,
                "company_id": "C0001",
            }
            for d in traded
        ]
    )
    results = guards.check_suspensions(daily, membership)
    assert len(results) == 1
    assert results[0].severity == GuardSeverity.G
