"""Plain-text reports for leg-wise runs (CLI now; the daily summary later)."""

from __future__ import annotations

from .engine import DayResult
from .market import minute_label


def _inr(value: float) -> str:
    return f"{value:+,.0f}"


def day_table(strategy_id: str, days: list[DayResult], show_trades: bool = False) -> str:
    lines = [f"== {strategy_id}"]
    if not days:
        return lines[0] + "\n   no collected days in range"
    lines.append(f"   {'date':<10} {'trades':>6} {'gross':>9} {'net':>9} {'worst MTM':>10}  note")
    for d in days:
        note = d.stopped_by or ""
        if d.notes:
            note = "; ".join(filter(None, [note, *d.notes]))
        lines.append(
            f"   {d.day.isoformat():<10} {len(d.trades):>6} {_inr(d.gross):>9} "
            f"{_inr(d.net):>9} {_inr(d.worst_mtm):>10}  {note}"
        )
        if show_trades:
            for t in d.trades:
                exit_at = minute_label(t.exit_min) if t.exit_min is not None else "--:--"
                lines.append(
                    f"      {t.leg_id:<4} {t.describe():<22} "
                    f"in {minute_label(t.entry_min)} @ {t.entry_price:8.2f}  "
                    f"out {exit_at} @ {t.exit_price or 0:8.2f} {t.exit_reason:<14} "
                    f"{_inr(t.pnl):>8}"
                )
    nets = [d.net for d in days]
    peak = running = drawdown = 0.0
    for n in nets:
        running += n
        peak = max(peak, running)
        drawdown = min(drawdown, running - peak)
    wins = sum(1 for n in nets if n > 0)
    lines.append(
        f"   total {_inr(sum(nets))} over {len(days)} days | {wins} up / {len(days) - wins} down"
        f" | avg {_inr(sum(nets) / len(days))} | max drawdown {_inr(drawdown)}"
    )
    return "\n".join(lines)
