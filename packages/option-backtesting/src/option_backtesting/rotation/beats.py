"""Beats random over a window (owner, 2026-11-05): the share of random same-shape baskets whose
cumulative gross over the window a book's cumulative gross is above, for the last 60 sessions,
6 months, 1 year and 2 years, and for the whole record.

Same draws as the registered read-out (`readout.random_day`: 3 distinct non-Buy variants with at
least `MIN_WIDE_N` Widesl, plus a random Buy variant on a day the book's picks include one; seeded
per day, `N_RUNS` runs), so a window that starts where the read-out does gives its figure. The
picks are the book's (`candles.picks_by_day`): the journal's from its first entry, and before it
the 09:16 rule re-derived from the rows before each day (without the BL-122 expiry rule, as
reconstructed history always is). Read-only; reads results at the caller's `store.slipped`.

Two things the figure does not say. A window is a few dozen independent-ish days, so a percentile
moves a lot with one bad week. And T1's tuned settings were found on the same history, so its
re-derived days are in-sample: only the recorded days (from 2026-10-19) are out of sample.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import base as base_mod
from . import candles
from .lists import MIN_WIDE_N
from .readout import N_RUNS, random_day
from .variants import is_buy, is_wide

#: name -> sessions, or calendar months (`months`)
WINDOWS = (
    ("sessions60", {"sessions": 60}),
    ("months6", {"months": 6}),
    ("year1", {"months": 12}),
    ("years2", {"months": 24}),
)
MIN_POOL = 20
#: the Adaptive books, and the fixed base (2 x Widesl OTM1 09:17 + 1 x Dir ATM 09:24), whose random
#: baskets are the same shape as a list's core: 3 distinct non-Buy variants, at least 2 Widesl
BOOKS = ("core", "t1", "base")


def today() -> date:
    """The exchange's date (the cache's day and the windows' end)."""
    from .live_board import now_ist

    return now_ist().date()


def _gross(names: list[str], root: Path) -> dict[str, dict[date, float]]:
    return {n: base_mod.read_column(candles.store.result_path(n, root), "gross") for n in names}


def daily(root: Path, book: str, start: date, end: date, runs: int = N_RUNS) -> dict:
    """Per scored day: the book's one-lot-a-strategy gross and `runs` random baskets', plus which
    days were left out and why. `book` is `core` or `t1`."""
    if book not in BOOKS:
        raise ValueError(f"book must be one of {', '.join(BOOKS)}")
    names = candles._pool(book)  # noqa: SLF001 - the one definition of a book's pool
    picks = candles.picks_by_day(root, book, start, end)
    gross = _gross(names, root)
    if book == "base":
        # the base's Dir leg is not a variant: its results sit in the base's own file
        gross[base_mod.DIR_NAME] = base_mod.read_column(base_mod._path(root), "gross")  # noqa: SLF001
    buy_set = {n for n in names if is_buy(n)}
    days: list[date] = []
    book_g: list[float] = []
    rand: list[np.ndarray] = []
    source: list[str] = []
    left_out: dict[str, str] = {}
    for day in sorted(picks):
        p = picks[day]
        members = [n for n, _lots in p.names]
        lots_of = dict(p.names)
        if any(day not in gross.get(n, {}) for n in members):
            left_out[day.isoformat()] = "a pick has no result"
            continue
        avail = [n for n in names if day in gross[n]]
        pool_names = [n for n in avail if n not in buy_set]
        if len(pool_names) < MIN_POOL:
            left_out[day.isoformat()] = f"only {len(pool_names)} strategies have a result"
            continue
        pool = np.array([gross[n][day] for n in pool_names])
        wide = np.array([is_wide(n) for n in pool_names])
        bpool = np.array([gross[n][day] for n in avail if n in buy_set])
        try:
            core, buy = random_day(day, pool, wide, bpool, runs=runs, min_wide=MIN_WIDE_N)
        except ValueError as error:
            left_out[day.isoformat()] = str(error)
            continue
        has_buy = any(n in buy_set for n in members)
        days.append(day)
        book_g.append(sum(lots_of[n] * gross[n][day] for n in members))
        rand.append(core + (buy if has_buy else 0.0))
        source.append(p.source)
    return {
        "days": days,
        "book": np.array(book_g),
        "random": np.array(rand) if rand else np.zeros((0, runs)),
        "source": source,
        "left_out": left_out,
    }


