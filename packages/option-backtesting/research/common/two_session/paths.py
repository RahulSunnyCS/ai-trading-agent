"""Record a variant-day: the engine's per-minute MTM path, the trades (for charges under an
overlay) and the full-run result. One .npz per variant under PATHS_ROOT/<part>/."""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.legwise.engine import DayResult
from option_backtesting.legwise.market import N_MINUTES
from option_backtesting.rotation.portfolio import member_from_curve

PATHS_ROOT = Path(os.environ.get("BL185_PATHS", "/Volumes/TradingData/research/bl185/paths"))
MAX_TRADES = 8
#: events columns: entry_min, exit_min (-1 = open at the full run's end), side (+1 sold, -1 bought),
#: qty, entry_price, exit_price (nan if open)
EV_COLS = 6


def path_of(r: DayResult) -> np.ndarray:
    """The 375-minute MTM path in rupees, float64 (the engine's own values: multiples of a tick
    times the lot, exact)."""
    return np.asarray(member_from_curve("x", 1, r.mtm, r.gross).pnl, dtype=np.float64)


def to_paise(path: np.ndarray) -> np.ndarray:
    """Stored as int32 paise: exact, 4 bytes a minute (float32 rounds a 1,499.99 to 1,500 and
    fires a target a minute early)."""
    return np.rint(np.asarray(path, dtype=np.float64) * 100.0).astype(np.int32)


def events_of(r: DayResult) -> np.ndarray:
    ev = np.full((MAX_TRADES, EV_COLS), np.nan, dtype=np.float32)
    for i, t in enumerate(r.trades[:MAX_TRADES]):
        ev[i] = [t.entry_min, -1 if t.exit_min is None else t.exit_min, 1 if t.position == "sell" else -1,
                 t.qty, t.entry_price, np.nan if t.exit_price is None else t.exit_price]  # fmt: skip
    return ev


class Recorder:
    def __init__(self) -> None:
        self.days: list[str] = []
        self.paths: list[np.ndarray] = []
        self.events: list[np.ndarray] = []
        self.gross: list[float] = []
        self.charges: list[float] = []
        self.orders: list[int] = []
        self.stopped: list[str] = []

    def add(self, d: date, r: DayResult, charges: float, orders: int) -> None:
        self.days.append(d.isoformat())
        self.paths.append(
            to_paise(path_of(r))
        )  # int32 at once: a part holds 360 variants x 500 days
        self.events.append(events_of(r))
        self.gross.append(r.gross)
        self.charges.append(charges)
        self.orders.append(orders)
        self.stopped.append(r.stopped_by or "")

    def save(self, file: Path) -> None:
        file.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            file,
            days=np.array(self.days),
            path=np.array(self.paths, dtype=np.int32).reshape(len(self.days), N_MINUTES),
            events=np.array(self.events, dtype=np.float32).reshape(
                len(self.days), MAX_TRADES, EV_COLS
            ),
            gross=np.array(self.gross, dtype=np.float64),
            charges=np.array(self.charges, dtype=np.float64),
            orders=np.array(self.orders, dtype=np.int32),
            stopped=np.array(self.stopped),
        )


def load(file: Path) -> dict:
    """The recorded arrays; `path` back in rupees (float64)."""
    z = np.load(file, allow_pickle=False)
    out = {k: z[k] for k in z.files}
    out["path"] = out["path"].astype(np.float64) / 100.0
    return out
