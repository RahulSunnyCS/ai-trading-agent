"""A rule strategy: WHEN a condition on the index's bars fires, WHAT legwise legs to trade from the
next minute, and how they are managed (the legwise template's own stops, trail and exit).

    rule:
      id: pivot_cross_dir
      underlying: NIFTY
      window: { from: "10:30", to: "14:00" }      # stamps of the bar whose close fires the rule
      define:                                      # optional named sub-conditions, in order
        trend: { div: [{ sub: [close, session_open] }, atr14] }
      when: { ge: [trend, 0.3] }                   # the grammar is in ruletest/expr.py
      direction_up: { gt: [close, open] }          # optional; needed only for legs that say `on:`
      exit_when: { lt: [close, session_open] }     # optional; or { up: ..., down: ... } per side
      template:           # a legwise strategy without id / underlying / entry_time
        exit_time: "15:28"
        legs:
          - { id: ce, lots: 1, position: sell, option_type: CE, strike: { strike_type: ATM },
              stop_loss: { percent: 21 } }
          - { id: pe, lots: 1, position: sell, option_type: PE, strike: { strike_type: ATM },
              stop_loss: { percent: 21 }, on: both }   # on: up | down | both (default both)
        overall: { stop_loss_inr: 3000 }

The first stamp in the window where `when` is true is the event (one per session). The trade enters
at the open of the next stamp, as BL-083: `entry_time` is the firing bar's stamp + 1 minute.
`direction_up` picks the legs for an event: a leg with `on: up` trades only when it is true there.
A leg with its own `range_breakout` is not supported yet, because its `until` is a clock time.

`exit_when` (optional) closes the trade early: at the first stamp from the entry minute on where it
is true, every leg exits the next minute (the bar-close fill, as the entry), never later than the
template's `exit_time`. With `direction_up`, it may be a mapping `{up: ..., down: ...}`, one
condition per side (a Supertrend exit is the usual case). The same exit rule is applied to the
placebo and random-time controls from their own entry minute.

A leg's strike may also be `{ premium_pct_of_spot: 1.0 }`: the strike whose premium is nearest that
percentage of the index at the entry (its `closest_premium`, worked out per trade).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..legwise.schema import LegwiseStrategy
from . import expr as E

SIDES = ("both", "up", "down")
LEG_SIDES = ("both", "up", "down")


class SpecError(ValueError):
    """The spec is not usable; the message says where and why."""


class Window(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    from_: str = Field(alias="from")
    to: str

    @field_validator("from_", "to")
    @classmethod
    def _clock(cls, value: str) -> str:
        E.clock_to_stamp(value, "window")
        return value


class RuleSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9_]{1,64}$")
    name: str | None = None
    underlying: str
    window: Window
    define: dict[str, Any] = Field(default_factory=dict)
    when: Any
    direction_up: Any = None
    exit_when: Any = None
    template: dict[str, Any]
    #: hash of the spec this one was derived from, for the tested-strategies ledger
    parent: str | None = None
    notes: str | None = None

    @field_validator("underlying")
    @classmethod
    def _underlying(cls, value: str) -> str:
        if value not in ("NIFTY", "SENSEX"):
            raise ValueError("underlying must be NIFTY or SENSEX")
        return value


@dataclass
class CompiledRule:
    spec: RuleSpec
    when: E.Node
    defs: dict[str, E.Node]
    direction: E.Node | None
    exits: dict[str, E.Node] | None  # side ("both" / "up" / "down") -> the exit condition
    start: int  # first stamp a firing may happen on
    stop: int  # last stamp
    legs: list[dict[str, Any]]  # the template's legs, each with its `on`
    spec_hash: str
    template_hash: str

    @property
    def sides(self) -> tuple[str, ...]:
        """The side keys a simulation can have: `both` when no leg depends on direction."""
        return ("up", "down") if self.direction is not None else ("both",)

    @property
    def exit_cap(self) -> str:
        """The template's own exit time, the latest an `exit_when` exit can happen."""
        return str(self.spec.template["exit_time"])

    def strategy_for(
        self,
        entry_time: str,
        side: str,
        slippage_pct: float | None = None,
        exit_time: str | None = None,
        spot: float | None = None,
    ) -> LegwiseStrategy:
        """The legwise strategy of one trade. `exit_time` is that trade's `exit_when` exit (None:
        the template's); `spot` prices a `premium_pct_of_spot` strike and is required for one."""
        body = _strategy_dict(self.spec, self.legs, entry_time, side, spot)
        if exit_time is not None:
            body["exit_time"] = exit_time
        if slippage_pct is not None:
            body["execution"] = {**body.get("execution", {}), "slippage_pct": slippage_pct}
        return LegwiseStrategy.model_validate(body)


PCT_KEY = "premium_pct_of_spot"


