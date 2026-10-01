import json
from datetime import UTC, datetime, timedelta

import pandas as pd
import pytest

from momentum_backtesting import fyers
from momentum_backtesting.fetch import load_universe
from momentum_backtesting.sources import adjust_nav_splits, weekly


def test_weekly_uses_last_trading_day_when_friday_is_a_holiday():
    days = pd.to_datetime(["2026-09-14", "2026-09-17", "2026-09-21", "2026-09-25"])
    closes = pd.Series([1.0, 2.0, 3.0, 4.0], index=days)
    result = weekly(closes)
    # Week ending Fri 18 Sep had no Friday close - Thursday's close stands in.
    assert result[pd.Timestamp("2026-09-18")] == 2.0
    assert result[pd.Timestamp("2026-09-25")] == 4.0


def test_nav_split_is_undone_so_returns_stay_continuous():
    # Mirrors UTI Liquid's 10:1 split on 2026-06-20.
    days = pd.date_range("2026-06-17", periods=5, freq="D")
    nav = pd.Series([4587.5, 4588.2967, 4589.1243, 458.9915, 459.0706], index=days)
    adjusted = adjust_nav_splits(nav)
    assert adjusted.pct_change().abs().max() < 0.001
    assert adjusted.iloc[-1] == nav.iloc[-1]  # latest values untouched


def test_real_nav_moves_are_not_mistaken_for_splits():
    nav = pd.Series([100.0, 100.02, 100.03], index=pd.date_range("2026-01-01", periods=3))
    pd.testing.assert_series_equal(adjust_nav_splits(nav), nav)


def test_dashboard_token_wins_over_environment_for_regular_jobs(monkeypatch):
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "stale-env")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    expires = datetime.now(UTC) + timedelta(hours=2)

    class FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, _sql, _params=None):
            return self

        def fetchone(self):
            return ("DASHBOARD-100", "fresh-dashboard", expires)

    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: FakeConn())
    creds = fyers.resolve_credentials()
    assert (creds.app_id, creds.access_token, creds.source) == (
        "DASHBOARD-100",
        "fresh-dashboard",
        "broker_tokens",
    )
    assert "fresh-dashboard" not in repr(creds)


def test_expired_dashboard_token_falls_back_to_environment(monkeypatch):
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    monkeypatch.setattr(
        fyers,
        "_dashboard_credentials",
        lambda: (_ for _ in ()).throw(fyers.FyersCredentialsError("stored token expired")),
    )

    creds = fyers.resolve_credentials()
    assert (creds.access_token, creds.source) == ("env-token", "env")


def test_unavailable_dashboard_database_falls_back_to_environment(monkeypatch):
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")
    monkeypatch.setenv("DATABASE_URL", "postgres://offline")
    monkeypatch.setattr(
        fyers,
        "_dashboard_credentials",
        lambda: (_ for _ in ()).throw(fyers.FyersCredentialsError("database unavailable")),
    )

    assert fyers.resolve_credentials().access_token == "env-token"


def test_unavailable_dashboard_database_falls_back_to_token_file(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "postgres://offline")
    monkeypatch.delenv("FYERS_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(
        fyers,
        "_dashboard_credentials",
        lambda: (_ for _ in ()).throw(fyers.FyersCredentialsError("database unavailable")),
    )
    token_file = tmp_path / "fyers-token.json"
    token_file.write_text(
        json.dumps(
            {
                "app_id": "FILE-100",
                "access_token": "file-token",
                "expires_at": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
            }
        )
    )
    monkeypatch.setenv("FYERS_TOKEN_FILE", str(token_file))

    creds = fyers.resolve_credentials()
    assert (creds.access_token, creds.source) == ("file-token", "FYERS_TOKEN_FILE")


def test_dashboard_preview_prefers_cached_oauth_token_over_env(monkeypatch):
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "stale-env")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    expires = datetime.now(UTC) + timedelta(hours=2)

    class FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, _sql, _params=None):
            return self

        def fetchone(self):
            return ("APP-100", "fresh-dashboard", expires)

    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: FakeConn())
    creds = fyers.resolve_credentials(prefer_dashboard=True)
    assert (creds.access_token, creds.source) == ("fresh-dashboard", "broker_tokens")


