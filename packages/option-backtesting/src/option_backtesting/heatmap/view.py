"""The three AlgoTest heatmap views, read from the stored rows (store.py). Nothing here simulates.

    time_sl    rows entry times, columns stop losses; one day, or the sum over a date range
    date_time  rows days, columns entry times, at one stop loss
    date_sl    rows days, columns stop losses, at one entry time

A cell is the straddle's P&L (call + put). Unit: an index is rupees for one lot at the current lot
size (the legwise engine's `lot_sizing: current`); a stock is points per share, because the lake
has no lot size for most stock contracts. `metric="pct"` is P&L as a percentage of the premium
sold (both legs), comparable across underlyings. A range view sums the days' P&L (and for pct the
days' premium), so the TOTAL row is the sum of the rows above it.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from ..data.reference.loader import ReferenceData, default_reference_data
from . import grid, store

VIEWS = ("time_sl", "date_time", "date_sl")
METRICS = ("value", "pct")
MAX_DAYS = 400  # a date x X table this tall is unreadable and slow to send


class HeatmapError(ValueError):
    pass


def _multiplier(underlying: str, reference: ReferenceData) -> int:
    if not grid.is_index(underlying):
        return 1
    return reference.lot_size(underlying, date.today())


def unit(underlying: str) -> str:
    return "inr_per_lot" if grid.is_index(underlying) else "points_per_share"


def _acc() -> dict:
    return {"ce": 0.0, "pe": 0.0, "premium": 0.0, "n": 0}


def _cell(a: dict, mult: int, metric: str) -> dict | None:
    if a["n"] == 0:
        return None
    if metric == "pct":
        p = a["premium"]
        if p <= 0:
            return None
        ce, pe = a["ce"] / p * 100, a["pe"] / p * 100
    else:
        ce, pe = a["ce"] * mult, a["pe"] * mult
    return {"net": round(ce + pe, 2), "ce": round(ce, 2), "pe": round(pe, 2), "n": a["n"]}


def _add(a: dict, row: dict) -> None:
    a["ce"] += row["ce_pts"]
    a["pe"] += row["pe_pts"]
    a["premium"] += row["ce_entry"] + row["pe_entry"]
    a["n"] += 1


def build_view(
    underlying: str,
    view: str,
    *,
    root: Path | None = None,
    day: date | None = None,
    start: date | None = None,
    end: date | None = None,
    sl: int | None = None,
    time: str | None = None,
    exit_time: str = grid.EXIT_TIME,
    weeks: set[int] | None = None,
    metric: str = "value",
    reference: ReferenceData | None = None,
) -> dict:
    if view not in VIEWS:
        raise HeatmapError(f"view must be one of {VIEWS}")
    if metric not in METRICS:
        raise HeatmapError(f"metric must be one of {METRICS}")
    table = store.read(underlying, root)
    if table is None:
        raise HeatmapError(f"no heatmap for {underlying}; run `obt heatmap build`")
    reference = reference or default_reference_data()
    mult = _multiplier(underlying, reference)
    if view == "time_sl" and day is not None:
        start = end = day
    if view in ("date_time", "date_sl") and start is None and end is None:
        raise HeatmapError("a date range is needed (from, to)")
    if exit_time not in grid.EXIT_TIMES:
        raise HeatmapError(f"exit must be one of {list(grid.EXIT_TIMES)}")
    if view == "date_time" and sl not in grid.STOP_LOSSES:
        raise HeatmapError(f"sl must be one of {list(grid.STOP_LOSSES)}")
    if view == "date_sl" and time not in grid.ENTRY_TIMES:
        raise HeatmapError(f"time must be one of {list(grid.ENTRY_TIMES)}")

    cols = table.to_pydict()
    n = table.num_rows
    sel: list[dict] = []
    for i in range(n):
        d = cols["day"][i]
        if (start and d < start) or (end and d > end):
            continue
        if cols["exit"][i] != exit_time:
            continue
        if weeks is not None and (cols["dte"][i] // 7) not in weeks:
            continue
        if view == "date_time" and cols["sl"][i] != sl:
            continue
        if view == "date_sl" and cols["time"][i] != time:
            continue
        sel.append({k: cols[k][i] for k in cols})
    days = sorted({r["day"] for r in sel})
    if view != "time_sl" and len(days) > MAX_DAYS:
        raise HeatmapError(f"{len(days)} days is more than {MAX_DAYS}; narrow the range")

    if view == "time_sl":
        row_keys, col_keys = list(grid.ENTRY_TIMES), list(grid.STOP_LOSSES)
        rk = lambda r: r["time"]  # noqa: E731
        ck = lambda r: r["sl"]  # noqa: E731
    elif view == "date_time":
        row_keys, col_keys = [d.isoformat() for d in days], list(grid.ENTRY_TIMES)
        rk = lambda r: r["day"].isoformat()  # noqa: E731
        ck = lambda r: r["time"]  # noqa: E731
    else:
        row_keys, col_keys = [d.isoformat() for d in days], list(grid.STOP_LOSSES)
        rk = lambda r: r["day"].isoformat()  # noqa: E731
        ck = lambda r: r["sl"]  # noqa: E731

    cells = {(r, c): _acc() for r in row_keys for c in col_keys}
    rows_tot = {r: _acc() for r in row_keys}
    cols_tot = {c: _acc() for c in col_keys}
    grand = _acc()
    for r in sel:
        key = (rk(r), ck(r))
        if key not in cells:
            continue
        _add(cells[key], r)
        _add(rows_tot[key[0]], r)
        _add(cols_tot[key[1]], r)
        _add(grand, r)

    matrix = [[_cell(cells[(r, c)], mult, metric) for c in col_keys] for r in row_keys]
    return {
        "underlying": underlying,
        "kind": "index" if grid.is_index(underlying) else "stock",
        "expiry": grid.expiry_kind(underlying),
        "view": view,
        "metric": metric,
        "unit": "pct_of_premium" if metric == "pct" else unit(underlying),
        "lot": mult if grid.is_index(underlying) else None,
        "exit_time": exit_time,
        "exit_times": list(grid.EXIT_TIMES),
        "rows": row_keys,
        "columns": col_keys,
        "cells": matrix,
        "row_totals": [_cell(rows_tot[r], mult, metric) for r in row_keys],
        "column_totals": [_cell(cols_tot[c], mult, metric) for c in col_keys],
        "total": _cell(grand, mult, metric),
        "days": [d.isoformat() for d in days],
        "filters": {
            "from": start.isoformat() if start else None,
            "to": end.isoformat() if end else None,
            "sl": sl,
            "time": time,
            "weeks_to_expiry": sorted(weeks) if weeks is not None else None,
        },
    }