def _strike_for(strike: Any, spot: float | None) -> Any:
    """A `premium_pct_of_spot` strike as the legwise `closest_premium` it means at this spot. With
    no spot (checking the template's shape), the percentage itself stands in for the premium."""
    if not isinstance(strike, dict) or PCT_KEY not in strike:
        return strike
    pct = strike[PCT_KEY]
    rest = {k: v for k, v in strike.items() if k != PCT_KEY}
    premium = pct if spot is None else round(spot * pct / 100, 2)
    return {**rest, "closest_premium": premium}


def _legs_for(
    legs: list[dict[str, Any]], side: str, spot: float | None = None
) -> list[dict[str, Any]]:
    chosen = [leg for leg in legs if leg["on"] in ("both", side) or side == "both"]
    return [
        {k: (_strike_for(v, spot) if k == "strike" else v) for k, v in leg.items() if k != "on"}
        for leg in chosen
    ]


def _strategy_dict(
    spec: RuleSpec, legs: list[dict[str, Any]], entry: str, side: str, spot: float | None = None
) -> dict:
    template = {k: v for k, v in spec.template.items() if k != "legs"}
    return {
        "id": f"rule_{spec.id}",
        "underlying": spec.underlying,
        "entry_time": entry,
        "legs": _legs_for(legs, side, spot),
        **template,
    }


def _parse_exits(spec: RuleSpec, defs: dict[str, E.Node], directional: bool):
    """{side: exit condition} from `exit_when`, or None when the rule has none."""
    body = spec.exit_when
    if body is None:
        return None
    if isinstance(body, dict) and set(body) == {"up", "down"}:
        if not directional:
            raise E.RuleError("exit_when: an up / down exit needs `direction_up`")
        nodes = {side: E.parse(body[side], defs, f"exit_when.{side}") for side in ("up", "down")}
    else:
        node = E.parse(body, defs, "exit_when")
        nodes = {side: node for side in (("up", "down") if directional else ("both",))}
    for side, node in nodes.items():
        if node.kind != "bool":
            raise E.RuleError(f"exit_when ({side}): must be true / false, not a number")
    return nodes


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def compile_spec(spec: RuleSpec) -> CompiledRule:
    try:
        when, defs = E.parse_rule(spec.when, spec.define)
        direction = None
        if spec.direction_up is not None:
            direction = E.parse(spec.direction_up, defs, "direction_up")
            if direction.kind != "bool":
                raise E.RuleError("direction_up: must be true / false, not a number")
        exits = _parse_exits(spec, defs, direction is not None)
    except E.RuleError as error:
        raise SpecError(str(error)) from error
    start, stop = (E.clock_to_stamp(t, "window") for t in (spec.window.from_, spec.window.to))
    if start > stop:
        raise SpecError("window: `from` is after `to`")
    if stop + 1 >= E.N_BARS:
        raise SpecError("window.to: the entry minute after it must still be inside the session")
    if "legs" not in spec.template or not isinstance(spec.template["legs"], list):
        raise SpecError("template.legs: give the legs to trade")
    legs: list[dict[str, Any]] = []
    for k, leg in enumerate(spec.template["legs"]):
        if not isinstance(leg, dict):
            raise SpecError(f"template.legs[{k}]: expected a mapping")
        if True in leg:  # YAML 1.1 reads an unquoted `on:` key as true
            leg = {("on" if key is True else key): value for key, value in leg.items()}
        on = leg.get("on", "both")
        if on not in LEG_SIDES:
            raise SpecError(f"template.legs[{k}].on: expected up, down or both, got {on!r}")
        strike = leg.get("strike")
        if isinstance(strike, dict) and PCT_KEY in strike:
            pct = strike[PCT_KEY]
            if isinstance(pct, bool) or not isinstance(pct, (int, float)) or not 0 < pct <= 20:
                raise SpecError(f"template.legs[{k}].strike.{PCT_KEY}: expected 0 < % <= 20")
            if "closest_premium" in strike or "strike_type" in strike:
                raise SpecError(f"template.legs[{k}].strike: give {PCT_KEY} alone")
        if leg.get("range_breakout") is not None:
            raise SpecError(
                f"template.legs[{k}].range_breakout: not supported in a rule yet "
                "(its `until` is a clock time, not a minute after the trigger)"
            )
        legs.append({**leg, "on": on})
    directional = any(leg["on"] != "both" for leg in legs)
    if directional and direction is None:
        raise SpecError("a leg says `on: up` or `on: down`, so the rule needs `direction_up`")
    if direction is not None and not directional:
        raise SpecError("`direction_up` is set but no leg depends on it (add `on:` to a leg)")
    entry = E.stamp_to_clock(stop + 1)
    for side in ("up", "down") if direction is not None else ("both",):
        try:
            LegwiseStrategy.model_validate(_strategy_dict(spec, legs, entry, side))
        except ValidationError as error:
            first = error.errors()[0]
            where = ".".join(str(p) for p in first["loc"])
            raise SpecError(f"template ({side}): {where}: {first['msg']}") from error
    if exits is not None and "exit_time" not in spec.template:
        raise SpecError("template.exit_time: an `exit_when` rule needs the latest exit time")
    # `exit_when` (and the definitions it reads) joins both hashes only when set, so a rule without
    # one keeps the hashes, the ledger rows and the simulation cache it always had. With one, the
    # cached simulation of (day, entry, side) depends on the exit too, hence the template hash.
    exit_part = {} if exits is None else {"exit_when": spec.exit_when, "define": spec.define}
    spec_hash = hashlib.sha256(
        _canonical(
            {
                "underlying": spec.underlying,
                "window": [spec.window.from_, spec.window.to],
                "define": spec.define,
                "when": spec.when,
                "direction_up": spec.direction_up,
                "template": {**spec.template, "legs": legs},
                **({"exit_when": spec.exit_when} if exits is not None else {}),
            }
        ).encode()
    ).hexdigest()[:16]
    template_hash = hashlib.sha256(
        _canonical(
            {
                "underlying": spec.underlying,
                "template": {**spec.template, "legs": legs},
                **exit_part,
            }
        ).encode()
    ).hexdigest()[:16]
    return CompiledRule(
        spec, when, defs, direction, exits, start, stop, legs, spec_hash, template_hash
    )


