"""The higher-timeframe trend state used by BL-221 and BL-222 (moved here from research/bl221/run.py).

State of an index before a session opens: +1 when EMA 20 is above EMA 50 of its hourly closes (or daily
closes), -1 below, 0 equal, using only bars completed before that session. Hourly bars on the 09:15 grid are six
full hours (closes at minutes 59 ... 359) plus the 15-minute stub (minute 374)."""

from __future__ import annotations

HOUR_CLOSES = [59, 119, 179, 239, 299, 359, 374]
LAST = 374


def ema_state(values: list[float], fast: int, slow: int) -> list[float]:
    """+1 / -1 / 0 (EMA fast above / below / equal slow) AFTER each value, seeded with the first."""
    af, as_ = 2 / (fast + 1), 2 / (slow + 1)
    f = s = values[0]
    out = []
    for v in values:
        f += af * (v - f)
        s += as_ * (v - s)
        out.append(1.0 if f > s else -1.0 if f < s else 0.0)
    return out


def trend_states(frame) -> dict[str, dict[str, float]]:
    """{'hourly'|'daily': {session: state known BEFORE that session opens}} for a `ruletest` Frame."""
    days = list(frame.days)
    hourly_vals, owner = [], []
    for i in range(len(days)):
        for m in HOUR_CLOSES:
            hourly_vals.append(float(frame.C[i, m]))
            owner.append(i)
    after_hourly = ema_state(hourly_vals, 20, 50)
    last_of = {}
    for k, i in enumerate(owner):
        last_of[i] = after_hourly[k]  # the state after session i's last hourly bar
    daily = ema_state([float(frame.C[i, LAST]) for i in range(len(days))], 20, 50)
    out: dict[str, dict[str, float]] = {"hourly": {}, "daily": {}}
    for i, d in enumerate(days):
        out["hourly"][d] = last_of[i - 1] if i else 0.0
        out["daily"][d] = daily[i - 1] if i else 0.0
    return out
