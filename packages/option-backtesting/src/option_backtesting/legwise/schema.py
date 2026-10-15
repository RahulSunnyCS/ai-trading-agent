"""
YAML schema for leg-wise strategies — one field per AlgoTest setting, same
names where possible. Anything AlgoTest offers that the engine does not
implement yet (simple momentum, overall re-entry/trailing, RE MOMENTUM, trail
SL to break-even, BTST/positional, futures as underlying) is simply absent, so
`extra="forbid"` rejects a strategy that asks for it instead of silently
ignoring it.

    strategy:
      id: nifty_widesl_917_otm1
      underlying: NIFTY
      entry_time: "09:17"
      exit_time: "15:28"
      square_off: partial
      legs:
        - id: ce
          lots: 1
          position: sell
          option_type: CE
          expiry: weekly
          strike: { strike_type: OTM1 }        # or { closest_premium: 60 }
          stop_loss: { percent: 115 }          # or { points: 30 }
          trail_sl: { points: [15, 10] }       # every 15 pts in favour, move SL 10
          reentry_on_sl: { mode: cost, count: 1 }
          range_breakout: { until: "09:45", side: high, source: instrument }
          # optional: gap_percent: 2 (trigger 2% beyond the range edge), valid_until: "11:00"
      overall:
        stop_loss_inr: 2500
"""

from __future__ import annotations

import re
from datetime import time
from pathlib import Path
from typing import Literal

import yaml
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_serializer,
    model_validator,
)

_STRIKE_TYPE_RE = re.compile(r"^(ATM|(OTM|ITM)([1-9]\d?))$")


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _hhmm(value: str) -> str:
    time.fromisoformat(value)  # raises on a malformed time
    if not "09:15" <= value <= "15:29":
        raise ValueError(f"{value!r} is outside the 09:15-15:29 session")
    return value


class Strike(_Model):
    strike_type: str | None = None
    closest_premium: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _exactly_one(self) -> Strike:
        if (self.strike_type is None) == (self.closest_premium is None):
            raise ValueError("strike needs exactly one of strike_type or closest_premium")
        if self.strike_type is not None and not _STRIKE_TYPE_RE.match(self.strike_type):
            raise ValueError(f"strike_type {self.strike_type!r}: expected ATM, OTMn or ITMn")
        return self


class Amount(_Model):
    """Distance from the entry price, in premium points or percent of entry."""

    points: float | None = Field(default=None, gt=0)
    percent: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _exactly_one(self) -> Amount:
        if (self.points is None) == (self.percent is None):
            raise ValueError("give exactly one of points or percent")
        return self

    def distance(self, entry_price: float) -> float:
        return self.points if self.points is not None else entry_price * self.percent / 100


class TrailSL(_Model):
    """AlgoTest's two trail numbers [X, Y]: every X in the leg's favour moves
    the SL Y in the same direction."""

    points: tuple[float, float] | None = None
    percent: tuple[float, float] | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> TrailSL:
        if (self.points is None) == (self.percent is None):
            raise ValueError("trail_sl needs exactly one of points or percent")
        x, y = self.points or self.percent  # type: ignore[misc]
        if x <= 0 or y <= 0:
            raise ValueError("trail_sl values must be positive")
        return self

    def step(self, entry_price: float) -> tuple[float, float]:
        if self.points is not None:
            return self.points
        x, y = self.percent  # type: ignore[misc]
        return entry_price * x / 100, entry_price * y / 100


class ReEntry(_Model):
    #: asap — re-select the strike by the leg's own criteria and enter at the
    #: next minute; cost — same contract, re-enter when its price returns to
    #: the original entry price.
    mode: Literal["asap", "cost"]
    count: int = Field(ge=1, le=20)


class RangeBreakout(_Model):
    until: str
    #: Widen the trigger: enter only above the range high x (1 + gap_percent / 100) (side high)
    #: or below the range low x (1 - gap_percent / 100) (side low). 0 = the plain range edge.
    gap_percent: float = Field(default=0.0, ge=0, lt=100, allow_inf_nan=False)
    #: Last minute (inclusive) the breakout can still trigger; None = until the strategy exits.
    valid_until: str | None = None
    side: Literal["high", "low"]
    #: instrument — the range is the leg's own option premium ("Strike Price"
    #: in AlgoTest's dropdown); underlying — the index. (Not `on:` — YAML 1.1
    #: reads a bare `on` key as the boolean true.)
    source: Literal["instrument", "underlying"] = "instrument"

    _until = field_validator("until")(_hhmm)
    _valid_until = field_validator("valid_until")(lambda v: v if v is None else _hhmm(v))

    @model_serializer(mode="wrap")
    def _omit_new_defaults(self, handler):
        """Leave `gap_percent` / `valid_until` out of the dump while they are at their defaults.

        `store.spec_hash` is the hash of this dump; adding the two fields must not give every
        range-breakout strategy (all the Buy rotation variants) a new version, which would orphan
        its saved results and the frozen goldens' `strategy_spec_hash`.
        """
        data = handler(self)
        if data.get("gap_percent") == 0:
            data.pop("gap_percent", None)
        if data.get("valid_until") is None:
            data.pop("valid_until", None)
        return data


