"""A leg-wise strategy as the body of Quantiply's create call (BL-139): `POST /algos` on
`api-prod.quantiply.angelone.in`, the call its web app makes when an algo is saved.

`to_quantiply(spec, name, days)` is a pure function. Every mapping was read off calls the web app
made on 2026-10-19 (`tests/fixtures/quantiply/`, contract in `docs/algotest-execution.md`):

- the owner's create of `N_OTM1_SL115_TSL15%10%_9_17`: times, a strike by type, a percent stop
  and trail, the overall MTM stop, partial square-off, one algo per weekday;
- Quantiply's own sample algos, opened for edit: a closest-premium strike
  (`selectionType: "PREMIUM"`), re-entry at cost (`reEntry: RE_ENTRY_COST`) and a range breakout
  on the leg's own price (`orb: ORB_INSTRUMENT`, the range from `startTime` to `orbEndTime`);
- the owner's own `N_ITM1_SL21_3000`, whose execution settings every export copies (owner,
  2026-10-19): limit orders with a buffer of 3, product D, SL limit buffer 1, a 3 s exit delay.

- the owner's `test1` (2026-10-19), saved to confirm a trail in points: `trailingStoploss` with
  `type: "PER_POSITION_POINT"` beside a percent stop, as the Buy shapes need.

A mapping taken from the web app's code but never seen saved would go in `Export.unconfirmed`,
which the uploader refuses; none is left.

Anything else that is set (a target, re-entry asap or on target, roll, a peak trail, a
stop-and-reverse, a stop judged on the close, a range breakout on the index or with a gap or
valid-until, next-weekly or monthly expiry, complete square-off, `no_reentry_after`, an overall
target, historical lot sizing) raises `Unmappable` naming the field: never dropped, never guessed.

Leg ids are derived from the strategy and leg ids, so a strategy always exports to the same body."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from .schema import Leg, LegwiseStrategy

CODE = "OPTIONS_SPREADS_LEGS"
WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")

#: The owner's own N_ITM1_SL21_3000 (read 2026-10-19), copied into every export.
EXECUTION: dict = {
    "entryOrderType": "L",
    "entryOrderLimitPrice": {"type": "FIXED_VALUE", "value": 3},
    "entryOrderTimeoutSeconds": 5,
    "stoplossLimitPrice": {"type": "FIXED_VALUE", "value": 1},
    "limitOrderTimeoutSeconds": 4,
    "stoplossOrderPlacement": "LATER",
    "stoplossSquareOffBy": "SL",
    "stoplossSquareOffDelay": 3,
    "mtmStoplossSquareOffDelay": 0,
    "entryOrderDelayType": None,
    "exitOrderDelayType": "B",
    "exitOrderDelay": 3,
    "errorAutoSquareOff": True,
}
PRODUCT = "D"

_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


class Unmappable(ValueError):
    """A setting with no known Quantiply form."""


@dataclass
class Export:
    name: str
    body: dict
    #: mappings taken from the web app's code but never seen saved; the uploader refuses these
    unconfirmed: list[str] = field(default_factory=list)

    def text(self) -> str:
        return json.dumps(self.body, indent=2) + "\n"


def _num(value: float) -> int | float:
    return int(value) if float(value).is_integer() else value


def _hms(hhmm: str) -> str:
    return f"{hhmm}:00"


def leg_uid(strategy_id: str, leg_id: str) -> str:
    """18 letters / digits, like the web app's own leg ids, stable for a strategy's leg."""
    n = int.from_bytes(hashlib.sha256(f"{strategy_id}:{leg_id}".encode()).digest()[:16], "big")
    out = []
    for _ in range(18):
        n, r = divmod(n, len(_ID_CHARS))
        out.append(_ID_CHARS[r])
    return "".join(out)


def _refuse(where: str, what: str) -> Unmappable:
    return Unmappable(f"{where}: {what} has no known Quantiply form (BL-139); not exported")


def _strike(strike_type: str) -> str:
    """`ATM` / `ITM1` / `OTM2` -> `ATM` / `ITM_1` / `OTM_2`."""
    if strike_type == "ATM":
        return "ATM"
    return f"{strike_type[:3]}_{strike_type[3:]}"


def _leg(spec: LegwiseStrategy, leg: Leg, unconfirmed: list[str]) -> dict:
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

    out: dict = {
        "id": leg_uid(spec.id, leg.id),
        "base": spec.underlying,
        "segment": "SEGMENT_OPTIONS",
        "side": leg.option_type,
        "transactionType": "B" if leg.position == "buy" else "S",
        "quantity": leg.lots,
        "product": PRODUCT,
        "expiryTag": "CURRENT_WEEK",
        "specificStrikeSelection": False,
        "mp": False,
    }
    if leg.strike.strike_type is not None:
        out["selectionType"] = "STRIKE"
        out["strike"] = _strike(leg.strike.strike_type)
    else:
        out["selectionType"] = "PREMIUM"
        out["premium"] = {
            "type": "PREMIUM_CLOSE_TO",
            "value": _num(leg.strike.closest_premium),
            "specificStrikeSelection": False,
        }

    if leg.stop_loss is not None:
        if leg.stop_loss.percent is not None:
            kind, size = "PER_POSITION_PERCENT", leg.stop_loss.percent
        else:
            kind, size = "PER_POSITION_POINT", leg.stop_loss.points
        out["stoploss"] = {"type": kind, "value": -_num(size)}

    if leg.trail_sl is not None:
        if leg.trail_sl.percent is not None:
            kind, (x, y) = "PER_POSITION_PERCENT", leg.trail_sl.percent
        else:
            kind, (x, y) = "PER_POSITION_POINT", leg.trail_sl.points
        out["trailingStoploss"] = {"type": kind, "moveBy": _num(x), "trailBy": _num(y)}

    if leg.reentry_on_sl is not None:
        if leg.reentry_on_sl.mode != "cost":
            raise _refuse(where, f"reentry_on_sl mode {leg.reentry_on_sl.mode}")
        out["reEntry"] = {"type": "RE_ENTRY_COST", "repeat": leg.reentry_on_sl.count}

    rb = leg.range_breakout
    if rb is not None:
        if rb.source != "instrument":
            raise _refuse(where, f"range_breakout source {rb.source}")
        if rb.gap_percent:
            raise _refuse(where, "range_breakout gap_percent")
        if rb.valid_until is not None:
            raise _refuse(where, "range_breakout valid_until")
        out["orb"] = {"type": "ORB_INSTRUMENT", "entryAt": rb.side.upper()}
    return out


def to_quantiply(
    spec: LegwiseStrategy, name: str | None = None, days: list[str] | None = None
) -> Export:
    """`spec` as a `POST /algos` body named `name` (default: the spec's id) for the weekdays
    `days` (`MON`...`SUN`; Quantiply makes one algo per day). Raises `Unmappable`."""
    if spec.square_off != "partial":
        raise _refuse(spec.id, f"square_off {spec.square_off}")
    if spec.no_reentry_after is not None:
        raise _refuse(spec.id, "no_reentry_after")
    if spec.overall.target_inr is not None:
        raise _refuse(spec.id, "overall target_inr")
    if spec.execution.lot_sizing != "current":
        raise _refuse(spec.id, f"lot_sizing {spec.execution.lot_sizing}")
    days = list(days or [])
    if not days or any(d not in WEEKDAYS for d in days):
        raise ValueError(f"days must be one or more of {', '.join(WEEKDAYS)}, got {days}")

    unconfirmed: list[str] = []
    legs = [_leg(spec, leg, unconfirmed) for leg in spec.legs]
    ranges = {leg.range_breakout.until for leg in spec.legs if leg.range_breakout is not None}
    if len(ranges) > 1:
        raise _refuse(spec.id, "range_breakout with different ends per leg")

    cfg: dict = {
        "underlying": "UNDERLYING_INDEX",
        "startTime": _hms(spec.entry_time),
        "endTime": _hms(spec.exit_time),
        "tradingType": "INTRADAY",
        "legsAction": "SQ_OFF_LEG",
        "moveStoplossToCost": False,
        "isWaitAndTradeEnabled": False,
        "tradeOnlyFirstEntry": False,
        "isReEntryEnabled": any("reEntry" in leg for leg in legs),
        "isORBEnabled": bool(ranges),
        "matching": [{"mode": "NO_MATCHING", "active": True}],
        "trailingInterval": {"frequency": "M", "value": 1},
        "endDay": 0,
        **EXECUTION,
        "legs": legs,
    }
    if ranges:
        cfg["orbEndTime"] = _hms(next(iter(ranges)))
    if spec.overall.stop_loss_inr is not None:
        cfg["stoploss"] = {
            "type": "TOTAL_AMOUNT",
            "value": -_num(spec.overall.stop_loss_inr),
            "action": "SQ_OFF_ALL",
        }
    body = {"code": CODE, "name": name or spec.id, "day": days, "configurations": cfg}
    return Export(body["name"], body, unconfirmed)


#: Keys the server adds or rewrites on save; `comparable` drops them before a read-back check.
SERVER_KEYS = {
    "_id",
    "__v",
    "user",
    "createdAt",
    "updatedAt",
    "enabled",
    "algoType",
    "status",
    "hasError",
    "entryErrorCount",
    "exitErrorCount",
    "hasWaiting",
    "hasWaitingWT",
    "broker",
    "day",
}


def comparable(body: dict, saved: dict) -> list[str]:
    """Fields of the sent `body` whose saved value (`GET /algos/:id`'s algo) differs. Keys only
    the server adds (its defaults) are ignored; every key we sent must come back unchanged."""
    diffs: list[str] = []

    def walk(sent, got, path):
        if isinstance(sent, dict):
            if not isinstance(got, dict):
                diffs.append(path or "/")
                return
            for k, v in sent.items():
                if k in SERVER_KEYS and not path:
                    continue
                walk(v, got.get(k, _MISSING), f"{path}.{k}" if path else k)
        elif isinstance(sent, list):
            if not isinstance(got, list) or len(got) != len(sent):
                diffs.append(path)
                return
            for i, (a, b) in enumerate(zip(sent, got, strict=True)):
                walk(a, b, f"{path}[{i}]")
        elif got is _MISSING or sent != got:
            diffs.append(path)

    walk({k: v for k, v in body.items() if k != "day"}, saved, "")
    return diffs


_MISSING = object()
