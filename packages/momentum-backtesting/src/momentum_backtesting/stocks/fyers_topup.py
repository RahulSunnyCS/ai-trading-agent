"""Fallback weekly top-up via Fyers when NSE's bhavcopy/corporate-actions feed is
unreachable (TODO.md 3.11.16 — see nse.py's module docstring for why NSE itself can be
down for days at a time: Akamai's bot detection, not a permanent block).

**This is a stopgap, not a second data source for the survivorship-free stock layer.**
Fyers has no corporate-actions feed, so it cannot produce a correct total-return price —
only a plain close. The rows this writes use that plain close for BOTH the `tr` and
`price` kinds in `stock_weekly_prices`, which is wrong by exactly the dividend/split
amount for any company that had a corporate action during the gap week (rare for any one
name in any one week). This is an acceptable, bounded, TEMPORARY error because every
table this touches is wholesale-replaced (DELETE + re-insert of the whole table, see
`db_migrate.import_stock_weekly`), never merged, by the next successful `mbt stocks
sync`/`stocks fetch` — so a top-up row never outlives the next real sync.

`run_fyers_topup` covers the Nifty 50 "stock" dataset (`stock_weekly_prices`/
`stock_membership_weekly`). `run_fyers_topup_total_market` covers Broad Momentum/Custom
Index's much larger ~755-symbol Total Market pool (`bars_1d_stock`) the same way, but
writes real daily OHLCV bars (Fyers gives a full bar, not just a close) tagged
`synthetic_close=True` — the same flag `stocks/adjust.py`'s own archive-gap fill already
uses, so the existing guard/stats pipeline (`stocks/guards.py`) already knows to treat
these specially rather than flagging them as suspicious price jumps. Both top-ups write
directly into the shared catalog, bypassing `daily.parquet`/`adjust.build_all` entirely —
intentional, since that pipeline needs NSE's corporate-actions feed to run correctly and
this only exists because that feed is down.
"""

from __future__ import annotations

import csv
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.db import data_root

from .. import db_migrate, fyers
from ..db_read import open_catalog
from ..weekly import IST, week_ending_on_or_before

CURATED_DIR = Path(__file__).parent / "curated"

#: Matches `db_migrate.migrate_stock_bars`'s own output shape exactly (daily.parquet's
#: DAILY_SCHEMA with `symbol` replaced by `instrument_id`) — anything else here would
#: silently create a `bars_1d_stock` partition file the DuckDB view can't read back the
#: same way as the rest.
_BARS_1D_STOCK_SCHEMA = pa.schema(
    [
        pa.field("instrument_id", pa.int64(), nullable=False),
        pa.field("date", pa.date32(), nullable=False),
        pa.field("series", pa.string(), nullable=False),
        pa.field("isin", pa.string(), nullable=True),
        pa.field("open", pa.float64(), nullable=False),
        pa.field("high", pa.float64(), nullable=False),
        pa.field("low", pa.float64(), nullable=False),
        pa.field("close", pa.float64(), nullable=False),
        pa.field("prevclose", pa.float64(), nullable=False),
        pa.field("volume", pa.int64(), nullable=False),
        pa.field("turnover", pa.float64(), nullable=False),
        pa.field("synthetic_close", pa.bool_(), nullable=False),
    ]
)


@dataclass
class TopUpResult:
    week: pd.Timestamp
    companies_updated: int
    companies_skipped: list[str]  # company_id with no Fyers symbol or no fetchable price


@dataclass
class MarketTopUpResult:
    through: pd.Timestamp
    symbols_updated: int
    rows_written: int
    symbols_skipped: list[str]  # no fetchable Fyers price for the whole gap


def _current_aliases() -> dict[str, str]:
    """company_id -> its current (non-superseded) NSE symbol: the alias row whose `to`
    column is blank, one per company_id, same source `stocks/adjust.py` uses."""
    aliases: dict[str, str] = {}
    with (CURATED_DIR / "aliases.csv").open() as f:
        for row in csv.DictReader(f):
            if not row["to"].strip():
                aliases[row["company_id"]] = row["symbol"]
    return aliases


def _current_members(con) -> list[str]:
    """company_id list for the latest known membership week — carried forward as this
    week's membership too (Nifty 50 reconstitution is quarterly, not weekly, so this is
    correct in every ordinary week)."""
    rows = con.execute(
        "SELECT company_id FROM stock_membership_weekly "
        "WHERE week = (SELECT max(week) FROM stock_membership_weekly) AND is_member"
    ).fetchall()
    return [r[0] for r in rows]


