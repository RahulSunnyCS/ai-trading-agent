"""
Everything the dashboard's "day forensics" view draws for ONE strategy on ONE day,
built from a fresh simulation (the engine is deterministic, so nothing but the
saved result is ever stored — see DayResult.mtm).

Timestamps are `ts`: seconds since the epoch of the IST WALL-CLOCK time read as if it
were UTC. Lightweight Charts renders time axes in UTC, so this makes the axis show
09:15..15:29 exactly as traded, with no timezone handling in the browser.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime

from .engine import DayResult
from .market import SESSION_START_MIN, DayData, Series, minute_label
from .schema import LegwiseStrategy


def wall_ts(day: date, minute: int) -> int:
    base = datetime(day.year, day.month, day.day, tzinfo=UTC)
    return int(base.timestamp()) + (SESSION_START_MIN + minute) * 60


def _line(day: date, series: Series, lo: int, hi: int) -> list[dict]:
    out = []
    for m in range(lo, hi + 1):
        v = series.close[m] if m < len(series.close) else None
        if v is not None:
            out.append({"ts": wall_ts(day, m), "t": minute_label(m), "v": round(v, 2)})
    return out


def lot_multiplier(strategy: LegwiseStrategy) -> int:
    """The strategy's 'one lot' for per-lot normalisation: the smallest leg size, so a
    1-lot-per-leg strategy divides by 1 and a 2-lot one by 2."""
    return max(1, min(leg.lots for leg in strategy.legs))


def build_forensics(
    strategy: LegwiseStrategy,
    data: DayData,
    result: DayResult,
    cuts: Sequence[int],
    anatomy: dict | None,
    sha: str,
) -> dict:
    day = result.day
    from .market import minute_index

    start, end = minute_index(strategy.entry_time), minute_index(strategy.exit_time)
    last = min(end, len(data.spot.close) - 1)
    lots = lot_multiplier(strategy)

    legs, markers = [], []
    for t in result.trades:
        series = data.chain.get(t.contract)
        exit_min = t.exit_min if t.exit_min is not None else last
        legs.append(
            {
                "leg": t.leg_id,
                "contract": t.describe(),
                "entry": minute_label(t.entry_min),
                "exit": minute_label(exit_min),
                "premium": _line(day, series, t.entry_min, min(exit_min, last)) if series else [],
            }
        )
        markers.append(
            {
                "ts": wall_ts(day, t.entry_min),
                "kind": "entry",
                "leg": t.leg_id,
                "price": round(t.entry_price, 2),
                "position": t.position,
            }
        )
        if t.exit_price is not None:
            markers.append(
                {
                    "ts": wall_ts(day, exit_min),
                    "kind": "exit",
                    "leg": t.leg_id,
                    "price": round(t.exit_price, 2),
                    "reason": t.exit_reason,
                }
            )

    per_order = strategy.execution.cost_per_order_inr
    attribution = []
    for leg in strategy.legs:
        mine = [t for t in result.trades if t.leg_id == leg.id]
        pnl = sum(t.pnl for t in mine)
        costs = len(mine) * 2 * per_order
        attribution.append(
            {
                "leg": leg.id,
                "trades": len(mine),
                "gross": round(pnl, 2),
                "costs": round(costs, 2),
                "net": round(pnl - costs, 2),
                "sl_hits": sum(1 for t in mine if t.exit_reason == "SL"),
                "target_hits": sum(1 for t in mine if t.exit_reason == "TARGET"),
                "reentries": max(0, len(mine) - 1),
            }
        )

    return {
        "strategy_id": strategy.id,
        "sha": sha,
        "day": day.isoformat(),
        "underlying": strategy.underlying,
        "gross": round(result.gross, 2),
        "costs": round(result.costs, 2),
        "net": round(result.net, 2),
        "worst_mtm": round(result.worst_mtm, 2),
        "best_mtm": round(result.best_mtm, 2),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        "lots": lots,
        "net_per_lot": round(result.net / lots, 2),
        "window": {"start": minute_label(start), "end": minute_label(end)},
        "mtm": [
            {"ts": wall_ts(day, m), "t": minute_label(m), "v": round(v, 2)} for m, v in result.mtm
        ],
        "spot": _line(day, data.spot, start, last),
        "legs": legs,
        "markers": markers,
        "attribution": attribution,
        # the same rows the saved results and the evening summary use
        "trades": [
            {
                "leg": t.leg_id,
                "contract": t.describe(),
                "entry": minute_label(t.entry_min),
                "entry_price": round(t.entry_price, 2),
                "exit": minute_label(t.exit_min) if t.exit_min is not None else None,
                "exit_price": round(t.exit_price, 2) if t.exit_price is not None else None,
                "reason": t.exit_reason,
                "pnl": round(t.pnl, 2),
            }
            for t in result.trades
        ],
        "cuts": [{"ts": wall_ts(day, c), "t": minute_label(c)} for c in cuts],
        "anatomy": anatomy,
    }
