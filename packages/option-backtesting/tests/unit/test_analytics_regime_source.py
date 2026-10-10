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

from option_backtesting.analytics.regime_source import (
    RegimeSourceUnavailable,
    fetch_regimes,
    regime_data_available,
)


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


class _FakeOperationalError(Exception):
    pass


class _FakeUndefinedTable(Exception):
    pass


class _FakeSyntaxError(Exception):
    pass


class _FailingPsycopgModule:
    """A psycopg stand-in whose connect() or execute() raises `error`."""

    OperationalError = _FakeOperationalError

    class errors:  # noqa: N801 - mirrors psycopg.errors
        UndefinedTable = _FakeUndefinedTable

    def __init__(self, *, connect_error=None, execute_error=None) -> None:
        self._connect_error = connect_error
        self._execute_error = execute_error

    def connect(self, database_url: str):
        if self._connect_error is not None:
            raise self._connect_error
        module = self

        class _Cursor(_FakeCursor):
            def execute(self, query: str, params: tuple) -> None:
                raise module._execute_error

        class _Conn(_FakeConnection):
            def __init__(self) -> None:
                self._cursor = _Cursor([])

            def cursor(self) -> _Cursor:
                return self._cursor

        return _Conn()


class TestFetchRegimesWhenSourceCannotSupplyTags:
    def test_unreachable_database_raises_unavailable_with_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost:1/none")
        fake = _FailingPsycopgModule(
            connect_error=_FakeOperationalError("connection refused\nIs the server running?")
        )
        monkeypatch.setitem(sys.modules, "psycopg", fake)
        with pytest.raises(RegimeSourceUnavailable) as raised:
            fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))
        assert raised.value.status == "unreachable"
        assert "connection refused" in str(raised.value)

    def test_missing_table_raises_unavailable_with_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        fake = _FailingPsycopgModule(execute_error=_FakeUndefinedTable("no such relation"))
        monkeypatch.setitem(sys.modules, "psycopg", fake)
        with pytest.raises(RegimeSourceUnavailable) as raised:
            fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))
        assert raised.value.status == "missing_table"
        assert "daily_regime_tags" in str(raised.value)

    def test_genuine_query_error_still_raises_loudly(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DATABASE_URL", "postgresql://localhost/test")
        fake = _FailingPsycopgModule(execute_error=_FakeSyntaxError("bad column"))
        monkeypatch.setitem(sys.modules, "psycopg", fake)
        with pytest.raises(_FakeSyntaxError):
            fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))

    def test_real_psycopg_against_a_closed_port_is_unreachable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        pytest.importorskip("psycopg")
        monkeypatch.setenv("DATABASE_URL", "postgresql://127.0.0.1:1/none?connect_timeout=2")
        with pytest.raises(RegimeSourceUnavailable) as raised:
            fetch_regimes("NIFTY", date(2026, 8, 1), date(2026, 8, 31))
        assert raised.value.status == "unreachable"