def test_standalone_preview_uses_local_oauth_cache_when_dashboard_db_is_down(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgres://offline")
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "stale-env")
    monkeypatch.setattr(
        fyers,
        "_dashboard_credentials",
        lambda: (_ for _ in ()).throw(fyers.FyersCredentialsError("database offline")),
    )
    cached = fyers.Credentials(
        "APP-100", "fresh-local", "mbt login cache", datetime.now(UTC) + timedelta(hours=1)
    )
    monkeypatch.setattr(fyers, "_cached_token", lambda: cached)
    assert fyers.resolve_credentials(prefer_dashboard=True).access_token == "fresh-local"


def test_no_token_anywhere_points_to_mbt_login(monkeypatch, tmp_path):
    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.delenv("FYERS_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(fyers, "TOKEN_CACHE", tmp_path / "none.json")
    with pytest.raises(fyers.FyersCredentialsError, match="mbt login"):
        fyers.resolve_credentials()


def test_expired_database_token_is_rejected(monkeypatch, tmp_path):
    monkeypatch.delenv("FYERS_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(fyers, "TOKEN_CACHE", tmp_path / "none.json")
    monkeypatch.setenv("DATABASE_URL", "postgres://fake")
    expired = datetime.now(UTC) - timedelta(hours=1)

    class FakeConn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, _sql, _params=None):
            return self

        def fetchone(self):
            return ("APP-100", "stale", expired)

    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: FakeConn())
    with pytest.raises(fyers.FyersCredentialsError, match="expired"):
        fyers.resolve_credentials()


def test_universe_file_is_well_formed():
    universe = load_universe()
    assert len({i.name for i in universe}) == len(universe)
    for inst in universe:
        assert inst.include in {"core", "optional", "defensive"}
        assert inst.tax_class in {"equity", "gold_silver", "international", "debt"}
        assert inst.price_source.startswith(("NSE:", "AMFI:", "INDEXFX:")) or (
            inst.price_source == "SILVER"
        )
        if inst.price_source.startswith("INDEXFX:"):
            assert inst.price_source.split(":")[3] in {"prev", "same"}
        assert inst.backfill == "" or inst.backfill.startswith("NIFTYINDICES:")


