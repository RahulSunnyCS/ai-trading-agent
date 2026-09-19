"""
Unit tests for features/regime.py's regime_bucket_report(), monkeypatching
analytics.regime_source directly (this module's actual dependency) rather
than going through a fake psycopg — that lazy-import boundary is already
covered by test_analytics_regime_source.py.
"""

from datetime import date

import pytest

from option_backtesting.engine.result import SessionResult
from option_backtesting.features import regime as regime_mod
from option_backtesting.features.regime import regime_bucket_report


def _session(d: date, net: float) -> SessionResult:
    return SessionResult(
        date=d,
        dte=1,
        net=net,
        gross=net,
        cost=0.0,
        lot_days=1.0,
        peak_loss=0.0,
        total_lots=1,
        exit_bar=0,
        fills=[],
    )


def test_returns_none_when_regime_data_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: False)
    sessions = [_session(date(2026, 8, 17), 100.0)]
    assert regime_bucket_report(sessions, "NIFTY") is None


def test_returns_none_for_empty_sessions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    assert regime_bucket_report([], "NIFTY") is None


def test_returns_none_when_fetch_returns_no_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    monkeypatch.setattr(regime_mod, "fetch_regimes", lambda *a, **k: {})
    sessions = [_session(date(2026, 8, 17), 100.0)]
    assert regime_bucket_report(sessions, "NIFTY") is None


def test_buckets_by_lag1_regime_never_same_day(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    # Regime tags exist for 8/17 (RANGING) and 8/18 (TRENDING_STRONG). A
    # session ON 8/18 must bucket under 8/17's regime (lag-1: the most
    # recent tag strictly BEFORE 8/18), never 8/18's own same-day tag,
    # and a session on 8/19 must use 8/18's tag (the most recent one
    # strictly before it).
    monkeypatch.setattr(
        regime_mod,
        "fetch_regimes",
        lambda *a, **k: {date(2026, 8, 17): "RANGING", date(2026, 8, 18): "TRENDING_STRONG"},
    )
    sessions = [
        _session(date(2026, 8, 18), 100.0),
        _session(date(2026, 8, 19), 50.0),
    ]
    buckets = regime_bucket_report(sessions, "NIFTY")
    assert buckets == {"RANGING": 100.0, "TRENDING_STRONG": 50.0}


def test_sums_net_across_multiple_sessions_in_the_same_regime(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    monkeypatch.setattr(
        regime_mod, "fetch_regimes", lambda *a, **k: {date(2026, 8, 17): "RANGING"}
    )
    sessions = [
        _session(date(2026, 8, 18), 100.0),
        _session(date(2026, 8, 19), -30.0),
    ]
    buckets = regime_bucket_report(sessions, "NIFTY")
    assert buckets == {"RANGING": 70.0}


def test_sessions_with_no_applicable_regime_row_are_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    # Only a regime tag AFTER the session exists -> lag-1 finds nothing.
    monkeypatch.setattr(
        regime_mod, "fetch_regimes", lambda *a, **k: {date(2026, 8, 20): "EVENT_DAY"}
    )
    sessions = [_session(date(2026, 8, 18), 100.0)]
    assert regime_bucket_report(sessions, "NIFTY") is None


def test_query_window_covers_lookback_buffer_before_first_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(regime_mod, "regime_data_available", lambda: True)
    captured = {}

    def _fake_fetch(underlying, date_from, date_to):
        captured["underlying"] = underlying
        captured["date_from"] = date_from
        captured["date_to"] = date_to
        return {}

    monkeypatch.setattr(regime_mod, "fetch_regimes", _fake_fetch)
    sessions = [_session(date(2026, 8, 18), 100.0)]
    regime_bucket_report(sessions, "BANKNIFTY")

    assert captured["underlying"] == "BANKNIFTY"
    assert captured["date_from"] < date(2026, 8, 18)
    assert captured["date_to"] == date(2026, 8, 18)
