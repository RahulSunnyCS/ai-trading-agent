"""One day of the straddle heatmap: for each entry time and stop loss, a short ATM CE + PE sold
at the entry minute, each leg with its own stop at `sl`% above its entry price, both exited at
the exit time (15:30, the close of the last 1-minute bar, or 15:15) unless stopped.

The fills are the legwise engine's (legwise/engine.py), restated for a fixed two-leg shape so a
whole grid is cheap:

- entry at `Series.price_at(entry)`: the close of the minute before, as AlgoTest reads it;
- the stop level is `to_tick(entry * (1 + sl/100))` for a sold option;
- from the entry minute on, a bar whose high reaches the level stops the leg at the level, or at
  the bar's open if it gapped through; the entry minute's own bar is checked too, as the engine
  does;
- an unstopped leg exits at `exit` (the price at that minute; the last bar's close for 15:30);
  P&L is entry minus exit in points per unit.

Legs are independent (the engine's `square_off: partial`), with no slippage and no costs, so the
numbers are gross. `tests/unit/test_heatmap.py` pins this to `simulate_day` on the same day.

ATM: for the five indices the strike is `resolve_strike("ATM")` from the index spot, as the engine
does. A stock has no spot bars and no strike step in the lake, so its ATM is the strike with the
smallest |CE - PE| at the entry minute (put-call parity puts that at the money) among strikes
that have both quotes, and the step is the chain's smallest strike gap.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq
from trading_data import lake

from ..data.providers.base import Right
from ..data.reference.loader import ReferenceData, default_reference_data
from ..data.resolver import resolve_strike
from ..legwise.engine import to_tick
from ..legwise.market import (
    N_MINUTES,
    ContractKey,
    Series,
    _fill_series,
    _minutes,
    load_day,
    minute_index,
    pick_expiry,
)

#: AlgoTest's heatmap rows: 09:16, then every half hour from 09:45 to 14:45.
ENTRY_TIMES = (
    "09:16", "09:45", "10:15", "10:45", "11:15", "11:45",
    "12:15", "12:45", "13:15", "13:45", "14:15", "14:45",
)  # fmt: skip
STOP_LOSSES = tuple(range(10, 101, 10))
#: Exit times a grid is built for. 15:30 is the end of the 375-minute grid (legs not stopped exit at
#: the last bar's close; the owner's choice). AlgoTest's own heatmap squares off at 15:15 — its
#: 26 Aug 2026 NIFTY grid reproduces from the lake at that time, not at 15:30.
EXIT_TIMES = ("15:30", "15:15")
EXIT_TIME = EXIT_TIMES[0]
INDEXES = ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX")
#: indices that trade the nearest weekly; every other index and every stock trades the monthly.
WEEKLY = ("NIFTY", "SENSEX")


@dataclass(frozen=True)
class Cell:
    day: date
    time: str
    exit: str
    sl: int
    strike: float
    expiry: date
    ce_entry: float
    pe_entry: float
    ce_pts: float
    pe_pts: float
    ce_stopped: bool
    pe_stopped: bool


def is_index(underlying: str) -> bool:
    return underlying in INDEXES


def expiry_kind(underlying: str) -> str:
    return "weekly" if underlying in WEEKLY else "monthly"


def _sell_leg(
    series: Series, entry: int, sl: int, exit_min: int
) -> tuple[float, float, bool] | None:
    """(entry price, P&L points, stopped) for one sold option, or None if it has no price."""
    price = series.price_at(entry)
    if price is None:
        return None
    level = to_tick(price * (1 + sl / 100))
    for m in range(entry, min(exit_min, N_MINUTES)):
        high, op = series.high[m], series.open[m]
        if high is not None and op is not None and high >= level:
            return price, price - (op if op >= level else level), True
    last = series.price_at(exit_min) if exit_min < N_MINUTES else series.close[N_MINUTES - 1]
    if last is None:
        return None
    return price, price - last, False


def _chain_only(root: Path, underlying: str, day: date) -> dict[ContractKey, Series]:
    table = pq.read_table(lake.bars_1m_path(root, "option", underlying, day))
    minutes = _minutes(table)
    cols = {n: table.column(n).to_pylist() for n in ("open", "high", "low", "close")}
    expiries = table.column("expiry").to_pylist()
    strikes = table.column("strike").to_pylist()
    types = table.column("option_type").to_pylist()
    rows: dict[ContractKey, list[int]] = {}
    for r in range(table.num_rows):
        rows.setdefault((expiries[r], float(strikes[r]), types[r]), []).append(r)
    chain: dict[ContractKey, Series] = {}
    for key, rs in rows.items():
        s = Series.empty()
        _fill_series(s, minutes, cols, rs)
        chain[key] = s.forward_fill()
    return chain


def _parity_strike(chain: dict[ContractKey, Series], expiry: date, minute: int) -> float | None:
    best: tuple[float, float] | None = None
    for (e, strike, kind), ce in chain.items():
        if e != expiry or kind != "CE":
            continue
        pe = chain.get((e, strike, "PE"))
        a, b = ce.price_at(minute), pe.price_at(minute) if pe else None
        if a is None or b is None:
            continue
        gap = abs(a - b)
        if best is None or gap < best[0]:
            best = (gap, strike)
    return best[1] if best else None


def cells_from(
    underlying: str,
    day: date,
    chain: dict[ContractKey, Series],
    spot: Series | None,
    expiry: date,
    reference: ReferenceData,
) -> tuple[list[Cell], list[str]]:
    """The grid for one day's chain. `spot` is the index spot (the engine's ATM), or None for a
    stock (put-call parity)."""
    notes: list[str] = []
    out: list[Cell] = []
    for hhmm in ENTRY_TIMES:
        minute = minute_index(hhmm)
        strike: float | None
        if spot is not None:
            px = spot.price_at(minute)
            strike = (
                resolve_strike(
                    underlying, "ATM", Right.CE, px, as_of=day, reference=reference
                ).strike
                if px is not None
                else None
            )
        else:
            strike = _parity_strike(chain, expiry, minute)
        ce_s = chain.get((expiry, float(strike), "CE")) if strike is not None else None
        pe_s = chain.get((expiry, float(strike), "PE")) if strike is not None else None
        if strike is None or ce_s is None or pe_s is None:
            notes.append(f"{hhmm}: no ATM straddle in the chain")
            continue
        for exit_time in EXIT_TIMES:
            exit_min = minute_index(exit_time)
            for sl in STOP_LOSSES:
                ce = _sell_leg(ce_s, minute, sl, exit_min)
                pe = _sell_leg(pe_s, minute, sl, exit_min)
                if ce is None or pe is None:
                    notes.append(f"{hhmm} SL{sl}: a leg has no price")
                    continue
                out.append(
                    Cell(
                        day,
                        hhmm,
                        exit_time,
                        sl,
                        float(strike),
                        expiry,
                        ce[0],
                        pe[0],
                        ce[1],
                        pe[1],
                        ce[2],
                        pe[2],
                    )  # fmt: skip
                )
    return out, notes


def day_cells(
    root: Path,
    underlying: str,
    day: date,
    reference: ReferenceData | None = None,
) -> tuple[list[Cell], list[str]]:
    """Every (entry time, exit time, SL) cell of one day and the notes on what could not be made."""
    reference = reference or default_reference_data()
    spot: Series | None = None
    if is_index(underlying):
        data = load_day(root, underlying, day)
        chain, spot = data.chain, data.spot
        expiry = pick_expiry(data, expiry_kind(underlying))
    else:
        chain = _chain_only(root, underlying, day)
        expiries = sorted({k[0] for k in chain if k[0] >= day})
        expiry = expiries[0] if expiries else None
    if expiry is None:
        return [], [f"no {expiry_kind(underlying)} expiry listed"]
    return cells_from(underlying, day, chain, spot, expiry, reference)