def run_fyers_topup(creds: fyers.Credentials, *, now: date | None = None) -> TopUpResult | None:
    """Fill the gap between `stock_weekly_prices`'s latest week and this week's Friday
    with a plain-price proxy, for every currently-listed Nifty 50 company. Returns None
    if the data is already current (nothing to do) — callers should treat that the same
    as success.
    """
    today = now or pd.Timestamp.now(IST).date()
    target_week = week_ending_on_or_before(today)

    # Three steps, the catalog open only for the first and the last: the Fyers calls between
    # them take minutes (a pause per symbol), and `obt daily` / `tdata` wait on the catalog.
    with open_catalog() as con:
        last_week_row = con.execute("SELECT max(week) FROM stock_weekly_prices").fetchone()
        last_week = last_week_row[0] if last_week_row else None
        if last_week is not None and pd.Timestamp(last_week).normalize() >= pd.Timestamp(
            target_week
        ):
            return None  # already current — no top-up needed
        members = _current_members(con)

    aliases = _current_aliases()
    fetch_start = (
        pd.Timestamp(last_week).date() + timedelta(days=1)
        if last_week is not None
        else target_week - timedelta(days=7)
    )

    skipped: list[str] = []
    rows: list[tuple[str, float]] = []
    for company_id in members:
        symbol = aliases.get(company_id)
        if symbol is None:
            skipped.append(company_id)
            continue
        try:
            closes = fyers.daily_closes(f"NSE:{symbol}-EQ", fetch_start, today, creds)
        except Exception:  # noqa: BLE001 - one bad symbol must not fail the whole top-up
            skipped.append(company_id)
            continue
        finally:
            time.sleep(fyers.PAUSE_S)
        if closes.empty:
            skipped.append(company_id)
            continue
        rows.append((company_id, float(closes.iloc[-1])))

    with open_catalog() as con:
        for kind in ("tr", "price"):
            con.execute(
                "DELETE FROM stock_weekly_prices WHERE kind = ? AND week = ?",
                [kind, target_week],
            )
            con.executemany(
                "INSERT INTO stock_weekly_prices (company_id, kind, week, close) "
                "VALUES (?, ?, ?, ?)",
                [(company_id, kind, target_week, close) for company_id, close in rows],
            )
        con.execute("DELETE FROM stock_membership_weekly WHERE week = ?", [target_week])
        con.executemany(
            "INSERT INTO stock_membership_weekly (company_id, week, is_member) VALUES (?, ?, ?)",
            [(company_id, target_week, True) for company_id in members],
        )

    return TopUpResult(
        week=pd.Timestamp(target_week), companies_updated=len(rows), companies_skipped=skipped
    )


def run_fyers_topup_total_market(
    creds: fyers.Credentials,
    categories_data_dir: Path,
    *,
    now: date | None = None,
) -> MarketTopUpResult | None:
    """Fill the gap in `bars_1d_stock` for the current Total Market pool (~755 symbols)
    — what Broad Momentum/Custom Index actually read from
    (`categories/prices.py::load_daily_prices`), as opposed to `run_fyers_topup`'s Nifty
    50-only `stock_weekly_prices`. Returns None if already current. Can take several
    minutes (one Fyers request per symbol, throttled at `fyers.PAUSE_S`)."""
    from ..categories.broad import total_market_members_by_year

    today = now or pd.Timestamp.now(IST).date()
    root = data_root()

    # DuckDB allows only one open connection per process against a given catalog file
    # with a given read-only/read-write configuration — this gate check must close its
    # own connection before `total_market_members_by_year` opens its (read-only) one,
    # and that in turn must close before the write connection below opens, or all three
    # collide with `ConnectionException: ... different configuration`.
    with open_catalog() as con:
        last_date_row = con.execute("SELECT max(date) FROM bars_1d_stock").fetchone()
        last_date = last_date_row[0] if last_date_row else None
    if last_date is not None and pd.Timestamp(last_date).normalize() >= pd.Timestamp(today):
        return None  # already current — no top-up needed

    members_by_year = total_market_members_by_year(categories_data_dir)
    symbols = sorted(members_by_year[max(members_by_year)])
    fetch_start = (
        pd.Timestamp(last_date).date() + timedelta(days=1)
        if last_date is not None
        else today - timedelta(days=7)
    )

    skipped: list[str] = []
    new_rows: list[dict] = []
    for symbol in symbols:
        try:
            bars = fyers.daily_ohlcv(f"NSE:{symbol}-EQ", fetch_start, today, creds)
        except Exception:  # noqa: BLE001 - one bad symbol must not fail the whole top-up
            skipped.append(symbol)
            continue
        finally:
            time.sleep(fyers.PAUSE_S)
        if bars.empty:
            skipped.append(symbol)
            continue
        for day, row in bars.iterrows():
            new_rows.append(
                {
                    "symbol": symbol,
                    "date": day.date(),
                    "series": "EQ",
                    "isin": None,
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    # No real previous-close source here; the prior row's open is the
                    # best available same-fetch proxy rather than leaving it null (the
                    # lake schema requires a value).
                    "prevclose": float(row["open"]),
                    "volume": int(row["volume"]),
                    "turnover": float(row["close"]) * float(row["volume"]),
                    "synthetic_close": True,
                }
            )

    if not new_rows:
        return MarketTopUpResult(
            through=pd.Timestamp(today), symbols_updated=0, rows_written=0, symbols_skipped=skipped
        )

    with open_catalog() as con:
        updated_symbols = sorted({r["symbol"] for r in new_rows})
        instrument_ids = db_migrate.register_stock_instruments(con, updated_symbols, CURATED_DIR)
        for r in new_rows:
            r["instrument_id"] = instrument_ids[r.pop("symbol")]

        by_year: dict[int, list[dict]] = {}
        for r in new_rows:
            by_year.setdefault(r["date"].year, []).append(r)

        for year, rows in by_year.items():
            path = lake.bars_1d_stock_path(root, year)
            new_table = pa.Table.from_pylist(rows, schema=_BARS_1D_STOCK_SCHEMA)
            if path.exists():
                existing = pq.read_table(path, schema=_BARS_1D_STOCK_SCHEMA)
                # Drop any existing (instrument, date) rows this top-up is about to
                # rewrite, so a re-run of the same gap never duplicates rows.
                new_keys = {(r["instrument_id"], r["date"]) for r in rows}
                keep = [
                    (iid, d) not in new_keys
                    for iid, d in zip(
                        existing.column("instrument_id").to_pylist(),
                        existing.column("date").to_pylist(),
                        strict=True,
                    )
                ]
                existing = existing.filter(pa.array(keep))
                combined = pa.concat_tables([existing, new_table])
            else:
                combined = new_table
            lake.write_parquet(combined, path)

    return MarketTopUpResult(
        through=pd.Timestamp(today),
        symbols_updated=len(updated_symbols),
        rows_written=len(new_rows),
        symbols_skipped=skipped,
    )
