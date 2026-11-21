"""Daily candles for an Adaptive book or the fixed base (owner, 2026-11-04): the Rotation page's
candle card. Read-only; nothing is written but the portfolio replay's own path cache.

One candle a day, laid on the running total of the days before it:

* **open** = the running total before the day, **close** = open + the day's result;
* **high / low** = open + the best / worst point of the day's minute-by-minute book path (0 counts,
  so a day that only lost has its high at the open);
* the book is replayed with `portfolio.book_day`: each pick's one-lot path at the slippage the
  request reads at (`store.slipped`), times its lots, under the book stop (`stop`, per lot of the
  book: at `lots` 2 the stop is twice as wide). The day closes where the stop cut it.

Books: `t1` (the T1 track's list C), `core` (the live journal's list C) and `base` (2 × Widesl OTM1
09:17 + 1 × Dir ATM 09:24, every day it has both results). The Adaptive picks are the journal's
from its first entry and re-derived before it with `daylog.reconstruction` (the 09:16 job's own
`pick.score_history`, without the BL-122 expiry rule, as reconstructed history always is); each
day's picks are the core picks and any Buy add-on. Each day is labelled `recorded` or `rederived`.

**Beat**: the share of `DRAWS` random baskets of the same size, drawn from the book's ranked pool
(Core-298, plus the T1 track's variants for T1) without repeats, whose summed one-lot day result
was below the book's own (its day result divided by `lots`, after its stop; the random baskets
carry no stop). Seeded per book and day, so the same request gives the same share.

The random baskets are judged under the same book stop, as far as the stored day results allow: a
basket whose day ended below the stop is cut at it (its path must have crossed it); one that dipped
below and recovered keeps its close, which flatters the random baskets, never the book.

Each day also carries its **drawdown** (the running high, starting at zero, minus the close) and,
for the Adaptive books, the **live** result per lot of every account the 15:40 capture read for
that list (`live_compare`, per platform + broker: the account's own variants, live after costs and
the paper for the same variants). The response's `ladder` names the drawdown at least 25 / 10 / 5 %
of the window's days reached.

A day that cannot be replayed (no collected data, a pick with no result) is listed under
`left_out` with the reason and never counted as zero.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from . import base, portfolio, store
from .entries import read as read_entries
from .portfolio import PortfolioStopError

BOOKS = ("t1", "core", "base")
#: the owner's book stops (rupees at one lot a strategy): T1 ₹9k, Adaptive Classic ₹8k, and the
#: Rotation page's default for the fixed base, ₹8k
DEFAULT_STOP = {"t1": 9000.0, "core": 8000.0, "base": 8000.0}
WINDOW_DAYS = 730
DRAWS = 2000
LIST_KEY = "C"
MAX_LOTS = 10
#: the shares of days the drawdown ladder names
LADDER = (25, 10, 5)


class CandlesError(ValueError):
    """A request that cannot be answered as asked."""


@dataclass(frozen=True)
class DayPicks:
    names: list[tuple[str, int]]
    source: str  # recorded | rederived | fixed


def _pool(book: str) -> list[str]:
    from .variants import track_names, variant_names

    return variant_names() + (track_names("t1") if book == "t1" else [])


def picks_by_day(root: Path, book: str, start: date, end: date) -> dict[date, DayPicks]:
    """Each day's members for the book in [start, end] (see the module)."""
    if book == "base":
        # the days both legs are stored, whatever the request's slippage (the base's slippage copy
        # starts later than its results; the replay applies the slippage itself)
        with store.slipped(0.0):
            stored = base.base_days(root)
        return {
            d: DayPicks([(base.WIDE_NAME, base.N_WIDE), (base.DIR_NAME, base.N_DIR)], "fixed")
            for d in stored
            if start <= d <= end
        }
    track = "t1" if book == "t1" else None
    entries = {
        date.fromisoformat(e["day"]): e
        for e in read_entries(root, track)
        if start.isoformat() <= str(e.get("day", "")) <= end.isoformat()
    }
    out: dict[date, DayPicks] = {}
    first = min(entries) if entries else None
    if first is None or first > start:
        from . import daylog

        recon = daylog.reconstruction(root, _pool(book))
        for d in recon.days_available():
            if not start <= d <= end or (first is not None and d >= first):
                continue
            lists = recon.picks(d) or {}
            c = lists.get(LIST_KEY)
            if c:
                out[d] = DayPicks(
                    [(n, 1) for n in [*c["core"], *(c.get("buy") or [])]], "rederived"
                )
    for d, e in entries.items():
        c = (e.get("lists") or {}).get(LIST_KEY) or {}
        names = [*c.get("core", []), *(c.get("buy") or [])]
        if names:
            out[d] = DayPicks([(n, 1) for n in names], "recorded")
    return out


def _pick(member: dict) -> dict:
    """One member's line: its name, the self-explaining label the messages use, lots and result."""
    from .labels import label

    head, params = label(member["name"])
    return {
        "name": member["name"],
        "label": head,
        "params": params,
        "lots": member["lots"],
        "pnl": member["at_stop"],
    }


