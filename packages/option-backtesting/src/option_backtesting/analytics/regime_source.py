"""
Regime data source (M-5, R2). Reads apps/server's `daily_regime_tags`
table (see apps/server/src/db/migrations/008_regime_tagging.sql) from the
live trading PostgreSQL database — read-only, parameterized, time-bounded
— but ONLY when `DATABASE_URL` is set. `psycopg` is an optional dependency
(pyproject.toml's "regime" extra) and is imported lazily, inside
`fetch_regimes`, so an environment that never sets `DATABASE_URL` never
needs psycopg installed at all.

When `DATABASE_URL` is unset, regime data is simply unavailable — this
module returns an empty result rather than raising, so callers (analytics/
regime.py) can omit regime bucketing gracefully, the same "omit, don't
guess" convention as every other optional data source in this codebase.
"""

from __future__ import annotations

import os
from datetime import date

_QUERY = (
    "SELECT trade_date, regime FROM daily_regime_tags "
    "WHERE symbol = %s AND trade_date >= %s AND trade_date <= %s"
)


def regime_data_available() -> bool:
    return bool(os.environ.get("DATABASE_URL"))


def fetch_regimes(underlying: str, date_from: date, date_to: date) -> dict[date, str]:
    """{trade_date: regime} for `underlying` in [date_from, date_to].
    Returns {} (not an error) when DATABASE_URL isn't set. Raises if
    DATABASE_URL IS set but the query itself fails — a real DB/connectivity
    problem should surface, never be swallowed."""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return {}

    import psycopg  # optional dependency ("regime" extra) — lazy on purpose

    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(_QUERY, (underlying, date_from, date_to))
        return {row[0]: row[1] for row in cur.fetchall()}
