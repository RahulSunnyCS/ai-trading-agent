"""Where T1 stands against its own past: the evening message's drawdown line (owner, 2026-11-04).

The series is the result message's own figures for list C of the T1 track: each day's picks
(core and any Buy add-on), one lot per strategy, net after estimated costs and
`slippage.SLIPPAGE_PCT` % slippage on every fill, read from the stored results
(`store.read_net` under `store.slipped`). From the track's first journal entry the picks are the
recorded ones; before it they are re-derived with `daylog.reconstruction` (the same
`pick.score_history` the 09:16 job calls, without the BL-122 expiry rule, as reconstructed history
always is). A day whose picks are not all stored is left out and counted, never zero.

`measure` reads the running total over the last `WINDOW_DAYS` calendar days: the drawdown is the
running peak (starting at zero, `readout.max_drawdown`'s convention) minus the total, and the line
says how deep the drawdown is now, from which day's high, and on what share of the window's days
it was at least that deep. Descriptive and in-sample before the journal began; nothing is written.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from ..fyers.daily import data_dir
from . import journal, result, slippage, store

#: how far back the comparison reaches (owner: "in the last 2 years")
WINDOW_DAYS = 730
TRACK = "t1"
LIST_KEY = "C"


@dataclass(frozen=True)
class Standing:
    """The drawdown now and how often the window was at least that deep."""

    day: date
    #: rupees below the running high (0 = at a high), one lot per strategy
    drawdown: float
    #: the day the running high was set (None while it is still the zero start)
    high_day: date | None
    #: days in the window, and how many of them had a drawdown at least today's (today included)
    days: int
    at_least: int
    #: days below a high at all
    under_water: int
    #: the window's deepest drawdown and its day
    deepest: float
    deepest_day: date | None
    first_day: date
    #: days left out because a pick had no stored result
    left_out: int
    #: the first recorded (journal) day; earlier days are re-derived
    recorded_from: date | None
    slippage_pct: float | None
    #: the series reaches back the whole window (False while the stored data is younger)
    window_full: bool = False


def measure(
    series: list[tuple[date, float]],
    left_out: int = 0,
    recorded_from: date | None = None,
    slippage_pct: float | None = None,
    window_start: date | None = None,
) -> Standing | None:
    """The standing at the series' last day; None for an empty series. `series` is [(day, net)],
    in day order."""
    if not series:
        return None
    total = peak = 0.0
    high_day: date | None = None
    drawdowns: list[float] = []
    deepest, deepest_day = 0.0, None
    for d, value in series:
        total += value
        if total >= peak:
            peak, high_day = total, d
        dd = peak - total
        drawdowns.append(dd)
        if dd > deepest:
            deepest, deepest_day = dd, d
    now = drawdowns[-1]
    return Standing(
        day=series[-1][0],
        drawdown=now,
        high_day=high_day,
        days=len(drawdowns),
        at_least=sum(1 for x in drawdowns if x >= now) if now > 0 else 0,
        under_water=sum(1 for x in drawdowns if x > 0),
        deepest=deepest,
        deepest_day=deepest_day,
        first_day=series[0][0],
        left_out=left_out,
        recorded_from=recorded_from,
        slippage_pct=slippage_pct,
        # a week's slack: the window's first calendar days may be a weekend or a holiday
        window_full=window_start is not None and series[0][0] <= window_start + timedelta(days=7),
    )


def _earlier_picks(root: Path, start: date, until: date) -> dict[date, list[str] | None]:
    """{day: list C's names} for the days in [start, until) before the track's journal, re-derived
    (see the module); a day the ranking cannot score maps to None."""
    from . import daylog
    from .variants import track_names, variant_names

    recon = daylog.reconstruction(root, variant_names() + track_names(TRACK))
    out: dict[date, list[str] | None] = {}
    for d in recon.days_available():
        if not start <= d < until:
            continue
        lists = recon.picks(d)
        c = (lists or {}).get(LIST_KEY)
        out[d] = [*c["core"], *(c.get("buy") or [])] if c else None
    return out


def t1(
    day: date,
    root: Path | None = None,
    today: result.DailyResult | None = None,
    slip: float | None = None,
    earlier: dict[date, list[str] | None] | None = None,
) -> Standing | None:
    """T1's standing on `day` (None with no day counted). `today` is the day's result when the
    caller has it (its slipped figure is the message's own); `earlier` ({day: names}) stands in
    for the re-derivation of the days before the journal (tests)."""
    root = root or data_dir()
    slip = slippage.SLIPPAGE_PCT if slip is None else slip
    start = day - timedelta(days=WINDOW_DAYS)
    entries = {
        date.fromisoformat(e["day"]): e
        for e in journal.read(store.journal_path(root, TRACK))
        if start.isoformat() <= str(e.get("day", "")) <= day.isoformat()
    }
    recorded_from = min(entries) if entries else None
    until = recorded_from or day + timedelta(days=1)
    if earlier is None:
        earlier = _earlier_picks(root, start, until)
    picks = {d: v for d, v in earlier.items() if start <= d < until and d <= day}
    for d, e in entries.items():
        block = (e.get("lists") or {}).get(LIST_KEY) or {}
        picks[d] = [*block.get("core", []), *(block.get("buy") or [])] or None
    series: list[tuple[date, float]] = []
    left_out = 0
    nets: dict[str, dict[date, float]] = {}
    with store.slipped(slip):
        for d in sorted(picks):
            if today is not None and d == today.day:
                r = slippage.apply(today, root, slip)
                series.append((d, r.gains[result.RESULT_KEYS[0]]))
                continue
            names = picks[d]
            if not names:
                left_out += 1
                continue
            values = []
            for n in names:
                if n not in nets:
                    nets[n] = store.read_net(n, root)
                values.append(nets[n].get(d))
            if any(v is None for v in values):
                left_out += 1
                continue
            series.append((d, result.REPORT_LOTS * sum(values)))
    if not series or series[-1][0] != day:
        return None  # today not counted: no line rather than yesterday's standing as today's
    return measure(series, left_out, recorded_from, slip or None, start)
