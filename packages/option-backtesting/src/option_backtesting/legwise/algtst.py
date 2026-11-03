"""A leg-wise strategy as an AlgoTest `.algtst` file (BL-137): AlgoTest's "Import strategy" format,
JSON for ONE strategy (one entry time, one exit time, the legs, one overall MTM stop), schema `0.8`.

`to_algtst(spec, name)` is a pure function. It maps only what the rotation universe uses, and every
mapping was read off an export AlgoTest itself wrote (`tests/fixtures/algtst/`): the owner's
`Nifty_Widesl_917_OTM1` (2026-10-18: time entry / exit, partial square-off, sell, CE / PE, weekly, a
strike by type, a percent stop and trail, the overall MTM stop, the constants) and three strategies
the owner built by hand on 2026-10-19 to settle the rest:

- a closest-premium strike is `EntryType.EntryByPremium` with the premium as a bare number in
  `StrikeParameter` (`150`), not an object;
- re-entry at cost is `{"Type": "ReentryType.AtCost", "Value": {"ReentryCount": n}}`;
- a range breakout on the leg's own premium, side high, is AlgoTest's "momentum" setting
  `{"Type": "MomentumType.DelayedBreadthHigh", "Time": <minutes from entry to the range end>,
  "Value": {"Type": "None", "Value": 0}}`; there is no separate range-breakout key;
- a buy leg is `PositionType.Buy`, a trail in points `TrailStopLossType.Points`.

Anything else that is set (a target, a points stop, re-entry asap or on target, roll, a peak
trail, a stop-and-reverse, a stop judged on the close, a range breakout on the index or side low
or with a gap or valid-until, next-weekly or monthly expiry, complete square-off,
`no_reentry_after`, an overall target, historical lot sizing) raises `Unmappable` naming the
field: never dropped, never guessed.
`execution.slippage_pct` and `cost_per_order_inr` are the engine's own assumptions and are not
exported.

Leg ids are derived from the strategy and leg ids, so a strategy always exports to the same bytes.
Integral numbers are written as integers, as AlgoTest writes them (`"Value": 115`)."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from .schema import Leg, LegwiseStrategy

VERSION = "0.8"

_ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz"


class Unmappable(ValueError):
    """A setting with no known `.algtst` form."""


@dataclass
class Export:
    name: str
    doc: dict

    def text(self) -> str:
        return json.dumps(self.doc, indent=2) + "\n"


def _num(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def _hm(hhmm: str) -> dict[str, int]:
    hour, minute = (int(x) for x in hhmm.split(":"))
    return {"Hour": hour, "Minute": minute}


def _minutes(hhmm: str) -> int:
    hour, minute = (int(x) for x in hhmm.split(":"))
    return hour * 60 + minute


def _time_node(hhmm: str) -> dict:
    return {
        "Type": "IndicatorTreeNodeType.OperandNode",
        "OperandType": "OperandType.And",
        "Value": [
            {
                "Type": "IndicatorTreeNodeType.DataNode",
                "Value": {"IndicatorName": "IndicatorType.TimeIndicator", "Parameters": _hm(hhmm)},
            }
        ],
    }


def leg_uid(strategy_id: str, leg_id: str) -> str:
    """8 lowercase letters / digits, like AlgoTest's own leg ids, stable for a strategy's leg."""
    n = int.from_bytes(hashlib.sha256(f"{strategy_id}:{leg_id}".encode()).digest()[:8], "big")
    out = []
    for _ in range(8):
        n, r = divmod(n, len(_ID_CHARS))
        out.append(_ID_CHARS[r])
    return "".join(out)


def _refuse(where: str, what: str) -> Unmappable:
    return Unmappable(f"{where}: {what} has no known .algtst form (BL-137); not exported")


def _leg(spec: LegwiseStrategy, leg: Leg) -> dict:
    where = f"{spec.id} leg {leg.id!r}"
    if leg.expiry != "weekly":
        raise _refuse(where, f"expiry {leg.expiry}")
    if leg.target is not None:
        raise _refuse(where, "target")
    if leg.reentry_on_target is not None:
        raise _refuse(where, "reentry_on_target")
    if leg.roll is not None:
        raise _refuse(where, "roll")
    if leg.trail_peak is not None:
        raise _refuse(where, "trail_peak")
    if leg.reverse_on_sl is not None:
        raise _refuse(where, "reverse_on_sl")
    if leg.stop_on != "tick":
        raise _refuse(where, f"stop_on: {leg.stop_on}")

    if leg.strike.strike_type is not None:
        entry_type = "EntryType.EntryByStrikeType"
        strike: str | int | float = f"StrikeType.{leg.strike.strike_type}"
    else:
        entry_type = "EntryType.EntryByPremium"
        strike = _num(leg.strike.closest_premium)

    if leg.stop_loss is None:
        stop = {"Type": "None", "Value": 0}
    elif leg.stop_loss.percent is not None:
        stop = {"Type": "LegTgtSLType.Percentage", "Value": _num(leg.stop_loss.percent)}
    else:
        raise _refuse(where, "stop_loss in points")

    if leg.trail_sl is None:
        trail: dict = {"Type": "None", "Value": {}}
    else:
        if leg.trail_sl.percent is not None:
            kind, (x, y) = "TrailStopLossType.Percentage", leg.trail_sl.percent
        else:
            kind, (x, y) = "TrailStopLossType.Points", leg.trail_sl.points
        trail = {"Type": kind, "Value": {"InstrumentMove": _num(x), "StopLossMove": _num(y)}}

    if leg.reentry_on_sl is None:
        reentry: dict = {"Type": "None", "Value": {}}
    elif leg.reentry_on_sl.mode == "cost":
        reentry = {"Type": "ReentryType.AtCost", "Value": {"ReentryCount": leg.reentry_on_sl.count}}
    else:
        raise _refuse(where, f"reentry_on_sl mode {leg.reentry_on_sl.mode}")

    momentum: dict = {"Type": "None", "Value": 0, "Time": None}
    rb = leg.range_breakout
    if rb is not None:
        if rb.source != "instrument":
            raise _refuse(where, f"range_breakout source {rb.source}")
        if rb.side != "high":
            raise _refuse(where, f"range_breakout side {rb.side}")
        if rb.gap_percent:
            raise _refuse(where, "range_breakout gap_percent")
        if rb.valid_until is not None:
            raise _refuse(where, "range_breakout valid_until")
        momentum = {
            "Type": "MomentumType.DelayedBreadthHigh",
            "Time": _minutes(rb.until) - _minutes(spec.entry_time),
            "Value": {"Type": "None", "Value": 0},
        }

    return {
        "EntryType": entry_type,
        "ExpiryKind": "ExpiryType.Weekly",
        "InstrumentKind": f"LegType.{leg.option_type}",
        "LegMomentum": momentum,
        "LegReentrySL": reentry,
        "LegReentryTP": {"Type": "None", "Value": {}},
        "LegStopLoss": stop,
        "LegTarget": {"Type": "None", "Value": 0},
        "LegTrailSL": trail,
        "LotConfig": {"Type": "LotType.Quantity", "Value": leg.lots},
        "PositionType": "PositionType.Buy" if leg.position == "buy" else "PositionType.Sell",
        "StrikeParameter": strike,
        "id": leg_uid(spec.id, leg.id),
    }


def to_algtst(spec: LegwiseStrategy, name: str | None = None) -> Export:
    """`spec` as an `.algtst` document named `name` (default: the spec's id)."""
    if spec.square_off != "partial":
        raise _refuse(spec.id, f"square_off {spec.square_off}")
    if spec.no_reentry_after is not None:
        raise _refuse(spec.id, "no_reentry_after")
    if spec.overall.target_inr is not None:
        raise _refuse(spec.id, "overall target_inr")
    if spec.execution.lot_sizing != "current":
        raise _refuse(spec.id, f"lot_sizing {spec.execution.lot_sizing}")

    legs = [_leg(spec, leg) for leg in spec.legs]
    stop = spec.overall.stop_loss_inr
    doc = {
        "version": VERSION,
        "name": name or spec.id,
        "strategy": {
            "Ticker": spec.underlying,
            "TakeUnderlyingFromCashOrNot": "True",
            "TrailSLtoBreakeven": "False",
            "SquareOffAllLegs": "False",
            "EntryIndicators": _time_node(spec.entry_time),
            "ExitIndicators": _time_node(spec.exit_time),
            "StrategyType": "StrategyType.IntradaySameDay",
            "MaxPositionInADay": 1,
            "ReentryTimeRestriction": "None",
            "SkipInitialCandles": 0,
            "StopMonitoringTime": "None",
            "ListOfLegConfigs": legs,
            "IdleLegConfigs": {},
            "OverallSL": (
                {"Type": "OverallTgtSLType.MTM", "Value": _num(stop)}
                if stop is not None
                else {"Type": "None", "Value": 0}
            ),
            "OverallTgt": {"Type": "None", "Value": 0},
            "OverallTrailSL": {"Type": "None", "Value": {}},
            "LockAndTrail": {"Type": "None", "Value": {}},
            "OverallReentrySL": {"Type": "None", "Value": {}},
            "OverallReentryTgt": {"Type": "None", "Value": {}},
            "OverallMomentum": {"Type": "None", "Value": 0},
            "WeeklyOldRegime": True,
        },
        "attributes": {"template": "Straddle920", "positional": "False"},
    }
    return Export(doc["name"], doc)
