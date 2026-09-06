"""
Ingest-time quality gates.

"No headline number from a dataset with unreviewed flags" (design handoff
§3.5). Every gate here returns a list of `QualityFlag` — empty means clean.
`ingest.py` attaches these to the Parquet metadata for a session; the
Streamlit^H^H^H React dashboard (M-4) surfaces the flag count next to every
headline metric.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from .providers.base import Bar, SessionFlag


@dataclass(frozen=True)
class QualityFlag:
    gate: str
    message: str
    severity: str = "warning"  # "warning" | "error"


def identical_series(
    label_a: str,
    bars_a: list[Bar],
    label_b: str,
    bars_b: list[Bar],
    *,
    field: str = "close",
) -> list[QualityFlag]:
    """The 2026-09-03 collision detector: two distinct strike rules/legs must
    never resolve to byte-identical series. If they do, it means the vendor
    (or our own ingest) resolved them to the same underlying contract —
    exactly what happened between ATM PE and OTM1 PE on that date."""
    ta = {b.ts: getattr(b, field) for b in bars_a if b.session is SessionFlag.REGULAR}
    tb = {b.ts: getattr(b, field) for b in bars_b if b.session is SessionFlag.REGULAR}
    shared = sorted(set(ta) & set(tb))
    if not shared:
        return []
    if all(ta[t] == tb[t] for t in shared):
        return [
            QualityFlag(
                gate="identical_series",
                message=(
                    f"{label_a} and {label_b} are byte-identical across all "
                    f"{len(shared)} shared timestamps — resolver collision suspected."
                ),
                severity="error",
            )
        ]
    return []


def bar_gaps(bars: list[Bar], expected_interval: timedelta) -> list[QualityFlag]:
    """Flags any REGULAR-session gap larger than expected_interval — a missed
    candle, not a session boundary. Compares consecutive bars only within
    the same calendar date: the overnight gap between one day's 15:15 close
    and the next day's 09:30 open is not a data gap, and comparing across
    days would flag every single trading day as gapped."""
    regular = sorted((b for b in bars if b.session is SessionFlag.REGULAR), key=lambda b: b.ts)
    flags: list[QualityFlag] = []
    for prev, curr in zip(regular, regular[1:], strict=False):
        if prev.ts.date() != curr.ts.date():
            continue
        gap = curr.ts - prev.ts
        if gap > expected_interval:
            flags.append(
                QualityFlag(
                    gate="bar_gaps",
                    message=(
                        f"Gap of {gap} between {prev.ts} and {curr.ts} "
                        f"(expected {expected_interval})."
                    ),
                )
            )
    return flags


def negative_or_over_underlying(
    bars: list[Bar],
    underlying_at: dict, # Mapping[datetime, float] — index/futures price at each bar's ts
) -> list[QualityFlag]:
    """An option premium must never be negative, and (barring a data error)
    must never exceed the underlying's price at the same instant."""
    flags: list[QualityFlag] = []
    for b in bars:
        if b.close < 0 or b.low < 0:
            flags.append(
                QualityFlag(
                    gate="negative_premium",
                    message=f"Negative premium at {b.ts}: close={b.close}, low={b.low}.",
                    severity="error",
                )
            )
        spot = underlying_at.get(b.ts)
        if spot is not None and b.close > spot:
            flags.append(
                QualityFlag(
                    gate="premium_over_underlying",
                    message=f"Premium {b.close} at {b.ts} exceeds underlying {spot}.",
                    severity="error",
                )
            )
    return flags


def expiry_day_convergence(
    *,
    is_expiry_day: bool,
    straddle_close: float,
    spot_close: float,
    strike: float,
    tolerance: float,
) -> list[QualityFlag]:
    """On expiry day, an ATM straddle must converge to |spot - strike|, not
    to zero. A provider that gets this wrong silently corrupts every
    0-DTE result (see the design handoff's known-facts list)."""
    if not is_expiry_day:
        return []
    expected = abs(spot_close - strike)
    if abs(straddle_close - expected) > tolerance:
        return [
            QualityFlag(
                gate="expiry_day_convergence",
                message=(
                    f"Expiry-day straddle close {straddle_close} does not converge to "
                    f"|spot - strike| = {expected} (tolerance {tolerance})."
                ),
                severity="error",
            )
        ]
    return []


def zero_volume_regular_bars(bars: list[Bar]) -> list[QualityFlag]:
    """A REGULAR-session bar with zero volume is a liquidity/data warning,
    not necessarily an error (deep OTM/ITM contracts can legitimately trade
    zero volume in a 5m/15m window) — kept at warning severity."""
    zeros = [b for b in bars if b.session is SessionFlag.REGULAR and (b.volume or 0) == 0]
    if not zeros:
        return []
    return [
        QualityFlag(
            gate="zero_volume_regular",
            message=f"{len(zeros)} REGULAR-session bar(s) with zero volume.",
        )
    ]


@dataclass(frozen=True)
class QualityReport:
    flags: list[QualityFlag]

    @property
    def has_errors(self) -> bool:
        return any(f.severity == "error" for f in self.flags)

    @property
    def count(self) -> int:
        return len(self.flags)
