"""Index sessions from the lake as a `Frame` for the rule evaluator, plus the ATM-straddle feature
cached on disk (its first build reads every day's option bars)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from ..rotation import triggers as T
from . import expr as E
from . import store

log = logging.getLogger(__name__)

#: sessions are loaded from here so the longest look-back in the grammar (252 prior sessions for a
#: median, the RSI chain, 14 for the ATR) is seeded before the first tested day (BL-083's start)
HISTORY_START = date(2020, 9, 1)
#: option bars exist from here; earlier sessions have no straddle
OPTIONS_FROM = date(2022, 1, 3)
#: the straddle feature is saved this often while it is built, so an interrupted build resumes
CHECKPOINT_DAYS = 100
#: the straddle file's format; 2 = a day with no option file or a failed read is never saved
FEATURE_VERSION = 2


def session_days(root: Path, symbol: str, start: date, end: date) -> list[date]:
    from trading_data import lake

    out: list[date] = []
    d = start
    while d <= end:
        if lake.bars_1m_path(root, "index", symbol, d).exists():
            out.append(d)
        d += timedelta(days=1)
    return out


def load_frame(
    root: Path,
    underlying: str,
    end: date,
    start: date = HISTORY_START,
    strict_open: bool = True,
) -> E.Frame:
    """Index and India VIX sessions from `start` to the last session on or before `end`.

    `strict_open` drops a session that has a bar before 09:15 (a dozen Angel One days), the rule
    BL-083's study used; the production trigger module keeps them."""
    days = session_days(root, underlying, start, end)
    if not days:
        raise store.RuleTestError(f"no {underlying} index sessions between {start} and {end}")
    grid = T.load_grid(root, underlying, days[-1], sessions=len(days), strict_open=strict_open)
    if grid is None:
        raise store.RuleTestError(f"{underlying} index bars could not be read up to {days[-1]}")
    vdays = session_days(root, "INDIAVIX", start, end)
    vix = (
        T.load_grid(root, "INDIAVIX", vdays[-1], sessions=len(vdays), strict_open=strict_open)
        if vdays
        else None
    )
    vclose = np.full((len(grid.days), E.N_BARS), np.nan)
    vopen = np.full(len(grid.days), np.nan)
    if vix is not None:
        at = {d: k for k, d in enumerate(vix.days)}
        for i, d in enumerate(grid.days):
            k = at.get(d)
            if k is not None:
                vclose[i], vopen[i] = vix.C[k], vix.O[k, 0]
    frame = E.Frame(
        days=grid.days, O=grid.O, H=grid.H, L=grid.L, C=grid.C, vix_close=vclose, vix_open=vopen
    )
    frame.straddle_loader = StraddleLoader(root, underlying, frame)
    frame.expiry_loader = ExpiryDayLoader(root, underlying, frame)
    return frame


def nearest_expiry(root: Path, underlying: str, day: date) -> date | None:
    """The nearest listed expiry on or after `day`, as the simulator picks the traded one
    (`legwise.market.load_day` + `pick_expiry(day, "weekly")`): the day's Fyers symbol master when
    there is one, else the expiries in that day's option file. None without an option file."""
    import pyarrow.parquet as pq
    from trading_data import lake

    opt_path = lake.bars_1m_path(root, "option", underlying, day)
    if not opt_path.exists():
        return None
    listed: set[date] = set()
    symbols_path = lake.symbol_master_path(root, "fyers", day)
    if symbols_path.exists():
        table = pq.read_table(symbols_path, columns=["underlying", "option_type", "expiry"])
        listed = {
            s["expiry"]
            for s in table.to_pylist()
            if s["underlying"] == underlying and s["option_type"] != "FUT"
        }
    if not listed:
        listed = set(pq.read_table(opt_path, columns=["expiry"]).column("expiry").to_pylist())
    upcoming = sorted(e for e in listed if e >= day)
    return upcoming[0] if upcoming else None


