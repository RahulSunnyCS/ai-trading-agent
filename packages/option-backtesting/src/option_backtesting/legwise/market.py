"""
One trading day of Fyers 1-minute data on a fixed minute grid: for NSE/BSE indices
375 minutes (09:15..15:29, index 0..374; bars after 15:29, the F&O closing session Fyers
also returns, are dropped); for MCX commodity options (BL-218) 895 minutes (09:00..23:54, the
latest close MCX keeps; a summer day simply has no bars after 23:29). A minute with no trade
repeats the previous close as O=H=L=C; minutes before a contract's first trade are None.

MCX options settle on a future, so an MCX day's "spot" is the 1-minute bars of the future the
nearest option expiry settles on (`lake/bars_1m/asset=future/underlying=<ROOT>`, written by
`obt fyers mcx-futures`); there is no VIX.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute
import pyarrow.parquet as pq
from trading_data import derived, lake, quality

from .schema import MCX_UNDERLYINGS

log = logging.getLogger(__name__)

SESSION_START_MIN = 9 * 60 + 15
N_MINUTES = 375
IST_OFFSET_S = 5 * 3600 + 1800

#: MCX commodity option roots the engine can run (BL-218, `schema.MCX_UNDERLYINGS`) and
#: their session grid.
MCX_SESSION_START_MIN = 9 * 60
MCX_N_MINUTES = 895  # 09:00..23:54


def session(underlying: str) -> tuple[int, int]:
    """(first minute of the day, minutes in the grid) for an underlying's exchange."""
    if underlying in MCX_UNDERLYINGS:
        return MCX_SESSION_START_MIN, MCX_N_MINUTES
    return SESSION_START_MIN, N_MINUTES


def session_bounds(underlying: str) -> tuple[str, str]:
    """The first and last minute ("HH:MM") a strategy on this underlying may name."""
    start, n = session(underlying)
    return minute_label(0, start), minute_label(n - 1, start)


def minute_index(hhmm: str, start: int = SESSION_START_MIN) -> int:
    hours, minutes = map(int, hhmm.split(":"))
    return hours * 60 + minutes - start


def minute_label(index: int, start: int = SESSION_START_MIN) -> str:
    total = start + index
    return f"{total // 60:02d}:{total % 60:02d}"


@dataclass
class Series:
    open: list[float | None]
    high: list[float | None]
    low: list[float | None]
    close: list[float | None]

    @classmethod
    def empty(cls, n: int = N_MINUTES) -> Series:
        return cls([None] * n, [None] * n, [None] * n, [None] * n)

    def forward_fill(self) -> Series:
        last: float | None = None
        for i in range(len(self.close)):
            if self.close[i] is None:
                if last is not None:
                    self.open[i] = self.high[i] = self.low[i] = self.close[i] = last
            else:
                last = self.close[i]
        return self

    def price_at(self, minute: int) -> float | None:
        """The price at time `minute` (its start): the CLOSE of the bar that ends then (the
        previous minute's), as AlgoTest reads it — its candle stamped T is the bar that starts
        at T-1 and its fills at T use that candle's close (BL-009 Phase 1, verified against
        AlgoTest's own candles and trade log). At 09:15 there is no earlier bar: the open."""
        if minute > 0 and self.close[minute - 1] is not None:
            return self.close[minute - 1]
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
    #: the grid's first minute of the day (09:15 NSE/BSE, 09:00 MCX)
    session_start: int = SESSION_START_MIN

    @property
    def n_minutes(self) -> int:
        return len(self.spot.close)

    def collected_expiries(self) -> list[date]:
        return sorted({key[0] for key in self.chain})


