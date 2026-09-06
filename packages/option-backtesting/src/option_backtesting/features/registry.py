"""
Feature registry — named, cached, point-in-time series (design handoff §4).

Non-negotiable: "Point-in-time — any cross-day feature without an explicit
`lag` fails validation." The three rolling/cross-day aggregation types
(`rolling_mean`, `ewma`, `rolling_pctile`) declare `lag` with NO default, so
pydantic rejects a spec missing it outright — a lagless 5-day rolling mean
would otherwise include *today's own, not-yet-complete* value in a threshold
used for decisions made earlier that same day, the textbook look-ahead bug.

Same-day features (`leg_sum`, `max_runup`, `session_high`/`session_low`) and
`gap` (which compares against `prev_close` — by definition the fully-settled
prior day, never today) don't need this: their own type already encodes a
point-in-time-safe reference.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

# ---------------------------------------------------------------------------
# Leg references: "ATM.CE", "OTM1.PE", etc.
# ---------------------------------------------------------------------------

STRIKE_RULES = ("ITM2", "ITM1", "ATM", "OTM1", "OTM2")
_LEG_REF_RE = re.compile(r"^(ITM2|ITM1|ATM|OTM1|OTM2)\.(CE|PE)$")


def parse_leg_ref(ref: str) -> tuple[str, str]:
    """'ATM.CE' -> ('ATM', 'CE'). Raises ValueError with the bad value on a
    malformed reference, so pydantic surfaces it as a normal field error."""
    m = _LEG_REF_RE.match(ref)
    if not m:
        raise ValueError(
            f"Invalid leg reference {ref!r} — expected STRIKE_RULE.LEG, "
            f"e.g. 'ATM.CE' (rules: {', '.join(STRIKE_RULES)}; legs: CE, PE)"
        )
    return m.group(1), m.group(2)


# ---------------------------------------------------------------------------
# Feature types
# ---------------------------------------------------------------------------


class FeatureBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LegSumFeature(FeatureBase):
    """Sum of one or more option legs at a fixed strike, e.g. an ATM straddle
    = ATM.CE + ATM.PE, priced FIXED at fix_time (never ROLLING — a
    strategy's trigger series must not silently re-resolve its strike
    mid-session)."""

    type: Literal["leg_sum"]
    legs: list[str] = Field(min_length=1)
    fix_time: str = "09:17"

    @field_validator("legs")
    @classmethod
    def _validate_legs(cls, v: list[str]) -> list[str]:
        for leg in v:
            parse_leg_ref(leg)
        return v


class MaxRunupFeature(FeatureBase):
    """Running max(source[t] - min(source[0..t])) within the session — the
    path-dependent "how far did it run up from its own low" statistic used
    by the adaptive-trailing archetype (variant D)."""

    type: Literal["max_runup"]
    source: str


class SessionHighFeature(FeatureBase):
    type: Literal["session_high"]
    source: str
    until: str


class SessionLowFeature(FeatureBase):
    type: Literal["session_low"]
    source: str
    until: str


class DaysToExpiryFeature(FeatureBase):
    type: Literal["days_to_expiry"]
    expiry: Literal["weekly", "monthly"] = "weekly"


class GreekFeature(FeatureBase):
    type: Literal["greek"]
    field: Literal["iv", "delta", "theta", "gamma", "vega", "rho"]
    at: str
    leg: str

    @field_validator("leg")
    @classmethod
    def _validate_leg(cls, v: str) -> str:
        parse_leg_ref(v)
        return v


class GapFeature(FeatureBase):
    """Point-in-time-safe by construction: `vs` is always the prior day's
    settled close, never today's own data — no `lag` needed."""

    type: Literal["gap"]
    source: Literal["fut", "cash"]
    vs: Literal["prev_close"] = "prev_close"


class RawFeature(FeatureBase):
    """A named passthrough onto a raw series (cash/fut) — every other
    feature type computes a derived aggregate, but a condition can only
    reference a *named feature*, so comparing "current price" against a
    computed feature (e.g. an opening-range breakout filter) needs this to
    give the raw series a name. `source` is builtin-only by construction, so
    it never needs the cross-reference check other sourced types get."""

    type: Literal["raw"]
    source: Literal["fut", "cash"]


class RollingMeanFeature(FeatureBase):
    type: Literal["rolling_mean"]
    source: str
    days: int = Field(gt=0)
    lag: int = Field(ge=1)  # no default — required, enforcing the non-negotiable


class EwmaFeature(FeatureBase):
    type: Literal["ewma"]
    source: str
    halflife_days: float = Field(gt=0)
    lag: int = Field(ge=1)


class RollingPctileFeature(FeatureBase):
    type: Literal["rolling_pctile"]
    source: str
    days: int = Field(gt=0)
    lag: int = Field(ge=1)


_FeatureUnion = (
    LegSumFeature
    | MaxRunupFeature
    | SessionHighFeature
    | SessionLowFeature
    | DaysToExpiryFeature
    | GreekFeature
    | GapFeature
    | RawFeature
    | RollingMeanFeature
    | EwmaFeature
    | RollingPctileFeature
)
FeatureSpec = Annotated[_FeatureUnion, Field(discriminator="type")]

_feature_adapter: TypeAdapter[FeatureSpec] = TypeAdapter(FeatureSpec)

#: Sources that don't need to resolve to another declared feature.
BUILTIN_SOURCES = frozenset({"cash", "fut"})

#: Feature types with an inherent rolling/cross-day source dependency —
#: their `source` field must point at another feature, not a raw series.
_SOURCED_TYPES = (
    MaxRunupFeature,
    SessionHighFeature,
    SessionLowFeature,
    RollingMeanFeature,
    EwmaFeature,
    RollingPctileFeature,
)


def parse_feature(spec: dict) -> FeatureSpec:
    """Validate one feature spec dict. Raises pydantic.ValidationError."""
    return _feature_adapter.validate_python(spec)


def check_source_reference(name: str, parsed: FeatureSpec, known: dict[str, FeatureSpec]) -> None:
    """Raise ValueError if `parsed`'s `source` (when it has one) is neither a
    built-in nor already present in `known`. Shared between `load_features`
    and the YAML loader (which needs the same check per-feature to attach
    line numbers to the error)."""
    if not isinstance(parsed, _SOURCED_TYPES):
        return
    source = parsed.source
    if source not in BUILTIN_SOURCES and source not in known:
        raise ValueError(
            f"Feature {name!r} references source {source!r}, which is "
            f"neither a built-in ({', '.join(sorted(BUILTIN_SOURCES))}) "
            f"nor a feature declared earlier in this file."
        )


def load_features(raw: dict[str, dict]) -> dict[str, FeatureSpec]:
    """Validate a full `features:` block. `source` references are resolved
    against features already declared earlier in the same dict (or a
    built-in) — forward references are rejected so the dependency order in
    the YAML is also the evaluation order."""
    features: dict[str, FeatureSpec] = {}
    for name, spec in raw.items():
        parsed = parse_feature(spec)
        check_source_reference(name, parsed, features)
        features[name] = parsed
    return features
