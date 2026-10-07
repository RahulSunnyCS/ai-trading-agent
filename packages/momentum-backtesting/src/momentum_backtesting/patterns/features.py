"""Run every detector over many symbols, and turn detections into a week x symbol score table.

`detect` is the one entry point the CLI, the gallery and the tests use. The detections table has
one row per (symbol, week, pattern) that is forming, near its pivot or just broke out
(`common.states`); `geometry` is a JSON string so the table can be written to Parquet.
"""

from __future__ import annotations

import json
import os
from concurrent.futures import ProcessPoolExecutor

import pandas as pd

from . import cup_handle, flag, tight_range
from .bars import SymbolBars, split_symbols
from .common import states

SCANNERS = {
    "tight_range": tight_range.scan,
    "flag": flag.scan,
    "high_tight_flag": flag.scan_high_tight,
    "cup_handle": cup_handle.scan,
}
COLUMNS = (
    "symbol", "week", "pattern", "state", "score", "pivot", "close", "pivot_vs_close",
    "base_start", "base_end", "breakout_date", "geometry",
)  # fmt: skip


def detect_symbol(bars: SymbolBars, patterns: tuple[str, ...] = tuple(SCANNERS)) -> list[dict]:
    rows: list[dict] = []
    for pattern in patterns:
        rows.extend(states(bars, SCANNERS[pattern](bars), pattern))
    return rows


def _detect_chunk(args: tuple[list[SymbolBars], tuple[str, ...]]) -> list[dict]:
    chunk, patterns = args
    rows: list[dict] = []
    for bars in chunk:
        rows.extend(detect_symbol(bars, patterns))
    return rows


def detect(
    daily: pd.DataFrame,
    patterns: tuple[str, ...] = tuple(SCANNERS),
    *,
    since: str | pd.Timestamp | None = None,
    workers: int | None = None,
) -> pd.DataFrame:
    """Detections for every symbol in `daily` (bars.adjust output). Weeks before `since` are
    dropped from the output (they still serve as history)."""
    symbols = list(split_symbols(daily).values())
    workers = workers if workers is not None else min(8, os.cpu_count() or 1)
    if workers <= 1 or len(symbols) < 20:
        rows = _detect_chunk((symbols, patterns))
    else:
        chunks = [symbols[i :: workers * 4] for i in range(workers * 4)]
        with ProcessPoolExecutor(workers) as pool:
            rows = [
                r for part in pool.map(_detect_chunk, [(c, patterns) for c in chunks]) for r in part
            ]
    frame = pd.DataFrame(rows, columns=list(COLUMNS))
    frame["geometry"] = frame["geometry"].map(lambda g: json.dumps(g, sort_keys=True))
    for column in ("symbol", "pattern", "state", "geometry"):
        frame[column] = frame[column].astype(object)
    for column in ("week", "base_start", "base_end", "breakout_date"):
        frame[column] = pd.to_datetime(frame[column]).astype("datetime64[ns]")
    for column in ("score", "pivot", "close", "pivot_vs_close"):
        frame[column] = frame[column].astype(float)
    if since is not None:
        frame = frame[frame["week"] >= pd.Timestamp(since)]
    return frame.sort_values(["pattern", "week", "symbol"]).reset_index(drop=True)


def score_table(
    detections: pd.DataFrame, pattern: str, weeks: pd.DatetimeIndex, symbols: list[str]
) -> pd.DataFrame:
    """week x symbol pattern score in [0, 1] for one pattern; 0 where nothing was detected."""
    rows = detections[detections["pattern"] == pattern]
    table = rows.pivot_table(index="week", columns="symbol", values="score", aggfunc="max")
    return table.reindex(index=weeks, columns=symbols).fillna(0.0)