def test_cached_login_token_is_used_until_it_expires(monkeypatch, tmp_path):
    monkeypatch.delenv("FYERS_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(fyers, "TOKEN_CACHE", tmp_path / ".fyers_token.json")
    later = datetime.now(UTC) + timedelta(hours=5)
    fyers.save_token(fyers.Credentials("APP-100", "fresh", "mbt login", later))
    assert oct(fyers.TOKEN_CACHE.stat().st_mode)[-3:] == "600"
    assert fyers.resolve_credentials().access_token == "fresh"

    fyers.save_token(fyers.Credentials("APP-100", "old", "mbt login", later - timedelta(hours=6)))
    with pytest.raises(fyers.FyersCredentialsError):
        fyers.resolve_credentials()


def test_auth_code_parsed_from_redirect_url_and_state_checked():
    url = "http://localhost:3000/api/auth/fyers/callback?s=ok&code=200&auth_code=ABC.def&state=xyz"
    assert fyers.parse_auth_code(url, "xyz") == "ABC.def"
    with pytest.raises(fyers.FyersCredentialsError, match="state"):
        fyers.parse_auth_code(url, "other")
    assert fyers.parse_auth_code("  ABC.def  ", "xyz") == "ABC.def"


def test_fyers_requests_carry_a_user_agent_and_survive_non_json_errors(monkeypatch):
    import io
    import urllib.error

    seen = {}

    def fake_urlopen(request, timeout):
        seen["ua"] = request.get_header("User-agent")
        raise urllib.error.HTTPError(
            request.full_url, 403, "Forbidden", {}, io.BytesIO(b"error code: 1010\n")
        )

    monkeypatch.setenv("FYERS_APP_ID", "APP-100")
    monkeypatch.setenv("FYERS_APP_SECRET", "secret")
    monkeypatch.setattr(fyers.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(fyers.FyersCredentialsError, match="HTTP 403"):
        fyers.exchange_auth_code("code")
    assert seen["ua"] and "urllib" not in seen["ua"].lower()


def test_niftyindices_rows_parse_and_skip_blank_closes():
    from momentum_backtesting.sources import parse_niftyindices

    rows = [
        {"HistoricalDate": "04 Jan 2016", "CLOSE": "4541.30"},
        {"HistoricalDate": "01 Jan 2016", "CLOSE": "4520.00"},
        {"HistoricalDate": "05 Jan 2016", "CLOSE": "-"},
    ]
    series = parse_niftyindices(rows)
    assert list(series.index.strftime("%Y-%m-%d")) == ["2016-01-01", "2016-01-04"]
    assert series.iloc[-1] == 4541.30


def test_niftyindices_month_parsing_matches_every_english_abbreviation():
    """T4 regression test (QA F04): the ETF path's `%b` parsing used to ask the C
    library to match "Jan"/"Feb"/... against the *process locale's* month names,
    which works by accident on an en_US-like box and breaks silently anywhere else.
    `parse_niftyindices` now matches a fixed English table instead - this pins the
    exact ISO date every month abbreviation must resolve to, independent of the
    machine's locale."""
    from momentum_backtesting.sources import parse_niftyindices

    month_abbrs = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ]
    rows = [{"HistoricalDate": f"15 {abbr} 2016", "CLOSE": "100.00"} for abbr in month_abbrs]

    series = parse_niftyindices(rows)

    assert list(series.index.strftime("%Y-%m-%d")) == [f"2016-{m:02d}-15" for m in range(1, 13)]


def test_niftyindices_month_parsing_is_unaffected_by_the_process_locale():
    """Same regression as above, proven against an actual non-English LC_TIME so a
    future re-introduction of locale-dependent parsing (e.g. reverting to
    `pd.to_datetime(..., format="%d %b %Y")`) is caught even on a machine whose
    default locale happens to be English."""
    import locale

    from momentum_backtesting.sources import parse_niftyindices

    original = locale.setlocale(locale.LC_TIME)
    try:
        locale.setlocale(locale.LC_TIME, "de_DE.UTF-8")
    except locale.Error:
        pytest.skip("de_DE.UTF-8 locale is not installed on this machine")
    try:
        rows = [{"HistoricalDate": "04 Jan 2016", "CLOSE": "4541.30"}]
        series = parse_niftyindices(rows)
    finally:
        locale.setlocale(locale.LC_TIME, original)

    assert series.index[0] == pd.Timestamp("2016-01-04")


def test_backfill_prepends_older_history_scaled_to_join_without_a_jump():
    from momentum_backtesting.fetch import backfill

    older = pd.Series(
        [100.0, 110.0, 121.0, 133.1], index=pd.date_range("2019-01-01", periods=4, freq="D")
    )
    primary = pd.Series([242.0, 266.2], index=pd.date_range("2019-01-03", periods=2, freq="D"))
    combined, ratio = backfill(primary, older)
    assert ratio == pytest.approx(0.5)
    assert list(combined.round(6)) == [200.0, 220.0, 242.0, 266.2]
    assert combined.pct_change().dropna().round(6).eq(0.1).all()


def test_backfill_leaves_primary_alone_when_older_adds_nothing():
    from momentum_backtesting.fetch import backfill

    primary = pd.Series([1.0, 2.0], index=pd.date_range("2019-01-01", periods=2))
    later = pd.Series([5.0], index=pd.date_range("2019-01-02", periods=1))
    combined, _ = backfill(primary, later)
    pd.testing.assert_series_equal(combined, primary)


def test_us_index_uses_previous_close_hong_kong_uses_same_day(monkeypatch):
    from momentum_backtesting import sources

    days = pd.date_range("2026-09-21", periods=3, freq="D")
    fake = {"IDX": pd.Series([10.0, 20.0, 30.0], index=days), "FX": pd.Series(2.0, index=days)}
    monkeypatch.setattr(sources, "yahoo_daily", lambda symbol, start: fake[symbol])
    same = sources.index_in_inr("IDX", "FX", days[0].date(), previous_close=False)
    prev = sources.index_in_inr("IDX", "FX", days[0].date(), previous_close=True)
    assert same[days[1]] == 40.0
    assert prev[days[1]] == 20.0  # Tuesday in India sees Monday's US close
