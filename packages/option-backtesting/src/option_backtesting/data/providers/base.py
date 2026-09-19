"""
Provider layer + parity harness — ported near-verbatim from the design handoff's
`providers.py`. The engine never imports a provider; providers exist only to
fill the Parquet cache (see `data/ingest.py`).

Strike-relative rules (ATM, OTM1, ...) are resolved by our own resolver
(`data/resolver.py`) before reaching a provider — see DECISIONS.md for why
this matters (the 3 Sep AlgoTest identical-series collision).
"""

from __future__ import annotations

import statistics
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Protocol

# ---------------------------------------------------------------------------
# Canonical types
# ---------------------------------------------------------------------------


class Kind(StrEnum):
    OPT = "OPT"
    FUT = "FUT"
    CASH = "CASH"


class Right(StrEnum):
    CE = "CE"
    PE = "PE"


class SessionFlag(StrEnum):
    PRE = "PRE"
    REGULAR = "REGULAR"
    POST = "POST"


@dataclass(frozen=True)
class InstrumentKey:
    """A concrete contract. Strike-type abstractions (ATM, OTM1, delta) are
    resolved by the feature layer BEFORE reaching a provider."""

    underlying: str
    kind: Kind
    expiry: date | None = None
    strike: float | None = None
    right: Right | None = None


@dataclass(frozen=True)
class Bar:
    ts: datetime  # tz-aware, exchange-local
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None
    oi: float | None = None
    iv: float | None = None
    spot: float | None = None
    session: SessionFlag = SessionFlag.REGULAR


@dataclass(frozen=True)
class ProviderCaps:
    name: str
    max_lookback_days: int
    timeframes: frozenset[str]
    has_greeks: bool
    has_expired_options: bool
    has_oi: bool
    max_days_per_call: int


class MarketDataProvider(Protocol):
    def caps(self) -> ProviderCaps: ...

    def fetch_bars(
        self,
        instrument: InstrumentKey,
        start: date,
        end: date,
        timeframe: str,
    ) -> list[Bar]: ...

    def resolve_strike(
        self,
        underlying: str,
        expiry: date,
        rule: str,  # "ATM" | "OTM1" | "ITM2" | "DELTA:0.30" | "EXACT:24000"
        at: datetime,
    ) -> InstrumentKey:
        """Optional. If a provider offers this, we use it ONLY to cross-check our
        own resolver — never as the source of truth. AlgoTest returned identical
        ATM and OTM1 series on 2026-09-03; that class of bug must be ours to catch."""
        ...


# ---------------------------------------------------------------------------
# Parity harness — this is what decides the Dhan question (M-6)
# ---------------------------------------------------------------------------


@dataclass
class ParityResult:
    label: str
    n_bars_a: int
    n_bars_b: int
    matched_ts: int
    median_abs_diff: float
    p95_abs_diff: float
    max_abs_diff: float
    median_rel_diff_pct: float
    missing_in_b: int
    missing_in_a: int
    identical_series_flag: bool


def compare(
    label: str,
    a: list[Bar],
    b: list[Bar],
    field: str = "close",
) -> ParityResult:
    ma = {x.ts: getattr(x, field) for x in a if x.session is SessionFlag.REGULAR}
    mb = {x.ts: getattr(x, field) for x in b if x.session is SessionFlag.REGULAR}
    shared = sorted(set(ma) & set(mb))

    diffs = [abs(ma[t] - mb[t]) for t in shared]
    rels = [abs(ma[t] - mb[t]) / ma[t] * 100 for t in shared if ma[t] not in (0, None)]
    ordered = sorted(diffs)

    def pct(xs: list[float], q: float) -> float:
        return ordered[int(q * (len(ordered) - 1))] if xs else float("nan")

    return ParityResult(
        label=label,
        n_bars_a=len(ma),
        n_bars_b=len(mb),
        matched_ts=len(shared),
        median_abs_diff=statistics.median(diffs) if diffs else float("nan"),
        p95_abs_diff=pct(diffs, 0.95),
        max_abs_diff=max(diffs) if diffs else float("nan"),
        median_rel_diff_pct=statistics.median(rels) if rels else float("nan"),
        missing_in_b=len(set(ma) - set(mb)),
        missing_in_a=len(set(mb) - set(ma)),
        identical_series_flag=bool(diffs) and max(diffs) == 0.0,
    )


# --- Gates -----------------------------------------------------------------
# Deliberately strict. A provider that fails any RED gate is not a drop-in
# replacement; it is a second opinion at best.

GATES = {
    # RED — must pass to migrate
    "coverage": ("missing_in_b / n_bars_a", 0.01),  # <1% bars missing
    "median_rel_diff": ("median_rel_diff_pct", 0.50),  # <0.5% median gap
    "p95_abs_points": ("p95_abs_diff", 2.00),  # <2 premium points
    # AMBER — investigate, don't necessarily block
    "max_abs_points": ("max_abs_diff", 15.00),
}


def run_parity_suite(
    algotest: MarketDataProvider,
    dhan: MarketDataProvider,
    resolved: Iterable[tuple[str, InstrumentKey]],
    start: date,
    end: date,
    timeframe: str = "15m",
) -> list[ParityResult]:
    """
    `resolved` must come from OUR strike resolver, so both providers are asked
    for the same concrete contract. Comparing "each provider's idea of ATM"
    tests two things at once and tells you nothing when it fails.

    Suggested coverage: 20 sessions spanning >=4 expiry cycles, including at
    least 3 expiry days and 3 gap-open days. Include one deep-OTM strike —
    illiquid contracts are where vendor data diverges most.
    """
    out = []
    for label, key in resolved:
        a = algotest.fetch_bars(key, start, end, timeframe)
        b = dhan.fetch_bars(key, start, end, timeframe)
        out.append(compare(label, a, b))
    return out


def verdict(results: list[ParityResult]) -> str:
    red = []
    for r in results:
        if r.n_bars_a and r.missing_in_b / r.n_bars_a > GATES["coverage"][1]:
            red.append(f"{r.label}: coverage {r.missing_in_b}/{r.n_bars_a}")
        if r.median_rel_diff_pct > GATES["median_rel_diff"][1]:
            red.append(f"{r.label}: median rel diff {r.median_rel_diff_pct:.2f}%")
        if r.p95_abs_diff > GATES["p95_abs_points"][1]:
            red.append(f"{r.label}: p95 {r.p95_abs_diff:.2f} pts")
        if r.identical_series_flag:
            red.append(f"{r.label}: series identical — check resolver collision")
    return "MIGRATE" if not red else "HOLD:\n  " + "\n  ".join(red)


# ---------------------------------------------------------------------------
# Decision rule (documented, not code — see run_parity_suite/verdict above)
# ---------------------------------------------------------------------------
#
# Migrate the CACHE to Dhan only if: depth check passes for >=3 years AND
# parity verdict is MIGRATE AND backfill completes in a working day.
# Otherwise keep AlgoTest primary and register Dhan as a secondary source.
# Either way, keep BOTH adapters permanently — cross-provider disagreement is
# the cheapest data-quality signal you will ever have.
