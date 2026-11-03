"""The evening message's paper figures after slippage (owner, 2026-10-30): every entry and exit of
the day's picks filled `SLIPPAGE_PCT` % against the trade (a sell lower, a buy back higher), nearer
what live fills get than paper's exact prices.

The figures are the stored results' slippage copy (`slip_store`, the same one the dashboard's
Rotation pages read with their Slippage switch on): `rotation update` writes it for the day, and
a pick it lacks is copied here first. The ranking, the picks and `live-compare` (which measures
live slippage against the unslipped paper) never read it.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import slip_store, store
from .result import REPORT_LOTS, DailyResult

SLIPPAGE_PCT = slip_store.SLIP_PCT


class SlippageUnavailable(RuntimeError):
    """A pick's day could not be simulated again (its bars are gone, its file changed)."""


def _nets(names: list[str], day: date, root: Path, pct: float) -> dict[str, float]:
    with store.slipped(pct):
        return {n: v for n in names if (v := store.read_net(n, root).get(day)) is not None}


def apply(result: DailyResult, root: Path | None = None, pct: float | None = None) -> DailyResult:
    """`result` with every pick's figure (and so each list's total) after `pct` % slippage on
    every fill (default `SLIPPAGE_PCT`); 0, or a result that already carries `pct`, returns it as
    it is. Raises SlippageUnavailable when a pick cannot be copied: the caller sends the unslipped
    figures instead."""
    pct = SLIPPAGE_PCT if pct is None else pct
    if not pct or result.slippage_pct == pct:
        return result
    if result.slippage_pct:
        raise ValueError(f"{result.day}: already carries {result.slippage_pct}% slippage")
    root = root or data_dir()
    names = sorted({n for rows in result.strategies.values() for n, _ in rows})
    values = _nets(names, result.day, root, pct)
    missing = [n for n in names if n not in values]
    if missing:
        filled = slip_store.fill(root, days=[result.day], names=missing, log=lambda m: None)
        values = _nets(names, result.day, root, pct)
        missing = [n for n in names if n not in values]
        if missing:
            why = "; ".join(filled["skipped"][:2]) or "not copied"
            raise SlippageUnavailable(f"{result.day}: {', '.join(missing)}: {why}")
    strategies = {
        key: [(name, REPORT_LOTS * values[name]) for name, _ in rows]
        for key, rows in result.strategies.items()
    }
    gains = {key: sum(v for _, v in rows) for key, rows in strategies.items()}
    return replace(result, gains=gains, strategies=strategies, slippage_pct=pct)
