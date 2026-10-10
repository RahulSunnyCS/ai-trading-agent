"""
Regime data source (M-5, R2). Reads apps/server's `daily_regime_tags`
table (see apps/server/src/db/migrations/008_regime_tagging.sql) from the
live trading PostgreSQL database — read-only, parameterized, time-bounded
— but ONLY when `DATABASE_URL` is set. `psycopg` is imported lazily inside
`fetch_regimes`, so no database connection is opened without that setting.

When `DATABASE_URL` is unset, regime data is simply unavailable — this
module returns an empty result rather than raising, so callers (analytics/
regime.py) can omit regime bucketing gracefully, the same "omit, don't
guess" convention as every other optional data source in this codebase.

Two further situations are "this source has no regime data", not "the query
is wrong", and raise `RegimeSourceUnavailable` (carrying a `status` the
callers report): no connection can be made (`connect_failed`: the server is
down, bad credentials, no such database), or the database is reachable but has
no `daily_regime_tags` table (`missing_table`, e.g. a Postgres that only holds
`broker_tokens`). Any other failure of a query against a database that does
have the table still raises as before.
"""

from __future__ import annotations

import os
from datetime import date

_QUERY = (
    "SELECT trade_date, regime FROM daily_regime_tags "
    "WHERE symbol = %s AND trade_date >= %s AND trade_date <= %s"
)


class RegimeSourceUnavailable(RuntimeError):
    """The regime database is configured but cannot supply regime tags.
    `status` is `connect_failed` or `missing_table`; `str(error)` says why."""

    def __init__(self, status: str, message: str) -> None:
        super().__init__(message)
        self.status = status


def regime_data_available() -> bool:
    return bool(os.environ.get("DATABASE_URL"))


def fetch_regimes(underlying: str, date_from: date, date_to: date) -> dict[date, str]:
    """{trade_date: regime} for `underlying` in [date_from, date_to].
    Returns {} (not an error) when DATABASE_URL isn't set. Raises
    `RegimeSourceUnavailable` when DATABASE_URL is set but the database
    can't be reached or has no `daily_regime_tags` table. Raises the
    underlying error when the query itself fails against a database that
    does have the table — a real problem should surface, never be
    swallowed."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return {}

    import psycopg

    try:
        conn = psycopg.connect(database_url)
    except psycopg.OperationalError as error:
        raise RegimeSourceUnavailable(
            "connect_failed", f"cannot connect to DATABASE_URL: {_short(error)}"
        ) from error

    try:
        with conn, conn.cursor() as cur:
            cur.execute(_QUERY, (underlying, date_from, date_to))
            return {row[0]: row[1] for row in cur.fetchall()}
    except psycopg.errors.UndefinedTable as error:
        raise RegimeSourceUnavailable(
            "missing_table", "daily_regime_tags does not exist in DATABASE_URL's database"
        ) from error


def _short(error: Exception) -> str:
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__
