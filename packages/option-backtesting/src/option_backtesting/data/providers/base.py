"""
Provider layer — canonical bar/contract types and the provider Protocol,
ported near-verbatim from the design handoff's `providers.py`. The engine
never imports a provider; providers exist only to fill the Parquet cache
(see `data/ingest.py`). No adapter implements the Protocol today: AlgoTest
bars arrive through the MCP flow in `algotest.py`.

Strike-relative rules (ATM, OTM1, ...) are resolved by our own resolver
(`data/resolver.py`) before reaching a provider — see DECISIONS.md for why
this matters (the 3 Sep AlgoTest identical-series collision).
"""

from __future__ import annotations

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