def _minutes(table: pa.Table, start: int = SESSION_START_MIN) -> list[int]:
    # Parquet has no second-precision timestamp, so files written as
    # timestamp("s") come back as "ms" — normalise whatever unit is stored.
    ts = table.column("ts").cast(pa.timestamp("s", tz="UTC"))
    epochs = ts.cast(pa.int64()).to_pylist()
    return [((e + IST_OFFSET_S) % 86400) // 60 - start for e in epochs]


def _fill_series(
    series: Series, minutes: list[int], cols: dict[str, list], rows: list[int]
) -> None:
    n = len(series.close)
    for r in rows:
        m = minutes[r]
        if 0 <= m < n:
            series.open[m] = cols["open"][r]
            series.high[m] = cols["high"][r]
            series.low[m] = cols["low"][r]
            series.close[m] = cols["close"][r]


def _load_bars(
    path: Path, start: int = SESSION_START_MIN, n: int = N_MINUTES, symbol: str | None = None
) -> Series | None:
    """One instrument's bars from a bars_1m file (`symbol`: only that vendor_symbol's rows, for
    a file that holds more than one future)."""
    if not path.exists():
        return None
    columns = ["ts", "open", "high", "low", "close"] + (["vendor_symbol"] if symbol else [])
    table = pq.read_table(path, columns=columns)
    if symbol is not None:
        table = table.filter(pa.compute.equal(table.column("vendor_symbol"), symbol))
        if table.num_rows == 0:
            return None
    cols = {name: table.column(name).to_pylist() for name in ("open", "high", "low", "close")}
    series = Series.empty(n)
    _fill_series(series, _minutes(table, start), cols, list(range(table.num_rows)))
    return series.forward_fill()


@lru_cache(maxsize=16)
def _future_last_days(root: Path, underlying: str) -> dict[str, date]:
    """{future symbol: the last day the lake holds it} for an MCX root. A future's bars run to
    its expiry, so this is each future's expiry for the futures an option expiry needs (the
    pull asks each up to its own expiry, or 10 days past the option's, whichever is first)."""
    folder = root / "lake" / "bars_1m" / "asset=future" / f"underlying={underlying}"
    if not folder.exists():
        return {}
    con = duckdb.connect()
    try:
        rows = con.execute(
            "SELECT vendor_symbol, max(date) FROM read_parquet(?, hive_partitioning = true) "
            "GROUP BY vendor_symbol",
            [str(folder / "date=*" / "data.parquet")],
        ).fetchall()
    finally:
        con.close()
    return {sym: last for sym, last in rows}


def settling_future(root: Path, underlying: str, option_expiry: date) -> str | None:
    """The future an MCX option expiry settles on: of the futures the lake holds, the one whose
    bars end first on or after the option's expiry (`fyers.mcx_futures.settling_future`)."""
    ends = _future_last_days(root, underlying)
    after = sorted((last, sym) for sym, last in ends.items() if last >= option_expiry)
    return after[0][1] if after else None


def available_days(root: Path, underlying: str) -> list[date]:
    return lake.available_days(root, "option", underlying)


def backtest_days(
    root: Path,
    underlying: str,
    start: date | None = None,
    end: date | None = None,
    include_excluded: bool = False,
) -> tuple[list[date], dict[date, str]]:
    """The days a backtest runs on, and the ones it leaves out with the reason.

    Every option day in [start, end], minus the days `data_quality` excludes (short or
    special sessions, thin chains, no index spot — see trading_data.quality.verdict), unless
    `include_excluded`. Read from the lock-free verdict file; with no file yet every day runs
    and a warning says so."""
    days = [
        d
        for d in available_days(root, underlying)
        if not ((start and d < start) or (end and d > end))
    ]
    if include_excluded:
        return days, {}
    excluded = quality.excluded_days(root, "option", underlying)
    if excluded is None:
        log.warning(
            "no data_quality verdict file under %s — running every day; "
            "`tdata quality export` creates it",
            root,
        )
        return days, {}
    return (
        [d for d in days if d not in excluded],
        {d: f"excluded: {excluded[d]}" for d in days if d in excluded},
    )


def master_options(root: Path, underlying: str, day: date) -> list[dict]:
    """The day's Fyers symbol-master rows for the underlying's options (futures left out); [] when
    there is no master for the day (the vendor days)."""
    symbols_path = lake.symbol_master_path(root, "fyers", day)
    if not symbols_path.exists():
        return []
    symbols = pq.read_table(symbols_path).to_pylist()
    return [s for s in symbols if s["underlying"] == underlying and s["option_type"] != "FUT"]


def listed_expiries(root: Path, underlying: str, day: date) -> list[date] | None:
    """The expiries `load_day` lists for the day, without loading the bars: the symbol master's,
    else those in the day's option file (which, on a vendor day, includes long-dated contracts).
    None without an option file."""
    opt_path = lake.bars_1m_path(root, "option", underlying, day)
    if not opt_path.exists():
        return None
    listed = {s["expiry"] for s in master_options(root, underlying, day)}
    if not listed:
        listed = set(pq.read_table(opt_path, columns=["expiry"]).column("expiry").to_pylist())
    return sorted(listed)


def load_day(root: Path, underlying: str, day: date) -> DayData:
    if underlying in MCX_UNDERLYINGS:
        return _load_mcx_day(root, underlying, day)
    spot = _load_bars(lake.bars_1m_path(root, "index", underlying, day))
    opt_path = lake.bars_1m_path(root, "option", underlying, day)
    if spot is None or not opt_path.exists():
        raise FileNotFoundError(f"no Fyers data for {underlying} on {day} under {root}")
    chain = _load_chain(opt_path, SESSION_START_MIN, N_MINUTES)

    mine = master_options(root, underlying, day)
    listed = sorted({s["expiry"] for s in mine})
    lot = mine[0]["lot_size"] if mine else None

    return DayData(
        day=day,
        underlying=underlying,
        spot=spot,
        chain=chain,
        listed_expiries=listed or sorted({k[0] for k in chain}),
        master_lot_size=lot,
        vix=_load_bars(lake.bars_1m_path(root, "index", "INDIAVIX", day)),
    )


def _load_mcx_day(root: Path, underlying: str, day: date) -> DayData:
    """An MCX day: the option chain on the 09:00..23:54 grid, and as spot the future the
    nearest option expiry settles on. Listed expiries are the chain's (MCX has no Fyers
    master in the lake; the expiring contract trades every day of its last weeks)."""
    start, n = session(underlying)
    opt_path = lake.bars_1m_path(root, "option", underlying, day)
    if not opt_path.exists():
        raise FileNotFoundError(f"no option file for {underlying} on {day} under {root}")
    chain = _load_chain(opt_path, start, n)
    listed = sorted({k[0] for k in chain})
    upcoming = [e for e in listed if e >= day]
    future = settling_future(root, underlying, upcoming[0]) if upcoming else None
    spot = (
        _load_bars(lake.bars_1m_path(root, "future", underlying, day), start, n, symbol=future)
        if future
        else None
    )
    if spot is None:
        raise FileNotFoundError(
            f"no future bars for {underlying} on {day} (settling future {future}) under {root}; "
            "`obt fyers mcx-futures` writes them"
        )
    return DayData(
        day=day,
        underlying=underlying,
        spot=spot,
        chain=chain,
        listed_expiries=listed,
        master_lot_size=None,
        vix=None,
        session_start=start,
    )


def _load_chain(opt_path: Path, start: int, n: int) -> dict[ContractKey, Series]:
    table = pq.read_table(opt_path)
    minutes = _minutes(table, start)
    cols = {name: table.column(name).to_pylist() for name in ("open", "high", "low", "close")}
    expiries = table.column("expiry").to_pylist()
    strikes = table.column("strike").to_pylist()
    types = table.column("option_type").to_pylist()
    rows_by_key: dict[ContractKey, list[int]] = {}
    for r in range(table.num_rows):
        rows_by_key.setdefault((expiries[r], strikes[r], types[r]), []).append(r)
    chain: dict[ContractKey, Series] = {}
    for key, rows in rows_by_key.items():
        series = Series.empty(n)
        _fill_series(series, minutes, cols, rows)
        chain[key] = series.forward_fill()
    return chain


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


#: Bars a backtest can run on: the raw 1-minute lake, or the 5-minute chain snapshots
#: (trading_data.derived, BL-034 Phase 3).
BAR_SIZES = ("1m", "5m")


def snapshot_days(root: Path, underlying: str) -> set[date]:
    return set(derived.available_days(root, "chain_snapshots_5m", underlying))


class UnsupportedOn5m(ValueError):
    """A strategy the 5-minute snapshots cannot run faithfully; use 1-minute bars."""


def check_on_5m_marks(*times: str | None) -> None:
    """5-minute bars can only decide on a window's start: every time must be a multiple of 5
    minutes from 09:15."""
    for t in times:
        if t is not None and minute_index(t) % derived.BUCKET_MINUTES:
            raise UnsupportedOn5m(f"{t} is not on a 5-minute mark; 5-minute bars need :00, :05, …")


def check_strikes_on_5m(legs: list) -> None:
    """The snapshots hold only strikes that came within derived.STRIKES_EACH_SIDE steps of
    the money, so a leg must not need one further out: closest-premium legs (the target may
    sit anywhere in the chain) and OTM/ITM beyond that are refused rather than silently
    resolved inside the band."""
    for leg in legs:
        if leg.strike.closest_premium is not None:
            raise UnsupportedOn5m(
                f"leg {leg.id!r}: closest premium searches the whole chain; 5-minute bars hold "
                f"only ±{derived.STRIKES_EACH_SIDE} strikes — use --bars 1m"
            )
        rule = leg.strike.strike_type or ""
        if rule[:3] in ("OTM", "ITM") and int(rule[3:] or 0) > derived.STRIKES_EACH_SIDE:
            raise UnsupportedOn5m(
                f"leg {leg.id!r}: {rule} is beyond the ±{derived.STRIKES_EACH_SIDE} strikes the "
                "5-minute snapshots hold — use --bars 1m"
            )


def window_close_minute(minute: int) -> int:
    """On 5-minute bars an action at a filler minute (5w+1..5w+4) fills at the window's close,
    i.e. at 5w+5: the minute to report it at."""
    rest = minute % derived.BUCKET_MINUTES
    return minute if rest == 0 else minute - rest + derived.BUCKET_MINUTES


def load_day_5m(root: Path, underlying: str, day: date) -> DayData:
    """A DayData built from chain_snapshots_5m, for the unchanged legwise engine: each window
    sits on its first minute (open = the price at the window's start, high/low/close the
    window's), and its other four minutes hold the window's close. So an entry or exit at a
    window start fills at the same price as on 1-minute bars, a stop is checked against the
    whole window and fills at its trigger (or the window's open if it gapped through), and the
    combined MTM is checked at the window's close. Only the ±10 strikes around each window's
    ATM are present."""
    path = derived.derived_path(root, "chain_snapshots_5m", underlying, day)
    if not path.exists():
        raise FileNotFoundError(f"no 5-minute snapshot for {underlying} on {day}")
    table = pq.read_table(
        path,
        columns=[
            "bucket", "expiry", "strike", "option_type", "open", "high", "low", "close",
            "spot_open", "spot_high", "spot_low", "spot_close", "vix",
        ],
    )  # fmt: skip
    cols = table.to_pydict()
    as_ts = table.rename_columns(["ts" if n == "bucket" else n for n in table.column_names])
    starts = [m - m % derived.BUCKET_MINUTES for m in _minutes(as_ts)]
    spot, vix = Series.empty(), Series.empty()
    chain: dict[ContractKey, Series] = {}

    def place(series: Series, m: int, o, h, lo, c) -> None:
        if c is None or c != c:  # None or NaN: nothing known yet
            return
        if o is not None and o == o:
            series.open[m], series.high[m], series.low[m], series.close[m] = o, h, lo, c
        for k in range(1, derived.BUCKET_MINUTES):
            series.open[m + k] = series.high[m + k] = series.low[m + k] = c
            series.close[m + k] = c

    seen_spot: set[int] = set()
    for r, m in enumerate(starts):
        if m not in seen_spot:
            seen_spot.add(m)
            place(spot, m, cols["spot_open"][r], cols["spot_high"][r], cols["spot_low"][r],
                  cols["spot_close"][r])  # fmt: skip
            v = cols["vix"][r]
            place(vix, m, v, v, v, v)
        key = (cols["expiry"][r], float(cols["strike"][r]), cols["option_type"][r])
        series = chain.get(key)
        if series is None:
            series = chain[key] = Series.empty()
        place(series, m, cols["open"][r], cols["high"][r], cols["low"][r], cols["close"][r])
    has_vix = any(v is not None for v in vix.close)
    return DayData(
        day=day,
        underlying=underlying,
        spot=spot.forward_fill(),
        chain={k: v.forward_fill() for k, v in chain.items()},
        listed_expiries=sorted({k[0] for k in chain}),
        master_lot_size=None,
        vix=vix.forward_fill() if has_vix else None,
    )
