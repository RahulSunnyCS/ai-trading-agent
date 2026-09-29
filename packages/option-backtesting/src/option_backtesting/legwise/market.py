"""
One trading day of Fyers 1-minute data on a fixed 375-minute grid
(09:15..15:29, index 0..374). Bars after 15:29 (the F&O closing session Fyers
also returns) are dropped. A minute with no trade repeats the previous close
as O=H=L=C; minutes before a contract's first trade are None.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

SESSION_START_MIN = 9 * 60 + 15
N_MINUTES = 375
IST_OFFSET_S = 5 * 3600 + 1800


def minute_index(hhmm: str) -> int:
    hours, minutes = map(int, hhmm.split(":"))
    return hours * 60 + minutes - SESSION_START_MIN


def minute_label(index: int) -> str:
    total = SESSION_START_MIN + index
    return f"{total // 60:02d}:{total % 60:02d}"


@dataclass
class Series:
    open: list[float | None]
    high: list[float | None]
    low: list[float | None]
    close: list[float | None]

    @classmethod
    def empty(cls) -> Series:
        return cls([None] * N_MINUTES, [None] * N_MINUTES, [None] * N_MINUTES, [None] * N_MINUTES)

    def forward_fill(self) -> Series:
        last: float | None = None
        for i in range(N_MINUTES):
            if self.close[i] is None:
                if last is not None:
                    self.open[i] = self.high[i] = self.low[i] = self.close[i] = last
            else:
                last = self.close[i]
        return self

    def price_at(self, minute: int) -> float | None:
        """The price at the START of `minute` — that minute's open."""
        return self.open[minute]


ContractKey = tuple[date, float, str]  # (expiry, strike, "CE" | "PE")


@dataclass
class DayData:
    day: date
    underlying: str
    spot: Series
    chain: dict[ContractKey, Series]
    #: Every expiry listed that day for this underlying (from the symbol
    #: master), not just the collected ones — needed to tell weekly from monthly.
    listed_expiries: list[date]
    master_lot_size: int | None
    vix: Series | None = None
    notes: list[str] = field(default_factory=list)

    def collected_expiries(self) -> list[date]:
        return sorted({key[0] for key in self.chain})


def _minutes(table: pa.Table) -> list[int]:
    # Parquet has no second-precision timestamp, so files written as
    # timestamp("s") come back as "ms" — normalise whatever unit is stored.
    ts = table.column("ts").cast(pa.timestamp("s", tz="UTC"))
    epochs = ts.cast(pa.int64()).to_pylist()
    return [((e + IST_OFFSET_S) % 86400) // 60 - SESSION_START_MIN for e in epochs]


def _fill_series(
    series: Series, minutes: list[int], cols: dict[str, list], rows: list[int]
) -> None:
    for r in rows:
        m = minutes[r]
        if 0 <= m < N_MINUTES:
            series.open[m] = cols["open"][r]
            series.high[m] = cols["high"][r]
            series.low[m] = cols["low"][r]
            series.close[m] = cols["close"][r]


def _load_bars(path: Path) -> Series | None:
    if not path.exists():
        return None
    table = pq.read_table(path, columns=["ts", "open", "high", "low", "close"])
    cols = {name: table.column(name).to_pylist() for name in ("open", "high", "low", "close")}
    series = Series.empty()
    _fill_series(series, _minutes(table), cols, list(range(table.num_rows)))
    return series.forward_fill()


def available_days(root: Path, underlying: str) -> list[date]:
    folder = root / "1m" / "opt" / underlying
    return sorted(date.fromisoformat(p.stem) for p in folder.glob("*.parquet"))


def load_day(root: Path, underlying: str, day: date) -> DayData:
    spot = _load_bars(root / "1m" / "index" / underlying / f"{day}.parquet")
    opt_path = root / "1m" / "opt" / underlying / f"{day}.parquet"
    if spot is None or not opt_path.exists():
        raise FileNotFoundError(f"no Fyers data for {underlying} on {day} under {root}")

    table = pq.read_table(opt_path)
    minutes = _minutes(table)
    cols = {name: table.column(name).to_pylist() for name in ("open", "high", "low", "close")}
    expiries = table.column("expiry").to_pylist()
    strikes = table.column("strike").to_pylist()
    types = table.column("option_type").to_pylist()
    rows_by_key: dict[ContractKey, list[int]] = {}
    for r in range(table.num_rows):
        rows_by_key.setdefault((expiries[r], strikes[r], types[r]), []).append(r)
    chain: dict[ContractKey, Series] = {}
    for key, rows in rows_by_key.items():
        series = Series.empty()
        _fill_series(series, minutes, cols, rows)
        chain[key] = series.forward_fill()

    listed: list[date] = []
    lot: int | None = None
    symbols_path = root / "symbols" / f"{day}.parquet"
    if symbols_path.exists():
        symbols = pq.read_table(symbols_path).to_pylist()
        mine = [s for s in symbols if s["underlying"] == underlying and s["option_type"] != "FUT"]
        listed = sorted({s["expiry"] for s in mine})
        lot = mine[0]["lot_size"] if mine else None

    return DayData(
        day=day,
        underlying=underlying,
        spot=spot,
        chain=chain,
        listed_expiries=listed or sorted({k[0] for k in chain}),
        master_lot_size=lot,
        vix=_load_bars(root / "1m" / "index" / "INDIAVIX" / f"{day}.parquet"),
    )


def pick_expiry(day: DayData, kind: str) -> date | None:
    """weekly = nearest listed expiry on/after the day; next_weekly = the one
    after; monthly = the nearest expiry that is the last one listed in its
    calendar month."""
    upcoming = [e for e in day.listed_expiries if e >= day.day]
    if not upcoming:
        return None
    if kind == "weekly":
        return upcoming[0]
    if kind == "next_weekly":
        return upcoming[1] if len(upcoming) > 1 else None
    for e in upcoming:
        if not any(o > e and (o.year, o.month) == (e.year, e.month) for o in day.listed_expiries):
            return e
    return None