def beat_share(
    value: float,
    pool: list[float],
    k: int,
    seed: str,
    draws: int = DRAWS,
    stop: float | None = None,
) -> float | None:
    """The share of `draws` random `k`-strategy baskets from `pool` whose sum was below `value`.
    With `stop` (rupees, one lot a strategy) a basket that ended below it is cut at it."""
    if k <= 0 or len(pool) < k:
        return None
    rng = random.Random(seed)
    floor = -stop if stop is not None else None
    below = 0
    for _ in range(draws):
        basket = sum(rng.sample(pool, k))
        if floor is not None and basket < floor:
            basket = floor
        below += basket < value
    return below / draws


def ladder(drawdowns: list[float], shares: tuple[int, ...] = LADDER) -> list[dict]:
    """For each share p: the deepest drawdown at least p % of the days reached (rounded up, so the
    share is never overstated)."""
    if not drawdowns:
        return []
    deepest_first = sorted(drawdowns, reverse=True)
    out = []
    for p in shares:
        k = max(1, math.ceil(len(deepest_first) * p / 100))
        out.append({"share": p, "drawdown": round(deepest_first[k - 1], 2)})
    return out


def live_by_day(root: Path, book: str, start: date, end: date) -> dict[date, list[dict]]:
    """{day: [{platform, broker, live, paper, variants}]} per lot for the list's accounts, from the
    15:40 capture (`live_compare`); empty for the base and before the capture began."""
    if book == "base":
        return {}
    from . import live_compare

    out: dict[date, list[dict]] = {}
    for day in live_compare.compare_range(start, end, root).get("days", []):
        rows = [
            {k: g[k] for k in ("platform", "broker", "live", "paper", "variants")}
            for g in day.get("groups", [])
            if (g.get("book") or "") == book
        ]
        if rows:
            out[date.fromisoformat(day["day"])] = rows
    return out


def build(
    book: str,
    root: Path,
    start: date | None = None,
    end: date | None = None,
    lots: int = 1,
    stop: float | None = None,
    use_default_stop: bool = True,
) -> dict:
    """The card's response: the days' candles, their picks and beat shares, and the totals."""
    if book not in BOOKS:
        raise CandlesError(f"book must be one of {', '.join(BOOKS)}")
    if not 1 <= lots <= MAX_LOTS:
        raise CandlesError(f"lots must be 1 to {MAX_LOTS}")
    end = end or date.today()
    start = start or end - timedelta(days=WINDOW_DAYS)
    if start > end:
        raise CandlesError("from must not be after to")
    if stop is None and use_default_stop:
        stop = DEFAULT_STOP[book]
    stop = portfolio.normalise_stop(stop)
    book_stop = stop * lots if stop is not None else None
    days = picks_by_day(root, book, start, end)
    pool_names = _pool(book)
    nets = {n: store.read_net(n, root) for n in pool_names}
    try:
        live = live_by_day(root, book, start, end)
    except (OSError, ValueError, KeyError):
        live = {}  # the capture cannot be read: the candles stand without the live dots
    out_days: list[dict] = []
    left_out: list[dict] = []
    drawdowns: list[float] = []
    total = peak = 0.0
    deepest = 0.0
    for d in sorted(days):
        picked = days[d]
        members = [(n, lots * per) for n, per in picked.names]
        try:
            b = portfolio.book_day(root, d, members, book_stop, loaded={})
        except PortfolioStopError as error:
            left_out.append({"day": d.isoformat(), "reason": str(error)})
            continue
        path = b.stopped
        day_pnl = b.gross_with
        open_ = total
        high = open_ + max(0.0, max(path))
        low = open_ + min(0.0, min(path))
        total += day_pnl
        peak = max(peak, total)
        deepest = max(deepest, peak - total)
        drawdowns.append(peak - total)
        pool = [nets[n][d] for n in pool_names if d in nets[n]]
        size = sum(per for _, per in picked.names)
        beat = beat_share(day_pnl / lots, pool, size, f"{book}:{d.isoformat()}", stop=stop)
        out_days.append(
            {
                "day": d.isoformat(),
                "source": picked.source,
                "open": round(open_, 2),
                "high": round(high, 2),
                "low": round(low, 2),
                "close": round(total, 2),
                "pnl": round(day_pnl, 2),
                "stopped_at": b.stop_label,
                "picks": [_pick(m) for m in b.members],
                "beat": None if beat is None else round(beat, 4),
                "pool": len(pool),
                "drawdown": round(peak - total, 2),
                "live": live.get(d, []),
            }
        )
    return {
        "book": book,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "lots": lots,
        "stop": book_stop,
        "slippage_pct": store.reading_slip() or None,
        "draws": DRAWS,
        "days": out_days,
        "left_out": left_out,
        "ladder": ladder(drawdowns),
        "live_days": sum(1 for d in out_days if d["live"]),
        "totals": {
            "pnl": round(total, 2),
            "days": len(out_days),
            "max_drawdown": round(deepest, 2),
            "drawdown_now": round(peak - total, 2),
        },
    }
