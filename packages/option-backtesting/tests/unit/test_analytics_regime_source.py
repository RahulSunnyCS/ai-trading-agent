"""
Unit tests for analytics/regime_source.py. `psycopg` is NOT installed in
this environment (it's an optional "regime" extra) — these tests prove
the lazy-import boundary is exactly where the module claims: no import is
attempted at all when DATABASE_URL is unset, and a fake `psycopg` module
injected into sys.modules is used to exercise the query path without a
real PostgreSQL instance.
"""

import sys
from datetime import date

import pytest

from option_backtesting.analytics.regime_source import fetch_regimes, regime_data_available


class _FakeCursor:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.executed_query: str | None = None
        self.executed_params: tuple | None = None

    def __enter__(self) -> "_FakeCursor":
        return self

    def __exit__(self, *exc) -> None:
        return None

    def execute(self, query: str, params: tuple) -> None:
        self.executed_query = query
        self.executed_params = params

    def fetchall(self) -> list[tuple]:
        return self._rows


class _FakeConnection:
    def __init__(self, rows: list[tuple], module: "_FakePsycopgModule") -> None:
        self._cursor = _FakeCursor(rows)
        self._module = module

    def __enter__(self) -> "_FakeConnection":
        return self

    def __exit__(self, *exc) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        self._module.last_cursor = self._cursor
        return self._cursor


class _FakePsycopgModule:
    def __init__(self, rows: list[tuple]) -> None:
        self._rows = rows
        self.connect_calls: list[str] = []
        self.last_cursor: _FakeCursor | None = None

    def connect(self, database_url: str) -> _FakeConnection:
        self.connect_calls.append(database_url)
        return _FakeConnection(self._rows, self)


class TestRegimeDataAvailable:
    def test_false_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        assert regime_data_available() is False

    def test_true_when_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        assert regime_data_available() is True


class TestFetchRegimes:
    def test_returns_empty_dict_without_importing_psycopg_when_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setitem(sys.modules, "psycopg", None)  # any import would crash on None
        result = fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))
        assert result == {}

    def test_queries_with_correct_params_via_fake_psycopg(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        fake_module = _FakePsycopgModule(
            [(date(2026, 8, 17), "RANGING"), (date(2026, 8, 18), "TRENDING_STRONG")]
        )
        monkeypatch.setitem(sys.modules, "psycopg", fake_module)

        result = fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))

        assert result == {date(2026, 8, 17): "RANGING", date(2026, 8, 18): "TRENDING_STRONG"}
        assert fake_module.connect_calls == ["postgresql://localhost/test"]

    def test_query_is_parameterized_and_time_bounded(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        fake_module = _FakePsycopgModule([])
        monkeypatch.setitem(sys.modules, "psycopg", fake_module)

        fetch_regimes("BANKNIFTY", date(2026, 1, 1), date(2026, 1, 31))

        cur = fake_module.last_cursor
        assert cur is not None
        # Bound params, never string-interpolated into the query text.
        assert "%s" in cur.executed_query
        assert "BANKNIFTY" not in cur.executed_query
        assert cur.executed_params == ("BANKNIFTY", date(2026, 1, 1), date(2026, 1, 31))

    def test_empty_result_when_no_rows_match(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        fake_module = _FakePsycopgModule([])
        monkeypatch.setitem(sys.modules, "psycopg", fake_module)
        assert fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31)) == {}
