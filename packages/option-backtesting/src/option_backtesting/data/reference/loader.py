"""
Effective-dated reference data loader.

Every table here (lot sizes, strike step, expiry calendar, holidays, margin)
is effective-dated, never a hard-coded constant — the handoff's non-negotiable
("Reference data ... is effective-dated, never constant") exists because
NIFTY's lot size and expiry weekday have both changed within a single year
in the real market, and a backtest spanning such a change must use the size/
weekday that was actually in force on each session's date, not today's.

Cross-check target: `apps/server/src/ingestion/brokers/instrument-registry.ts`
pins the CURRENT rule as a hard-coded constant (no effective-dating) — this
loader's "current" row must agree with it (see tests/unit/test_reference.py).
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path

REFERENCE_DIR = Path(__file__).parent


def _parse_date(s: str) -> date:
    return date.fromisoformat(s)


@dataclass(frozen=True)
class LotSizeRow:
    underlying: str
    lot_size: int
    effective_date: date


@dataclass(frozen=True)
class StrikeStepRow:
    underlying: str
    step: float
    effective_date: date


@dataclass(frozen=True)
class ExpiryCalendarRow:
    underlying: str
    cadence: str  # "WEEKLY" | "MONTHLY_LAST"
    weekday: int  # 0=Monday .. 6=Sunday (date.weekday() convention)
    effective_date: date


@dataclass(frozen=True)
class MarginRow:
    underlying: str
    strategy_type: str
    # First day of the effective month — margin.csv's "month" column is
    # YYYY-MM (coarser than the day-level effective_date used elsewhere),
    # since exchange margin requirements don't change intra-month in practice.
    month: date
    margin_inr: float


def _most_recent_as_of(rows: list, as_of: date, *, label: str, underlying: str):
    """Return the row with the latest effective_date <= as_of, for the given
    underlying. Raises rather than silently falling back to a wrong-era row —
    a missing reference row for a date we're backtesting is a data gap to
    fix, not something to guess through."""
    candidates = [r for r in rows if r.underlying == underlying and r.effective_date <= as_of]
    if not candidates:
        raise ValueError(
            f"No {label} row for {underlying} effective on or before {as_of}. "
            f"Add one to data/reference/ rather than guessing."
        )
    return max(candidates, key=lambda r: r.effective_date)


def _month_start(d: date) -> date:
    return date(d.year, d.month, 1)


class ReferenceData:
    """Loads all reference CSVs once and serves effective-dated lookups.
    Cheap to construct — a fresh instance per test/run is fine."""

    def __init__(self, reference_dir: Path | None = None) -> None:
        self._dir = reference_dir or REFERENCE_DIR
        self._lot_sizes = self._load_lot_sizes()
        self._strike_steps = self._load_strike_steps()
        self._expiry_calendar = self._load_expiry_calendar()
        self._holidays = self._load_holidays()
        self._margins = self._load_margins()

    # -- loading --------------------------------------------------------

    def _load_lot_sizes(self) -> list[LotSizeRow]:
        with open(self._dir / "lot_sizes.csv", newline="") as f:
            return [
                LotSizeRow(
                    row["underlying"], int(row["lot_size"]), _parse_date(row["effective_date"])
                )
                for row in csv.DictReader(f)
            ]

    def _load_strike_steps(self) -> list[StrikeStepRow]:
        with open(self._dir / "strike_step.csv", newline="") as f:
            return [
                StrikeStepRow(
                    row["underlying"], float(row["step"]), _parse_date(row["effective_date"])
                )
                for row in csv.DictReader(f)
            ]

    def _load_expiry_calendar(self) -> list[ExpiryCalendarRow]:
        with open(self._dir / "expiry_calendar.csv", newline="") as f:
            return [
                ExpiryCalendarRow(
                    row["underlying"],
                    row["cadence"],
                    int(row["weekday"]),
                    _parse_date(row["effective_date"]),
                )
                for row in csv.DictReader(f)
            ]

    def _load_holidays(self) -> frozenset[date]:
        with open(self._dir / "holidays.csv", newline="") as f:
            return frozenset(_parse_date(row["date"]) for row in csv.DictReader(f))

    def _load_margins(self) -> list[MarginRow]:
        with open(self._dir / "margin.csv", newline="") as f:
            return [
                MarginRow(
                    row["underlying"],
                    row["strategy_type"],
                    _month_start(date.fromisoformat(row["month"] + "-01")),
                    float(row["margin_inr"]),
                )
                for row in csv.DictReader(f)
            ]

    # -- lookups ----------------------------------------------------------

    def lot_size(self, underlying: str, as_of: date) -> int:
        return _most_recent_as_of(
            self._lot_sizes, as_of, label="lot_sizes", underlying=underlying
        ).lot_size

    def strike_step(self, underlying: str, as_of: date) -> float:
        return _most_recent_as_of(
            self._strike_steps, as_of, label="strike_step", underlying=underlying
        ).step

    def expiry_cadence(self, underlying: str, as_of: date) -> ExpiryCalendarRow:
        return _most_recent_as_of(
            self._expiry_calendar, as_of, label="expiry_calendar", underlying=underlying
        )

    def margin_per_lot(self, underlying: str, strategy_type: str, as_of: date) -> float:
        """Flat per-lot margin requirement effective on `as_of`'s month.
        Raises rather than guessing if no (underlying, strategy_type) row
        applies — same "never silently guess" convention as every other
        reference lookup in this class."""
        as_of_month = _month_start(as_of)
        candidates = [
            r
            for r in self._margins
            if r.underlying == underlying
            and r.strategy_type == strategy_type
            and r.month <= as_of_month
        ]
        if not candidates:
            raise ValueError(
                f"No margin row for {underlying}/{strategy_type} effective on or before "
                f"{as_of_month.isoformat()[:7]}. Add one to data/reference/margin.csv "
                f"rather than guessing."
            )
        return max(candidates, key=lambda r: r.month).margin_inr

    def is_holiday(self, d: date) -> bool:
        return d in self._holidays

    def holidays(self) -> frozenset[date]:
        return self._holidays

    def is_trading_day(self, d: date) -> bool:
        return d.weekday() < 5 and not self.is_holiday(d)

    def current_expiry(self, underlying: str, as_of: date) -> date:
        """Nearest expiry date on or after `as_of`, per the effective cadence.
        Date-only — does not model the intraday 15:30 IST post-expiry rollover
        that `instrument-registry.ts`'s live-trading getCurrentExpiry() does;
        for backtesting we resolve DTE from calendar dates, not wall-clock time.
        """
        row = self.expiry_cadence(underlying, as_of)
        if row.cadence == "WEEKLY":
            return _nearest_weekday_on_or_after(as_of, row.weekday)
        if row.cadence == "MONTHLY_LAST":
            candidate = _last_weekday_of_month(as_of.year, as_of.month, row.weekday)
            if candidate < as_of:
                year, month = (
                    (as_of.year, as_of.month + 1)
                    if as_of.month < 12
                    else (as_of.year + 1, 1)
                )
                candidate = _last_weekday_of_month(year, month, row.weekday)
            return candidate
        raise ValueError(f"Unknown expiry cadence {row.cadence!r} for {underlying}")


def _nearest_weekday_on_or_after(d: date, target_weekday: int) -> date:
    delta = (target_weekday - d.weekday()) % 7
    return date.fromordinal(d.toordinal() + delta)


def _last_weekday_of_month(year: int, month: int, target_weekday: int) -> date:
    first_of_next = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    last_day = date.fromordinal(first_of_next.toordinal() - 1)
    delta = (last_day.weekday() - target_weekday) % 7
    return date.fromordinal(last_day.toordinal() - delta)


@lru_cache(maxsize=1)
def default_reference_data() -> ReferenceData:
    """Process-wide singleton over the checked-in reference/ CSVs. Tests that
    need a different reference_dir should construct ReferenceData directly."""
    return ReferenceData()