def load_spec(text: str) -> CompiledRule:
    """Parse YAML (or JSON) text into a compiled rule, or raise SpecError with a plain message."""
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        where = f" at line {mark.line + 1}" if mark else ""
        raise SpecError(f"the text is not valid YAML{where}") from error
    if not isinstance(data, dict) or set(data) != {"rule"} or not isinstance(data["rule"], dict):
        raise SpecError("the file must have one top-level key, `rule:`")
    return from_dict(data["rule"])


def from_dict(data: dict[str, Any]) -> CompiledRule:
    try:
        spec = RuleSpec.model_validate(data)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(p) for p in first["loc"]) or "rule"
        raise SpecError(f"{where}: {first['msg']}") from error
    return compile_spec(spec)


# --- plain words ---------------------------------------------------------------------------


def _leg_words(leg: dict[str, Any]) -> str:
    strike = leg["strike"]
    if strike.get("strike_type"):
        where = strike["strike_type"]
    elif PCT_KEY in strike:
        where = f"the strike whose premium is nearest {strike[PCT_KEY]:g}% of the index"
    else:
        where = f"the strike nearest ₹{strike['closest_premium']:g}"
    bits = [f"{leg['position']} {leg['lots']} lot {where} {leg['option_type']}"]
    stop = leg.get("stop_loss")
    if stop:
        bits.append(
            f"stop {stop['percent']:g}%" if "percent" in stop else f"stop {stop['points']:g} points"
        )
    return ", ".join(bits)


def read_back(rule: CompiledRule) -> dict[str, Any]:
    """The rule in plain sentences, built from the compiled tree so it cannot say more or less
    than the rule does."""
    spec = rule.spec
    when = E.describe(rule.when)
    sentences = [
        f"Watch the {spec.underlying} index from {spec.window.from_} to {spec.window.to}. "
        f"The first time {when}, enter the next minute.",
    ]
    if rule.direction is not None:
        sentences.append(
            f"It counts as an upward event when {E.describe(rule.direction)}, else downward."
        )
    if rule.exits is not None:
        if set(rule.exits) == {"up", "down"} and rule.exits["up"] is not rule.exits["down"]:
            for side in ("up", "down"):
                sentences.append(
                    f"On {side} events, exit the minute after {E.describe(rule.exits[side])}."
                )
        else:
            only = next(iter(rule.exits.values()))
            sentences.append(f"Exit early the minute after {E.describe(only)}.")
    template = spec.template
    for leg in rule.legs:
        suffix = "" if leg["on"] == "both" else f" (only on {leg['on']} events)"
        sentences.append(f"Trade: {_leg_words(leg)}{suffix}.")
    manage = [
        f"exit {'by' if rule.exits is not None else 'at'} {template.get('exit_time', '15:28')}"
    ]
    overall = template.get("overall") or {}
    if overall.get("stop_loss_inr"):
        manage.append(f"overall stop ₹{overall['stop_loss_inr']:g}")
    if overall.get("target_inr"):
        manage.append(f"overall target ₹{overall['target_inr']:g}")
    sentences.append("Manage: " + ", ".join(manage) + ". One trade a day at most.")
    return {
        "sentences": sentences,
        "definitions": E.describe_defs(rule.defs),
        "when": when,
        "spec_hash": rule.spec_hash,
    }