def _months_back(end: date, months: int) -> date:
    y, m = divmod(end.year * 12 + end.month - 1 - months, 12)
    first = date(y, m + 1, 1)
    # the same day of the month, clamped to the month's last day
    nxt = date(y + (m + 1) // 12, (m + 1) % 12 + 1, 1)
    return min(first.replace(day=min(end.day, (nxt - timedelta(days=1)).day)), end)


def window_slice(days: list[date], spec: dict) -> slice:
    """The days a window covers: the last N sessions, or those after `end` minus N months."""
    if not days:
        return slice(0, 0)
    if "sessions" in spec:
        return slice(max(0, len(days) - spec["sessions"]), len(days))
    cut = _months_back(days[-1], spec["months"])
    first = next((i for i, d in enumerate(days) if d > cut), len(days))
    return slice(first, len(days))


def share(book: np.ndarray, rand: np.ndarray, sl: slice) -> dict | None:
    if sl.stop - sl.start <= 0:
        return None
    total = float(book[sl].sum())
    r = rand[sl].sum(axis=0)
    return {
        "days": int(sl.stop - sl.start),
        "total": total,
        "random_p50": float(np.percentile(r, 50)),
        "random_p10": float(np.percentile(r, 10)),
        "random_p90": float(np.percentile(r, 90)),
        "beats_random_pct": float((r < total).mean() * 100),
    }


def rolling(data: dict, window: int = 60, step: int = 5) -> list[dict]:
    """The window's share at every `step`th session once `window` sessions exist."""
    out = []
    days, book, rand = data["days"], data["book"], data["random"]
    for end in range(window, len(days) + 1, step):
        s = share(book, rand, slice(end - window, end))
        if s:
            out.append({"day": days[end - 1].isoformat(), **s})
    return out


def windows(root: Path | None = None, book: str = "t1", end: date | None = None) -> dict:
    """Every window's figures for one book, the journal's days and the re-derived ones alike."""
    root = root or data_dir()
    end = end or today()
    data = daily(root, book, date(2000, 1, 1), end)
    days, bk, rd = data["days"], data["book"], data["random"]
    out: dict = {
        "book": book,
        "first_day": days[0].isoformat() if days else None,
        "last_day": days[-1].isoformat() if days else None,
        "n_days": len(days),
        "recorded_days": sum(1 for s in data["source"] if s == "recorded"),
        # the base is one fixed rule every day: nothing was recorded or re-derived
        "fixed": book == "base",
        "left_out": data["left_out"],
        "windows": {},
    }
    for name, spec in WINDOWS:
        sl = window_slice(days, spec)
        got = share(bk, rd, sl)
        if got:
            sl_src = data["source"][sl]
            got["from"] = days[sl.start].isoformat()
            got["recorded_days"] = sum(1 for s in sl_src if s == "recorded")
        out["windows"][name] = got
    got = share(bk, rd, slice(0, len(days)))
    if got:
        got["from"] = days[0].isoformat()
        got["recorded_days"] = out["recorded_days"]
    out["windows"]["all"] = got
    # the days the journal recorded before the open: the only ones no later rule could have seen
    rec = np.array([i for i, s in enumerate(data["source"]) if s == "recorded"], dtype=int)
    fwd = None
    if rec.size:
        total = float(bk[rec].sum())
        r = rd[rec].sum(axis=0)
        fwd = {
            "days": int(rec.size),
            "from": days[int(rec[0])].isoformat(),
            "recorded_days": int(rec.size),
            "total": total,
            "random_p50": float(np.percentile(r, 50)),
            "random_p10": float(np.percentile(r, 10)),
            "random_p90": float(np.percentile(r, 90)),
            "beats_random_pct": float((r < total).mean() * 100),
        }
    out["windows"]["recorded"] = fwd
    return out