class ExpiryDayLoader:
    """`expiry_day`: per session, is it its own nearest weekly expiry (BL-165). Cached under
    TRADING_DATA_ROOT/ruletest/features/; a session without an option file reads False and is
    looked for again next run."""

    def __init__(self, root: Path, underlying: str, frame: E.Frame):
        self.root, self.underlying, self.frame = root, underlying, frame
        self._values: np.ndarray | None = None

    def __call__(self) -> np.ndarray:
        if self._values is not None:
            return self._values
        path = store.features_dir(self.root) / f"expiry_day_{self.underlying}.npz"
        known: dict[str, bool] = {}
        if path.exists():
            with np.load(path, allow_pickle=False) as z:
                known = dict(zip(z["days"].tolist(), z["data"].astype(bool).tolist(), strict=True))
        out = np.zeros(self.frame.n, dtype=bool)
        added = 0
        for i, d in enumerate(self.frame.days):
            if d not in known:
                day = date.fromisoformat(d)
                if day < OPTIONS_FROM:
                    known[d] = False
                else:
                    expiry = nearest_expiry(self.root, self.underlying, day)
                    if expiry is None:
                        continue  # no option file (yet): False this run, not saved
                    known[d] = expiry == day
                added += 1
            out[i] = known[d]
        if added:
            days = sorted(known)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp.npz")
            np.savez_compressed(tmp, days=np.array(days), data=np.array([known[d] for d in days]))
            tmp.replace(path)
        self._values = out
        return out


class StraddleLoader:
    """`{straddle: {at: "09:20"}}`: CE + PE close of the strike that was ATM at the spot close of
    the `at` bar, nearest expiry. NaN where option bars are missing. Cached under
    TRADING_DATA_ROOT/ruletest/features/, rebuilt only for sessions not yet in the file."""

    def __init__(self, root: Path, underlying: str, frame: E.Frame):
        self.root, self.underlying, self.frame = root, underlying, frame

    def __call__(self, at_stamp: int, progress: Callable[[str], None] | None = None) -> np.ndarray:
        from trading_data import lake

        path = store.features_dir(self.root) / f"straddle_{self.underlying}_{at_stamp}.npz"
        known: dict[str, np.ndarray] = {}
        legacy = False
        if path.exists():
            with np.load(path, allow_pickle=False) as z:
                known = dict(zip(z["days"].tolist(), z["data"], strict=True))
                legacy = "version" not in z.files
            if legacy:
                # Before version 2 a day with no option file, or a failed read, was saved as a
                # blank row for good; drop those so they are built once more.
                known = {
                    d: row
                    for d, row in known.items()
                    if date.fromisoformat(d) < OPTIONS_FROM or not np.isnan(row).all()
                }
        frame = self.frame
        added = 0
        out = np.full((frame.n, E.N_BARS), np.nan)
        for i, d in enumerate(frame.days):
            if d in known:
                out[i] = known[d]
                continue
            day = date.fromisoformat(d)
            row = np.full(E.N_BARS, np.nan)
            if day >= OPTIONS_FROM:
                if not lake.bars_1m_path(self.root, "option", self.underlying, day).exists():
                    continue  # not collected (yet): blank this run, looked for again next time
                try:
                    built = T.straddle_series(
                        self.root, self.underlying, day, float(frame.C[i, at_stamp])
                    )
                except Exception as error:  # noqa: BLE001 - one bad day never stops a test
                    # blank for this run only, never saved: a transient failure is retried
                    log.warning("straddle %s %s not built: %s", self.underlying, d, error)
                    if progress:
                        progress(f"straddle {self.underlying} {d}: not built ({error})")
                    continue
                if built is not None:
                    row = built[0]
            # saved: a built row, a session before options, or a file without the strike's bars
            known[d] = row
            out[i] = row
            added += 1
            if added % CHECKPOINT_DAYS == 0:
                self._save(path, known)
                if progress:
                    progress(f"straddle {self.underlying}: {added} days built, at {d}")
        if added or legacy:
            self._save(path, known)
        return out

    @staticmethod
    def _save(path: Path, known: dict[str, np.ndarray]) -> None:
        days = sorted(known)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp.npz")
        np.savez_compressed(
            tmp,
            days=np.array(days),
            data=np.array([known[d] for d in days]),
            version=np.array(FEATURE_VERSION),
        )
        tmp.replace(path)
