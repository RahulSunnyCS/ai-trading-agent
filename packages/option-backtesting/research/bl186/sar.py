"""BL-186: the arms and filters of Directional stop-and-reverse. Rules:
backlog/BL-186-dir-stop-and-reverse.md, Phase 0 (2026-10-28).

The engine's own `reverse_on_sl` (legwise/engine.py, Phase 1) does the reversal; `FilterSim` only
answers the engine's `_reverse_allowed` hook for the filtered arms. Every filter reads bars that END
before the stop minute: the stop fills inside bar m, so the last completed bar is m - 1 (the price
"at" m, `Series.price_at`). Nothing from bar m or later is read.

Filters (stopped CE = the index went up, stopped PE = down):
- C1 opening-range break: the last completed 5-minute bar's close (5-minute bars from 09:15; the
  one ending at or before m - 1) is above the 09:15-09:30 high (CE) / below its low (PE). Before
  a 5-minute bar after the range has closed, it cannot be.
- C2 VWAP side: the index's close of bar m - 1 is above (CE) / below (PE) the session VWAP over bars
  09:15 .. m - 1. The index has no traded volume and 1-minute futures exist only from 2026-09, so
  each minute's typical price (H + L + C) / 3 is weighted by that minute's traded volume of the
  stopped leg's expiry across the collected option chain (a volume proxy; with no volume at all it
  is the plain time-weighted mean). `C2twap` (secondary) uses equal weights throughout.
- C3 IV rising: the ATM implied volatility of the leg's expiry from bar m - 1's closes is above the
  same from the closes the pick entered on (bar entry - 1). ATM = the collected strike nearest the
  index close with both a call and a put; forward from put-call parity at that strike; Black-76 IV
  of the call (`trading_data.derived.implied_vol`), T to 15:30 on expiry day, a 6% rate (the
  comparison is within one day, so the rate barely matters). No solution at either end = no reverse.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

import numpy as np
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.derived import implied_vol

from option_backtesting.legwise.engine import _DaySim  # noqa: PLC2701
from option_backtesting.legwise.market import N_MINUTES, DayData, minute_index
from option_backtesting.legwise.schema import LegwiseStrategy

IST = ZoneInfo("Asia/Kolkata")
OR_END = 15  # bars 09:15 .. 09:29 make the opening range
RATE = 0.06
YEAR_S = 365.0 * 86400.0
MAIN_STOP = 5000.0

FILTERS = ("B", "C1", "C2", "C3")
EXITS = {
    "T20": {"time_stop_minutes": 20},
    "T30": {"time_stop_minutes": 30},
    "T45": {"time_stop_minutes": 45},
    "TRAIL": {"trail_peak": {"activate_percent": 150, "exit_percent": 80}},
    "HOLD": {},
}
PRIMARY = ("C1_T30", "C2_T30", "C3_T30")


def cell_names() -> list[str]:
    cells = ["A3", "A5"]
    for size in ("", "D-"):
        for f in FILTERS:
            cells += [f"{size}{f}_{e}" for e in EXITS]
    return cells + ["C2twap_T30"]


def parse_cell(cell: str) -> tuple[str, str, float]:
    """'D-C1_T30' -> ('C1', 'T30', 0.5)."""
    ratio = 0.5 if cell.startswith("D-") else 1.0
    f, e = cell.removeprefix("D-").split("_")
    return f, e, ratio


def variant(strategy: LegwiseStrategy, cell: str) -> LegwiseStrategy:
    """The pick's own file under a cell: A3 as is; A5 the overall stop at ₹5,000; every reversal arm
    ₹5,000 plus `reverse_on_sl` on both sold legs (the long's 30% stop, the cell's exit)."""
    if cell == "A3":
        return strategy
    d = strategy.model_dump()
    d["overall"]["stop_loss_inr"] = MAIN_STOP
    if cell != "A5":
        _, e, ratio = parse_cell(cell)
        for leg in d["legs"]:
            leg["reverse_on_sl"] = {"lots_ratio": ratio, "stop_loss_percent": 30, **EXITS[e]}
    return LegwiseStrategy.model_validate(d)


def chain_volume(root, underlying: str, day: date) -> dict[date, np.ndarray]:
    """{expiry: traded option volume per minute index} over the collected chain."""
    table = pq.read_table(
        lake.bars_1m_path(root, "option", underlying, day), columns=["ts", "volume", "expiry"]
    )
    ts = table.column("ts").to_pylist()
    vol = table.column("volume").to_pylist()
    exp = table.column("expiry").to_pylist()
    out: dict[date, np.ndarray] = {}
    for t, v, e in zip(ts, vol, exp, strict=True):
        local = t.astimezone(IST)
        m = local.hour * 60 + local.minute - (9 * 60 + 15)
        if 0 <= m < N_MINUTES and v:
            out.setdefault(e, np.zeros(N_MINUTES))[m] += float(v)
    return out


def _arr(values: list[float | None]) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in values], dtype=float)


class DayFeatures:
    """The filter inputs of one day. `allow` reads only index positions <= m - 1."""

    def __init__(self, data: DayData, volume: dict[date, np.ndarray] | None = None) -> None:
        self.data = data
        self.hi, self.lo, self.cl = _arr(data.spot.high), _arr(data.spot.low), _arr(data.spot.close)
        self.volume = volume or {}
        self._iv: dict[tuple[date, int], float] = {}

    # -- C1 ----------------------------------------------------------------------------------
    def or_break(self, up: bool, m: int) -> bool:
        last = m - 1  # the last completed 1-minute bar
        k = (last + 1) // 5 - 1  # the last 5-minute bar ending at or before it
        end = 5 * k + 4
        if k < 0 or end < OR_END:  # no 5-minute bar after the range has closed yet
            return False
        hi, lo = np.nanmax(self.hi[:OR_END]), np.nanmin(self.lo[:OR_END])
        close = self.cl[end]
        if math.isnan(close):
            return False
        return close > hi if up else close < lo

    # -- C2 ----------------------------------------------------------------------------------
    def vwap_side(self, up: bool, m: int, expiry: date, twap: bool = False) -> bool:
        last = m - 1
        if last < 0:
            return False
        tp = (self.hi[: last + 1] + self.lo[: last + 1] + self.cl[: last + 1]) / 3
        ok = ~np.isnan(tp)
        w = np.ones(last + 1)
        if not twap and expiry in self.volume:
            vw = self.volume[expiry][: last + 1]
            if (vw[ok] > 0).any():
                w = vw
        w = np.where(ok, w, 0.0)
        if w.sum() <= 0:
            return False
        vwap = float((np.where(ok, tp, 0.0) * w).sum() / w.sum())
        close = self.cl[last]
        if math.isnan(close):
            return False
        return close > vwap if up else close < vwap

    # -- C3 ----------------------------------------------------------------------------------
    def atm_iv(self, expiry: date, j: int) -> float:
        """ATM IV from bar j's closes (nan when it cannot be solved)."""
        key = (expiry, j)
        if key in self._iv:
            return self._iv[key]
        out = float("nan")
        spot = self.cl[j] if j >= 0 else float("nan")
        if not math.isnan(spot):
            pairs = []
            for (e, k, kind), s in self.data.chain.items():
                if e != expiry or kind != "CE":
                    continue
                put = self.data.chain.get((e, k, "PE"))
                c = s.close[j]
                p = put.close[j] if put is not None else None
                if c is not None and p is not None:
                    pairs.append((abs(k - spot), k, c, p))
            if pairs:
                _, k, c, p = min(pairs)
                bar_end = datetime.combine(self.data.day, time(9, 15), IST).timestamp() + 60 * (
                    j + 1
                )
                expiry_close = datetime.combine(expiry, time(15, 30), IST).timestamp()
                t = max(expiry_close - bar_end, 60.0) / YEAR_S
                df = math.exp(-RATE * t)
                fwd = k + (c - p) / df
                iv = implied_vol(
                    np.array([c]),
                    np.array([fwd]),
                    np.array([k]),
                    np.array([t]),
                    np.array([df]),
                    np.array([True]),
                )
                out = float(iv[0])
        self._iv[key] = out
        return out

    def iv_rising(self, m: int, entry: int, expiry: date) -> bool:
        now, then = self.atm_iv(expiry, m - 1), self.atm_iv(expiry, entry - 1)
        return not (math.isnan(now) or math.isnan(then)) and now > then

    def allow(self, filt: str, option_type: str, m: int, entry: int, expiry: date) -> bool:
        up = option_type == "CE"
        if filt == "B":
            return True
        if filt == "C1":
            return self.or_break(up, m)
        if filt == "C2":
            return self.vwap_side(up, m, expiry)
        if filt == "C2twap":
            return self.vwap_side(up, m, expiry, twap=True)
        if filt == "C3":
            return self.iv_rising(m, entry, expiry)
        raise ValueError(filt)


class FilterSim(_DaySim):
    """The engine's day simulator; the filter decides each reversal. Decisions are logged."""

    def __init__(self, *args, filt: str = "B", feats: DayFeatures | None = None, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.filt = filt
        self.feats = feats
        self.entry = minute_index(self.s.entry_time)
        self.decisions: list[tuple[str, int, bool]] = []

    def _reverse_allowed(self, run, minute: int) -> bool:
        if self.filt == "B":
            ok = True
        else:
            assert self.feats is not None and run.contract is not None
            ok = self.feats.allow(
                self.filt, run.spec.option_type, minute, self.entry, run.contract[0]
            )
        self.decisions.append((run.spec.id, minute, ok))
        return ok
