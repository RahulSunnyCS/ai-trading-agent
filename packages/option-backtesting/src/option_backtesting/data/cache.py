"""
DuckDB façade over the Parquet cache written by ingest.py. The engine reads
only through this module — it never imports a provider (see providers/base.py
and the handoff's non-negotiables).

All queries are parameterised and time-bounded — never a full-glob scan
without a date filter, even though these are flat files rather than
TimescaleDB hypertables (the same discipline the TS side applies to
`market_ticks`/`straddle_snapshots` carries over here).
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import duckdb

from .ingest import DEFAULT_CACHE_DIR, GreeksRow
from .providers.base import Bar, SessionFlag


class Cache:
    def __init__(self, cache_dir: Path = DEFAULT_CACHE_DIR) -> None:
        self._dir = cache_dir

    def _glob(
        self,
        underlying: str,
        timeframe: str,
        data_kind: str,
        strike_rule: str | None,
        leg: str | None,
    ) -> str:
        rule_part = strike_rule or "na"
        leg_part = leg or "na"
        return (
            self._dir
            / underlying
            / timeframe
            / data_kind
            / f"{rule_part}_{leg_part}"
            / "*.parquet"
        ).as_posix()

    def get_opt_bars(
        self,
        underlying: str,
        timeframe: str,
        strike_rule: str,
        leg: str,
        start: date,
        end: date,
    ) -> list[Bar]:
        return self._get_bars(underlying, timeframe, "opt", strike_rule, leg, start, end)

    def get_cash_bars(self, underlying: str, timeframe: str, start: date, end: date) -> list[Bar]:
        return self._get_bars(underlying, timeframe, "cash", None, None, start, end)

    def _get_bars(
        self,
        underlying: str,
        timeframe: str,
        data_kind: str,
        strike_rule: str | None,
        leg: str | None,
        start: date,
        end: date,
    ) -> list[Bar]:
        pattern = self._glob(underlying, timeframe, data_kind, strike_rule, leg)
        con = duckdb.connect(":memory:")
        try:
            rows = con.execute(
                """
                SELECT ts, open, high, low, close, volume, session
                FROM read_parquet(?)
                WHERE ts >= ? AND ts < ?
                ORDER BY ts
                """,
                [pattern, datetime.combine(start, datetime.min.time()), _end_of_day(end)],
            ).fetchall()
        except duckdb.IOException:
            return []
        finally:
            con.close()
        return [
            Bar(
                ts=r[0],
                open=r[1],
                high=r[2],
                low=r[3],
                close=r[4],
                volume=r[5],
                session=SessionFlag(r[6]),
            )
            for r in rows
        ]

    def get_greeks(
        self,
        underlying: str,
        timeframe: str,
        strike_rule: str,
        leg: str,
        start: date,
        end: date,
    ) -> list[GreeksRow]:
        pattern = self._glob(underlying, timeframe, "greeks", strike_rule, leg)
        con = duckdb.connect(":memory:")
        try:
            rows = con.execute(
                """
                SELECT ts, delta, theta, gamma, vega, rho, implied_vol, implied_fut, session
                FROM read_parquet(?)
                WHERE ts >= ? AND ts < ?
                ORDER BY ts
                """,
                [pattern, datetime.combine(start, datetime.min.time()), _end_of_day(end)],
            ).fetchall()
        except duckdb.IOException:
            return []
        finally:
            con.close()
        return [
            GreeksRow(
                ts=r[0],
                delta=r[1],
                theta=r[2],
                gamma=r[3],
                vega=r[4],
                rho=r[5],
                implied_vol=r[6],
                implied_fut=r[7],
                session=SessionFlag(r[8]),
            )
            for r in rows
        ]


def _end_of_day(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time().replace(hour=23, minute=59, second=59))