class RollSpec(_Model):
    """Roll an exhausted (decayed) sold leg: when its premium falls to `decay` x its entry price
    (checked at each bar's close, never after `not_after`), close it at that close and sell a
    fresh leg at the next minute's open, re-selected by the leg's own strike rule (or at ATM with
    `to_atm`). BL-105. The new leg takes `stop_loss_percent` as its stop when given."""

    decay: float = Field(gt=0, lt=1, allow_inf_nan=False)
    max_rolls: int = Field(default=1, ge=1, le=5)
    not_after: str = "13:30"
    #: roll only once the day's realised + open profit (all legs) is at least this many rupees
    min_day_profit: float | None = Field(default=None, gt=0)
    stop_loss_percent: float | None = Field(default=None, gt=0)
    to_atm: bool = False

    _not_after = field_validator("not_after")(_hhmm)

    @model_serializer(mode="wrap")
    def _omit_defaults(self, handler):
        data = handler(self)
        for key, default in (("max_rolls", 1), ("not_after", "13:30"), ("to_atm", False)):
            if data.get(key) == default:
                data.pop(key, None)
        for key in ("min_day_profit", "stop_loss_percent"):
            if data.get(key) is None:
                data.pop(key, None)
        return data


class Leg(_Model):
    id: str
    lots: int = Field(gt=0)
    position: Literal["buy", "sell"]
    option_type: Literal["CE", "PE"]
    expiry: Literal["weekly", "next_weekly", "monthly"] = "weekly"
    strike: Strike
    stop_loss: Amount | None = None
    target: Amount | None = None
    trail_sl: TrailSL | None = None
    reentry_on_sl: ReEntry | None = None
    reentry_on_target: ReEntry | None = None
    range_breakout: RangeBreakout | None = None
    roll: RollSpec | None = None

    @model_serializer(mode="wrap")
    def _omit_roll_when_unset(self, handler):
        """Leave `roll` out of the dump while unset: `store.spec_hash` is the hash of this dump,
        and adding the field must not give every saved strategy a new version (BL-105)."""
        data = handler(self)
        if data.get("roll") is None:
            data.pop("roll", None)
        return data

    @model_validator(mode="after")
    def _trail_needs_sl(self) -> Leg:
        if self.trail_sl is not None and self.stop_loss is None:
            raise ValueError(f"leg {self.id!r}: trail_sl needs a stop_loss to trail")
        if self.reentry_on_sl is not None and self.stop_loss is None:
            raise ValueError(f"leg {self.id!r}: reentry_on_sl needs a stop_loss")
        if self.reentry_on_target is not None and self.target is None:
            raise ValueError(f"leg {self.id!r}: reentry_on_target needs a target")
        if self.roll is not None:
            if self.position != "sell":
                raise ValueError(f"leg {self.id!r}: roll is for sold legs (a decayed premium)")
            if self.range_breakout is not None:
                raise ValueError(f"leg {self.id!r}: roll with range_breakout is not supported")
        return self


class Overall(_Model):
    stop_loss_inr: float | None = Field(default=None, gt=0)
    target_inr: float | None = Field(default=None, gt=0)


class Execution(_Model):
    #: Adverse slippage applied to every fill, as % of price.
    slippage_pct: float = Field(default=0.0, ge=0)
    #: Flat charge per order (entry and exit are one order each).
    cost_per_order_inr: float = Field(default=0.0, ge=0)
    #: Lot size used for every leg. "current" (the owner's choice, 2026-10-07, matching
    #: AlgoTest): today's lot for the whole history, so a rupee stop means the same on every
    #: day. "historical": each contract's own lot at the time (lot_sizes.csv keyed by expiry —
    #: what could actually have been traded).
    lot_sizing: Literal["current", "historical"] = "current"


class LegwiseStrategy(_Model):
    id: str
    underlying: Literal["NIFTY", "BANKNIFTY", "MIDCPNIFTY", "FINNIFTY", "SENSEX"]
    entry_time: str
    exit_time: str
    no_reentry_after: str | None = None
    square_off: Literal["partial", "complete"] = "partial"
    legs: list[Leg] = Field(min_length=1)
    overall: Overall = Field(default_factory=Overall)
    execution: Execution = Field(default_factory=Execution)

    _times = field_validator("entry_time", "exit_time", "no_reentry_after")(
        lambda v: v if v is None else _hhmm(v)
    )

    @model_validator(mode="after")
    def _consistent(self) -> LegwiseStrategy:
        if self.exit_time <= self.entry_time:
            raise ValueError("exit_time must be after entry_time")
        ids = [leg.id for leg in self.legs]
        if len(ids) != len(set(ids)):
            raise ValueError(f"leg ids must be unique, got {ids}")
        for leg in self.legs:
            rb = leg.range_breakout
            if rb is not None:
                if not self.entry_time < rb.until < self.exit_time:
                    raise ValueError(
                        f"leg {leg.id!r}: range_breakout.until must be inside entry-exit"
                    )
                if rb.valid_until is not None and not rb.until < rb.valid_until <= self.exit_time:
                    raise ValueError(
                        f"leg {leg.id!r}: range_breakout.valid_until must be after until "
                        "and no later than exit"
                    )
            reentry = leg.reentry_on_sl or leg.reentry_on_target
            if self.square_off == "complete" and leg.roll is not None:
                raise ValueError("roll with square_off: complete is not supported yet")
            if self.square_off == "complete" and reentry is not None:
                raise ValueError("re-entry with square_off: complete is not supported yet")
        return self


def load_legwise(path: Path) -> LegwiseStrategy:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict) or "strategy" not in data:
        raise ValueError(f"{path}: expected a top-level 'strategy:' mapping")
    return LegwiseStrategy.model_validate(data["strategy"])
