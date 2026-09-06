"""
Strategy DSL — the pydantic AST for the YAML grammar in the design handoff
§5. Strategies are data: every archetype (flat, fixed-anchor pyramid, time
fallback, adaptive trailing, opening-range breakout, ...) is expressed
through this same schema, never as bespoke code per strategy.

Condition grammar (verbatim from the handoff):
    cond := { feature, op, value | ref } | { time, op, value }
          | { all: [...] } | { any: [...] } | { not: cond }
    ref  := { feature, at: entry | session_open | running_low | running_high
              | last_fill, plus: number | { feature }, times: number }
    op   := > >= < <= == in not_in crosses_above crosses_below
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..features.registry import STRIKE_RULES

Op = Literal[">", ">=", "<", "<=", "==", "in", "not_in", "crosses_above", "crosses_below"]

_ANCHOR = Literal["entry", "session_open", "running_low", "running_high", "last_fill"]


class DslModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Condition grammar (recursive)
# ---------------------------------------------------------------------------


class PlusFeatureRef(DslModel):
    """`plus: { feature: spike_thr_5d }` — an adaptive threshold that is
    itself another feature, as opposed to a fixed number."""

    feature: str


class Ref(DslModel):
    feature: str
    at: _ANCHOR = "entry"
    plus: float | PlusFeatureRef | None = None
    times: float | None = None


class FeatureCondition(DslModel):
    feature: str
    op: Op
    value: Any | None = None
    ref: Ref | None = None

    @model_validator(mode="after")
    def _exactly_one_of_value_or_ref(self) -> FeatureCondition:
        if (self.value is None) == (self.ref is None):
            raise ValueError(
                "A feature condition needs exactly one of 'value' or 'ref' "
                f"(feature={self.feature!r})"
            )
        return self


class TimeCondition(DslModel):
    time: str
    op: Op
    value: str


class AllCondition(DslModel):
    all: list[Condition] = Field(min_length=1)


class AnyCondition(DslModel):
    any: list[Condition] = Field(min_length=1)


class NotCondition(DslModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    not_: Condition = Field(alias="not")


Condition = FeatureCondition | TimeCondition | AllCondition | AnyCondition | NotCondition

AllCondition.model_rebuild()
AnyCondition.model_rebuild()
NotCondition.model_rebuild()


# ---------------------------------------------------------------------------
# Universe, legs, entry, ladders, fallback, caps
# ---------------------------------------------------------------------------


class Universe(DslModel):
    underlying: Literal["NIFTY", "BANKNIFTY", "SENSEX"]
    expiry: Literal["weekly", "monthly"] = "weekly"
    # The engine defaults to REGULAR per the handoff's non-negotiable
    # ("Session flag on every bar. Engine defaults to REGULAR."); this is
    # the only value accepted at the strategy-definition level today.
    session: Literal["REGULAR"] = "REGULAR"
    # One timeframe per strategy run, threaded through every Cache bar/greek
    # fetch — every committed strategy implicitly assumes 15m (matching the
    # golden fixture), so this default preserves current behavior exactly.
    timeframe: str = "15m"


class Leg(DslModel):
    id: str
    kind: Literal["OPT"] = "OPT"
    strike: str
    option: Literal["CE", "PE"]
    side: Literal["BUY", "SELL"]

    @field_validator("strike")
    @classmethod
    def _validate_strike_rule(cls, v: str) -> str:
        if v not in STRIKE_RULES:
            raise ValueError(f"Unknown strike rule {v!r}; expected one of {STRIKE_RULES}")
        return v


class Entry(DslModel):
    time: str
    lots: int = Field(gt=0)
    filter: list[Condition] = Field(default_factory=list)


class Ladder(DslModel):
    id: str
    when: Condition
    lots: int = Field(gt=0)
    after: str | None = None


class Fallback(DslModel):
    time: str
    lots: int = Field(gt=0)
    unless_fired_before: bool = True


class Caps(DslModel):
    max_lots: int = Field(gt=0)


# ---------------------------------------------------------------------------
# Exits
# ---------------------------------------------------------------------------


class TimeExit(DslModel):
    type: Literal["time"]
    at: str


class StopLossExit(DslModel):
    type: Literal["stop_loss"]
    basis: Literal["premium_pct", "mtm_inr"]
    value: float


class ProfitTargetExit(DslModel):
    type: Literal["profit_target"]
    basis: Literal["premium_pct", "mtm_inr"]
    value: float


class TrailingExit(DslModel):
    type: Literal["trailing"]
    basis: Literal["mtm_inr", "premium_pct"]
    trail: float
    activate_at: float


ExitSpec = Annotated[
    TimeExit | StopLossExit | ProfitTargetExit | TrailingExit,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Fills, costs, sizing
# ---------------------------------------------------------------------------


class Fills(DslModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    # Field renamed from the YAML key "model" to avoid pydantic's reserved
    # `model_*` attribute prefix; `model` is still accepted via the alias.
    fill_model: Literal["trigger_level", "bar_close", "worst_of_bar", "next_open"] = Field(
        alias="model"
    )
    slippage_bps: float = 0

    @property
    def is_research_only(self) -> bool:
        """bar_close is labelled research-only in the UI (design handoff) —
        measured ~40% optimistic vs trigger_level."""
        return self.fill_model == "bar_close"


class Costs(DslModel):
    per_leg_rt: float = Field(ge=0)


class Sizing(DslModel):
    mode: Literal["fixed_lots"] = "fixed_lots"


# ---------------------------------------------------------------------------
# Top-level strategy
# ---------------------------------------------------------------------------


class StrategySpec(DslModel):
    id: str
    version: int = 1
    universe: Universe
    legs: list[Leg] = Field(min_length=1)
    entry: Entry
    ladders: list[Ladder] = Field(default_factory=list)
    fallback: Fallback | None = None
    caps: Caps
    exits: list[ExitSpec] = Field(min_length=1)
    fills: Fills
    costs: Costs
    sizing: Sizing = Field(default_factory=Sizing)

    @model_validator(mode="after")
    def _validate_unique_leg_ids(self) -> StrategySpec:
        ids = [leg.id for leg in self.legs]
        if len(ids) != len(set(ids)):
            raise ValueError(f"Leg ids must be unique, got {ids}")
        return self

    @model_validator(mode="after")
    def _validate_ladder_after_refs(self) -> StrategySpec:
        ladder_ids = {ladder.id for ladder in self.ladders}
        for ladder in self.ladders:
            if ladder.after is not None and ladder.after not in ladder_ids:
                raise ValueError(
                    f"Ladder {ladder.id!r} has after={ladder.after!r}, "
                    f"which is not a declared ladder id ({sorted(ladder_ids)})"
                )
        return self

    @model_validator(mode="after")
    def _validate_max_lots_reachable(self) -> StrategySpec:
        total_possible = self.entry.lots + sum(ladder.lots for ladder in self.ladders)
        if self.fallback is not None:
            total_possible += self.fallback.lots
        if self.caps.max_lots > total_possible:
            raise ValueError(
                f"caps.max_lots={self.caps.max_lots} can never be reached — "
                f"entry + ladders + fallback sum to at most {total_possible} lots"
            )
        return self
