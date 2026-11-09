"""Every strategy the rotation can pick, exported to AlgoTest and Quantiply and read back.

The exporters (`legwise/algtst.py`, `legwise/quantiply.py`) are pinned to the platforms' own
formats by a few fixtures (`tests/fixtures/algtst/`, `tests/fixtures/quantiply/`). This test covers
the whole universe instead: Core-298, the T1 track's variants and the fixed base's Dir leg, each
exported to both formats and DECODED back by a reader written from those fixtures' format (it
imports nothing from the exporters), then compared with the strategy's own YAML settings. A
setting an exporter drops, swaps or mis-scales for any strategy fails here by name, before it is
uploaded to a platform that would trade it.

What it does not prove: that a platform executes a setting the way the backtest engine does. That
is measured after the fact, per strategy and day, by the live-vs-paper comparison (BL-141).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from option_backtesting.legwise.algtst import to_algtst
from option_backtesting.legwise.quantiply import to_quantiply
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise

STRATEGIES = Path(__file__).resolve().parents[2] / "strategies"
FILES = sorted(
    [
        *STRATEGIES.glob("rotation/*.yaml"),
        *STRATEGIES.glob("rotation_t1/*.yaml"),
        *STRATEGIES.glob("rotation_base/*.yaml"),
    ]
)


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")[:2]
    return int(h) * 60 + int(m)


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _f(x) -> float | None:
    return None if x is None else float(x)


# --- the strategy's own settings --------------------------------------------------------------


def from_yaml(spec: LegwiseStrategy) -> dict:
    legs = []
    for leg in spec.legs:
        s = leg.strike
        rb = leg.range_breakout
        trail = None
        if leg.trail_sl is not None:
            kind = "percent" if leg.trail_sl.percent is not None else "points"
            x, y = leg.trail_sl.percent if kind == "percent" else leg.trail_sl.points
            trail = (kind, float(x), float(y))
        sl = None
        if leg.stop_loss is not None:
            sl = (
                ("percent", float(leg.stop_loss.percent))
                if leg.stop_loss.percent is not None
                else ("points", float(leg.stop_loss.points))
            )
        legs.append(
            {
                "position": leg.position,
                "option_type": leg.option_type,
                "lots": leg.lots,
                "strike": ("type", s.strike_type)
                if s.strike_type is not None
                else ("premium", float(s.closest_premium)),
                "stop_loss": sl,
                "trail": trail,
                "reentry_cost": None if leg.reentry_on_sl is None else leg.reentry_on_sl.count,
                "breakout": None if rb is None else (rb.side, rb.until),
            }
        )
    return {
        "underlying": spec.underlying,
        "entry": spec.entry_time,
        "exit": spec.exit_time,
        "overall_sl": _f(spec.overall.stop_loss_inr),
        "legs": sorted(legs, key=repr),
    }


# --- AlgoTest's .algtst, read back --------------------------------------------------------------


def _algtst_time(node: dict) -> str:
    (data,) = node["Value"]
    assert data["Value"]["IndicatorName"] == "IndicatorType.TimeIndicator"
    p = data["Value"]["Parameters"]
    return f"{p['Hour']:02d}:{p['Minute']:02d}"


def from_algtst(doc: dict) -> dict:
    s = doc["strategy"]
    entry = _algtst_time(s["EntryIndicators"])
    assert s["StrategyType"] == "StrategyType.IntradaySameDay"
    assert s["OverallTgt"]["Type"] == "None"
    legs = []
    for leg in s["ListOfLegConfigs"]:
        assert leg["ExpiryKind"] == "ExpiryType.Weekly"
        assert leg["LegTarget"]["Type"] == "None" and leg["LegReentryTP"]["Type"] == "None"
        assert leg["LotConfig"]["Type"] == "LotType.Quantity"
        if leg["EntryType"] == "EntryType.EntryByStrikeType":
            strike = ("type", leg["StrikeParameter"].removeprefix("StrikeType."))
        else:
            assert leg["EntryType"] == "EntryType.EntryByPremium"
            strike = ("premium", float(leg["StrikeParameter"]))
        stop = leg["LegStopLoss"]
        sl = None
        if stop["Type"] != "None":
            assert stop["Type"] == "LegTgtSLType.Percentage"
            sl = ("percent", float(stop["Value"]))
        tr = leg["LegTrailSL"]
        trail = None
        if tr["Type"] != "None":
            kind = {
                "TrailStopLossType.Percentage": "percent",
                "TrailStopLossType.Points": "points",
            }[tr["Type"]]
            trail = (kind, float(tr["Value"]["InstrumentMove"]), float(tr["Value"]["StopLossMove"]))
        re = leg["LegReentrySL"]
        reentry = None
        if re["Type"] != "None":
            assert re["Type"] == "ReentryType.AtCost"
            reentry = re["Value"]["ReentryCount"]
        mom = leg["LegMomentum"]
        breakout = None
        if mom["Type"] != "None":
            assert mom["Type"] == "MomentumType.DelayedBreadthHigh"
            breakout = ("high", _hhmm(_minutes(entry) + int(mom["Time"])))
        legs.append(
            {
                "position": {"PositionType.Buy": "buy", "PositionType.Sell": "sell"}[
                    leg["PositionType"]
                ],
                "option_type": leg["InstrumentKind"].removeprefix("LegType."),
                "lots": leg["LotConfig"]["Value"],
                "strike": strike,
                "stop_loss": sl,
                "trail": trail,
                "reentry_cost": reentry,
                "breakout": breakout,
            }
        )
    osl = s["OverallSL"]
    return {
        "underlying": s["Ticker"],
        "entry": entry,
        "exit": _algtst_time(s["ExitIndicators"]),
        "overall_sl": None if osl["Type"] == "None" else float(osl["Value"]),
        "legs": sorted(legs, key=repr),
    }


# --- Quantiply's POST /algos body, read back ----------------------------------------------------


def from_quantiply(body: dict, underlying: str) -> dict:
    c = body["configurations"]
    assert c["tradingType"] == "INTRADAY" and c["endDay"] == 0
    legs = []
    for leg in c["legs"]:
        assert leg["base"] == underlying
        assert leg["segment"] == "SEGMENT_OPTIONS" and leg["expiryTag"] == "CURRENT_WEEK"
        assert "target" not in leg
        if leg["selectionType"] == "STRIKE":
            strike = ("type", leg["strike"].replace("_", ""))
        else:
            assert leg["selectionType"] == "PREMIUM"
            assert leg["premium"]["type"] == "PREMIUM_CLOSE_TO"
            strike = ("premium", float(leg["premium"]["value"]))
        sl = None
        if "stoploss" in leg:
            kind = {"PER_POSITION_PERCENT": "percent", "PER_POSITION_POINT": "points"}[
                leg["stoploss"]["type"]
            ]
            sl = (kind, -float(leg["stoploss"]["value"]))
        trail = None
        if "trailingStoploss" in leg:
            t = leg["trailingStoploss"]
            kind = {"PER_POSITION_PERCENT": "percent", "PER_POSITION_POINT": "points"}[t["type"]]
            trail = (kind, float(t["moveBy"]), float(t["trailBy"]))
        reentry = None
        if "reEntry" in leg:
            assert leg["reEntry"]["type"] == "RE_ENTRY_COST"
            reentry = leg["reEntry"]["repeat"]
        breakout = None
        if "orb" in leg:
            assert leg["orb"]["type"] == "ORB_INSTRUMENT" and c["isORBEnabled"] is True
            breakout = (leg["orb"]["entryAt"].lower(), c["orbEndTime"][:5])
        legs.append(
            {
                "position": {"B": "buy", "S": "sell"}[leg["transactionType"]],
                "option_type": leg["side"],
                "lots": leg["quantity"],
                "strike": strike,
                "stop_loss": sl,
                "trail": trail,
                "reentry_cost": reentry,
                "breakout": breakout,
            }
        )
    assert c["isReEntryEnabled"] is any(x["reentry_cost"] is not None for x in legs)
    stop = c.get("stoploss")
    if stop is not None:
        assert stop["type"] == "TOTAL_AMOUNT" and stop["action"] == "SQ_OFF_ALL"
    return {
        "underlying": underlying,
        "entry": c["startTime"][:5],
        "exit": c["endTime"][:5],
        "overall_sl": None if stop is None else -float(stop["value"]),
        "legs": sorted(legs, key=repr),
    }


# --- the checks ---------------------------------------------------------------------------------


def test_the_universe_is_all_there():
    """298 Core variants, the T1 track's and the base's Dir leg: a missing folder must not make
    the round trip below pass on nothing."""
    assert len([f for f in FILES if f.parent.name == "rotation"]) == 298
    assert len([f for f in FILES if f.parent.name == "rotation_t1"]) > 0
    assert len([f for f in FILES if f.parent.name == "rotation_base"]) > 0


@pytest.mark.parametrize("path", FILES, ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_every_strategy_reads_back_the_same_from_both_platforms(path):
    spec = load_legwise(path)
    want = from_yaml(spec)
    assert from_algtst(to_algtst(spec, path.stem).doc) == want, "AlgoTest export differs"
    q = to_quantiply(spec, path.stem, ["MON"])
    assert q.unconfirmed == []
    assert q.body["day"] == ["MON"]
    assert from_quantiply(q.body, spec.underlying) == want, "Quantiply export differs"
