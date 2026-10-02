"""
Registering instruments and their vendor aliases, in bulk.

`instrument_key` is the identity (see migrations/001_core.sql); registering the
same instrument twice is a no-op, so every daily run can simply register
everything it touched.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import duckdb
import pyarrow as pa


@dataclass(frozen=True)
class InstrumentSpec:
    asset_class: str  # index | stock | etf | fund | option | future | commodity
    exchange: str
    symbol: str
    expiry: date | None = None
    strike: float | None = None
    option_type: str | None = None
    lot_size: int | None = None
    underlying_key: str | None = None
    vendor: str | None = None
    vendor_symbol: str | None = None
    company_id: str | None = None

    @property
    def key(self) -> str:
        return instrument_key(
            self.exchange, self.asset_class, self.symbol, self.expiry, self.strike, self.option_type
        )


_ABBR = {
    "index": "IDX",
    "stock": "STK",
    "etf": "ETF",
    "fund": "FND",
    "option": "OPT",
    "future": "FUT",
    "commodity": "CMD",
}


def instrument_key(
    exchange: str,
    asset_class: str,
    symbol: str,
    expiry: date | None = None,
    strike: float | None = None,
    option_type: str | None = None,
) -> str:
    parts = [exchange, _ABBR[asset_class], symbol]
    if expiry is not None:
        parts.append(expiry.isoformat())
    if strike is not None:
        parts.append(f"{strike:g}")
    if option_type is not None:
        parts.append(option_type)
    return ":".join(parts)


def register(con: duckdb.DuckDBPyConnection, specs: list[InstrumentSpec]) -> dict[str, int]:
    """Insert any new instruments (underlyings first, so derivatives can point at them)
    and aliases; return {instrument_key: instrument_id} for every spec passed."""
    if not specs:
        return {}
    unique = {s.key: s for s in specs}
    # Underlyings referenced but not passed in get registered as bare rows.
    for s in list(unique.values()):
        if s.underlying_key and s.underlying_key not in unique:
            ex, abbr, sym = s.underlying_key.split(":")[:3]
            asset = {v: k for k, v in _ABBR.items()}[abbr]
            unique[s.underlying_key] = InstrumentSpec(asset, ex, sym)

    ordered = sorted(unique.values(), key=lambda s: s.underlying_key is not None)
    rows = pa.Table.from_pylist(
        [
            {
                "instrument_key": s.key,
                "asset_class": s.asset_class,
                "exchange": s.exchange,
                "symbol": s.symbol,
                "expiry": s.expiry,
                "strike": s.strike,
                "option_type": s.option_type,
                "lot_size": s.lot_size,
                "underlying_key": s.underlying_key,
                "company_id": s.company_id,
            }
            for s in ordered
        ],
        schema=pa.schema(
            [
                ("instrument_key", pa.string()),
                ("asset_class", pa.string()),
                ("exchange", pa.string()),
                ("symbol", pa.string()),
                ("expiry", pa.date32()),
                ("strike", pa.float64()),
                ("option_type", pa.string()),
                ("lot_size", pa.int32()),
                ("underlying_key", pa.string()),
                ("company_id", pa.string()),
            ]
        ),
    )
    con.register("_new_instruments", rows)
    try:
        # Two passes: rows without an underlying first, then derivatives, so the
        # underlying_id lookup always finds its parent.
        for derivatives in (False, True):
            con.execute(
                f"""
                INSERT INTO instruments (instrument_key, asset_class, exchange, symbol,
                    underlying_id, expiry, strike, option_type, lot_size, company_id)
                SELECT n.instrument_key, n.asset_class, n.exchange, n.symbol,
                       u.instrument_id, n.expiry, n.strike, n.option_type, n.lot_size, n.company_id
                FROM _new_instruments n
                LEFT JOIN instruments u ON u.instrument_key = n.underlying_key
                WHERE (n.underlying_key IS {"NOT" if derivatives else ""} NULL)
                  AND n.instrument_key NOT IN (SELECT instrument_key FROM instruments)
                """
            )
        ids = dict(
            con.execute(
                "SELECT i.instrument_key, i.instrument_id FROM instruments i "
                "JOIN _new_instruments n USING (instrument_key)"
            ).fetchall()
        )
    finally:
        con.unregister("_new_instruments")

    aliases = [
        (s.vendor, s.vendor_symbol, ids[s.key])
        for s in unique.values()
        if s.vendor and s.vendor_symbol
    ]
    if aliases:
        # One bulk INSERT ... SELECT, not `executemany`: DuckDB runs that as one statement per
        # row, and against this composite-key table that measured ~4 ms/row (10,000 aliases:
        # 43 s vs 0.03 s) - and a daily fetch registers every listed contract. ON CONFLICT DO
        # NOTHING behaves the same: an existing alias, or a repeat inside this batch, is ignored
        # and the first one wins.
        con.register(
            "_new_aliases",
            pa.table(
                {
                    "vendor": pa.array([a[0] for a in aliases], pa.string()),
                    "vendor_symbol": pa.array([a[1] for a in aliases], pa.string()),
                    "instrument_id": pa.array([a[2] for a in aliases], pa.int64()),
                }
            ),
        )
        try:
            con.execute(
                "INSERT INTO instrument_aliases (vendor, vendor_symbol, instrument_id) "
                "SELECT vendor, vendor_symbol, instrument_id FROM _new_aliases "
                "ON CONFLICT DO NOTHING"
            )
        finally:
            con.unregister("_new_aliases")
    return {s.key: ids[s.key] for s in specs}
