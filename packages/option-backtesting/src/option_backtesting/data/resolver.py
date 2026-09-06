"""
Strike resolver — OURS, never a provider's. Providers return concrete
contracts only; strike-relative rules (ATM, OTM1, ITM2, ...) are resolved
here, independently of whatever a vendor's own resolver did.

Why this module exists: on 2026-09-03, AlgoTest returned an identical series
for ATM PE and OTM1 PE (a fix_time mismatch collided two distinct strike
rules onto the same contract). `quality.identical_series` (see quality.py)
is the ingest-time detector for that failure mode; this module is the
structural reason it can't happen on OUR side — `resolve_strike` computes
every strike rule from the reference strike step by a fixed integer offset
from ATM, so two distinct rules can only produce the same number if the
caller passes n=0 for both, never as an accident of vendor internals.

Rounding matches `getAtmStrike()` in
`apps/server/src/ingestion/brokers/instrument-registry.ts`: round-half-up to
the nearest strike step (Python's round() is banker's-rounding / round-half-
to-even, which disagrees with JS's Math.round() on exact .5 boundaries — see
`_round_half_up` below).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime

from .providers.base import InstrumentKey, Kind, Right
from .reference.loader import ReferenceData, default_reference_data

_OTM_ITM_RE = re.compile(r"^(OTM|ITM)(\d+)$")
_EXACT_RE = re.compile(r"^EXACT:(-?\d+(?:\.\d+)?)$")
_DELTA_RE = re.compile(r"^DELTA:(-?\d+(?:\.\d+)?)$")


def _round_half_up(value: float, step: float) -> float:
    """Round `value` to the nearest multiple of `step`, ties rounding up —
    matches JavaScript's Math.round(value / step) * step, which TypeScript's
    getAtmStrike() uses. Python's built-in round() rounds .5 to even, which
    would silently disagree with the TS registry on exact half-step spots."""
    return math.floor(value / step + 0.5) * step


@dataclass(frozen=True)
class ResolvedStrike:
    """The result of resolving one strike rule for one leg. `strike_resolved`
    is the audit trail written to Parquet alongside every OPT bar — see
    DECISIONS.md's Phase-1 deviation."""

    underlying: str
    rule: str
    right: Right
    spot: float
    strike: float


def resolve_strike(
    underlying: str,
    rule: str,
    right: Right,
    spot: float,
    *,
    as_of: date,
    reference: ReferenceData | None = None,
) -> ResolvedStrike:
    """Resolve a strike-relative rule (ATM / OTMn / ITMn / EXACT:n / DELTA:x)
    to a concrete strike, independent of any vendor's own resolution.

    Moneyness direction depends on the option right: for a CALL, OTM means
    strike > spot; for a PUT, OTM means strike < spot (and ITM is the
    reverse for both) — standard options convention, matching AlgoTest's own
    StrikeType semantics.
    """
    reference = reference or default_reference_data()
    step = reference.strike_step(underlying, as_of)
    atm = _round_half_up(spot, step)

    if rule == "ATM":
        strike = atm
    elif (m := _OTM_ITM_RE.match(rule)) is not None:
        kind, n_str = m.group(1), m.group(2)
        n = int(n_str)
        # CE: OTM is above spot (+), ITM is below (-). PE: the mirror image.
        sign = 1 if kind == "OTM" else -1
        if right is Right.PE:
            sign = -sign
        strike = atm + sign * n * step
    elif (m := _EXACT_RE.match(rule)) is not None:
        strike = float(m.group(1))
    elif _DELTA_RE.match(rule) is not None:
        raise NotImplementedError(
            "DELTA:<x> strike resolution requires an IV surface/pricing model "
            "we don't have yet — tracked as a follow-up, not implemented in M-1."
        )
    else:
        raise ValueError(f"Unrecognised strike rule: {rule!r}")

    return ResolvedStrike(underlying=underlying, rule=rule, right=right, spot=spot, strike=strike)


def resolve(
    underlying: str,
    expiry: date,
    rule: str,
    right: Right,
    spot: float,
    *,
    at: datetime,
    reference: ReferenceData | None = None,
) -> InstrumentKey:
    """Resolve a strike-relative rule straight to a concrete InstrumentKey."""
    resolved = resolve_strike(underlying, rule, right, spot, as_of=at.date(), reference=reference)
    return InstrumentKey(
        underlying=underlying,
        kind=Kind.OPT,
        expiry=expiry,
        strike=resolved.strike,
        right=right,
    )
