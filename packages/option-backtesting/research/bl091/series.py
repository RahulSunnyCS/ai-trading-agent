"""BL-091 Phase 1: the rolling (dynamic) ATM straddle at one-minute cadence, and its spliced form.

Rolling ATM (E.1): at minute m the ATM strike is the index's close of bar m rounded half-up to the
strike step (the same rounding as the engine's resolve_strike and derived.straddle_series_5m), on the
nearest expiry present in the day's file (min expiry >= day). The straddle is that pair's CE + PE
at m, each leg priced at its last real trade (a bar with volume > 0) if that trade is at most
FRESH_MINUTES old, else unpriced. The vendor files repeat a contract's last close as zero-volume bars
all day, so without this a strike that last traded hours earlier keeps its old price and an ATM
switch onto it looks like a spike (SENSEX expiry day 2025-01-14: 6 -> 98 at 15:21). Everything at m
uses bars stamped <= m.

Level (the episode series since 2026-10-11): the rolling ATM straddle itself, as the owner defined it
("the 24,000 straddle at 159 ... the 24,100 straddle at 180"), so a strike switch counts as movement.
A minute with no priced pair holds the last value and is flagged `missing`.

Spliced (kept as a diagnostic only): the running total of within-strike minute changes, dropping the
jump at each switch. The smoke run showed it drifts down at every switch (the pair left behind is the
nearer one, so the dropped gap has one sign): SENSEX 2025-01-10 fell 261 points spliced against 143
in the rolling straddle by 14:11. It is therefore not the episode series.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from periods import M_0920, M_1528, STEP, assert_learning_day
from trading_data import lake

from option_backtesting.data.resolver import _round_half_up
from option_backtesting.legwise.market import N_MINUTES, _load_bars, _minutes

Key = tuple[float, str]  # (strike, "CE" | "PE")
FRESH_MINUTES = 5  # a leg's last real trade must be this recent to price it


@dataclass
class ChainDay:
    day: date
    underlying: str
    expiry: date
    step: float
    spot: list[float | None]  # index close per minute, forward-filled
    close: dict[Key, list[float | None]]  # nearest expiry; last real trade within FRESH_MINUTES
    real: dict[Key, list[bool]]  # a bar exists at m and its volume is not 0
    n_rows: int = 0


def _ffill(values: list[float | None], max_age: int | None = None) -> list[float | None]:
    """Forward-fill; with max_age a value older than max_age minutes becomes None."""
    out: list[float | None] = []
    last: float | None = None
    age = 0
    for v in values:
        if v is not None:
            last, age = v, 0
        else:
            age += 1
        out.append(last if max_age is None or age <= max_age else None)
    return out


def load_chain_day(root: Path, underlying: str, day: date) -> ChainDay:
    assert_learning_day(underlying, day)
    opt = lake.bars_1m_path(root, "option", underlying, day)
    idx = lake.bars_1m_path(root, "index", underlying, day)
    if not opt.exists():
        raise FileNotFoundError(f"no option bars for {underlying} {day}")
    spot_series = _load_bars(idx)
    if spot_series is None:
        raise FileNotFoundError(f"no index bars for {underlying} {day}")
    table = pq.read_table(opt, columns=["ts", "expiry", "strike", "option_type", "close", "volume"])
    future = pc.greater_equal(table["expiry"], pa.scalar(day, pa.date32()))
    upcoming = pc.filter(table["expiry"], future)
    if len(upcoming) == 0:
        raise LookupError(f"no expiry on or after {day} in the {underlying} file")
    expiry = pc.min(upcoming).as_py()
    table = table.filter(pc.equal(table["expiry"], pa.scalar(expiry, pa.date32())))
    minutes = _minutes(table)
    strikes = table.column("strike").to_pylist()
    types = table.column("option_type").to_pylist()
    closes = table.column("close").to_pylist()
    volumes = table.column("volume").to_pylist()
    raw: dict[Key, list[float | None]] = {}
    real: dict[Key, list[bool]] = {}
    for r, m in enumerate(minutes):
        if not 0 <= m < N_MINUTES or closes[r] is None:
            continue
        key = (float(strikes[r]), types[r])
        if key not in raw:
            raw[key] = [None] * N_MINUTES
            real[key] = [False] * N_MINUTES
        traded = volumes[r] is None or volumes[r] > 0
        if traded:
            raw[key][m] = closes[r]
        real[key][m] = real[key][m] or traded
    return ChainDay(
        day=day,
        underlying=underlying,
        expiry=expiry,
        step=STEP[underlying],
        spot=list(spot_series.close),
        close={k: _ffill(v, FRESH_MINUTES) for k, v in raw.items()},
        real=real,
        n_rows=table.num_rows,
    )


@dataclass
class Rolling:
    atm: list[float | None]
    s: list[float | None]  # CE + PE of the rolling ATM pair
    ce: list[float | None]
    pe: list[float | None]
    pair_real: list[bool]


def rolling_atm(spot: list[float | None], step: float) -> list[float | None]:
    return [None if v is None else float(_round_half_up(v, step)) for v in spot]


def rolling_straddle(chain: ChainDay) -> Rolling:
    atm = rolling_atm(chain.spot, chain.step)
    s: list[float | None] = []
    ce_out: list[float | None] = []
    pe_out: list[float | None] = []
    pair_real: list[bool] = []
    for m in range(N_MINUTES):
        k = atm[m]
        ce = chain.close.get((k, "CE")) if k is not None else None
        pe = chain.close.get((k, "PE")) if k is not None else None
        c = ce[m] if ce else None
        p = pe[m] if pe else None
        ce_out.append(c)
        pe_out.append(p)
        s.append(c + p if c is not None and p is not None else None)
        rc = chain.real.get((k, "CE")) if k is not None else None
        rp = chain.real.get((k, "PE")) if k is not None else None
        pair_real.append(bool(rc and rp and rc[m] and rp[m]))
    return Rolling(atm=atm, s=s, ce=ce_out, pe=pe_out, pair_real=pair_real)


@dataclass
class Spliced:
    x: list[float]  # running total of within-strike changes, x[start] = 0
    switch: list[bool] = field(default_factory=list)
    fallback: list[bool] = field(default_factory=list)
    missing: list[bool] = field(default_factory=list)


def splice(rolling: Rolling, chain: ChainDay, start: int = M_0920, end: int = M_1528) -> Spliced:
    n = N_MINUTES
    x = [0.0] * n
    switch = [False] * n
    fallback = [False] * n
    missing = [False] * n
    atm, s = rolling.atm, rolling.s
    if atm[start] is None or s[start] is None:
        missing[start] = True
    for m in range(start + 1, end + 1):
        delta = 0.0
        if atm[m] is None or s[m] is None:
            missing[m] = True
        elif atm[m] == atm[m - 1] and s[m - 1] is not None:
            delta = s[m] - s[m - 1]
        elif atm[m] != atm[m - 1]:
            switch[m] = True
            ce = chain.close.get((atm[m], "CE"))
            pe = chain.close.get((atm[m], "PE"))
            prev_c = ce[m - 1] if ce else None
            prev_p = pe[m - 1] if pe else None
            if prev_c is not None and prev_p is not None:
                delta = s[m] - (prev_c + prev_p)
            else:
                fallback[m] = True
        else:
            missing[m] = True
        x[m] = x[m - 1] + delta
    for m in range(end + 1, n):
        x[m] = x[end]
    return Spliced(x=x, switch=switch, fallback=fallback, missing=missing)


def level(rolling: Rolling, start: int = M_0920, end: int = M_1528) -> Spliced:
    """The rolling ATM straddle held over unpriced minutes, as the episode series."""
    n = N_MINUTES
    x = [0.0] * n
    switch = [False] * n
    missing = [False] * n
    first = next((rolling.s[m] for m in range(start, end + 1) if rolling.s[m] is not None), 0.0)
    last = first
    for m in range(start, end + 1):
        v = rolling.s[m]
        if v is None:
            missing[m] = True
            v = last
        last = v
        x[m] = v
        if m > start and rolling.atm[m] is not None and rolling.atm[m - 1] is not None:
            switch[m] = rolling.atm[m] != rolling.atm[m - 1]
    for m in range(start):
        x[m] = x[start]
    for m in range(end + 1, n):
        x[m] = x[end]
    return Spliced(x=x, switch=switch, fallback=[False] * n, missing=missing)


def stale_mask(pair_real: list[bool], run: int = 3) -> list[bool]:
    """True at m when the rolling pair has had no real bar (a missing or zero-volume bar on either
    leg) for the last `run` minutes ending at m. A flag on the episode, never a suppression."""
    out = [False] * len(pair_real)
    gap = 0
    for m, ok in enumerate(pair_real):
        gap = 0 if ok else gap + 1
        out[m] = gap >= run
    return out
