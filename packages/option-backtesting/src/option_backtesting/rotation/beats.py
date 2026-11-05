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

import calendar
from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import base as base_mod
from . import candles
from .lists import MIN_WIDE_N
from .readout import N_RUNS, _grosses, block_bootstrap_mean, random_day
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


def _late_days(root: Path, book: str) -> set[date]:
    """The journal's days recorded after the first entry of the day (`before_first_entry` false):
    the registered read-out never scores them, so neither does this."""
    if book == "base":
        return set()
    path = candles.store.journal_path(root, "t1" if book == "t1" else None)
    return {
        date.fromisoformat(e["day"])
        for e in candles.journal.read(path)
        if not e.get("before_first_entry", False)
    }


def daily(root: Path, book: str, start: date, end: date, runs: int = N_RUNS) -> dict:
    """Per scored day: the book's one-lot-a-strategy gross and `runs` random baskets', plus which
    days were left out and why. `book` is `core` or `t1`."""
    if book not in BOOKS:
        raise ValueError(f"book must be one of {', '.join(BOOKS)}")
    names = candles._pool(book)  # noqa: SLF001 - the one definition of a book's pool
    picks = candles.picks_by_day(root, book, start, end)
    late = _late_days(root, book)
    gross = _grosses(names, root)
    if book == "base":
        # the base's Dir leg is not a variant: its results sit in the base's own file
        gross[base_mod.DIR_NAME] = base_mod.read_column(base_mod._path(root), "gross")  # noqa: SLF001
    buy_set = {n for n in names if is_buy(n)}
    days: list[date] = []
    book_g: list[float] = []
    rand: list[np.ndarray] = []
    source: list[str] = []
    lots: list[int] = []
    left_out: dict[str, str] = {}
    for day in sorted(picks):
        p = picks[day]
        if day in late:  # as the registered read-out: never a late entry
            left_out[day.isoformat()] = "recorded after the 09:16 entry"
            continue
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
        lots.append(sum(lots_of.values()))
    return {
        "days": days,
        "book": np.array(book_g),
        "random": np.array(rand) if rand else np.zeros((0, runs)),
        "source": source,
        "lots": np.array(lots, dtype=float),
        "left_out": left_out,
    }


def _months_back(end: date, months: int) -> date:
    """`end` minus `months` calendar months, the day of the month clamped to the month's end."""
    y, m = divmod(end.year * 12 + end.month - 1 - months, 12)
    return end.replace(year=y, month=m + 1, day=min(end.day, calendar.monthrange(y, m + 1)[1]))


def window_slice(days: list[date], spec: dict) -> slice:
    """The days a window covers: the last N sessions, or those after `end` minus N months."""
    if not days:
        return slice(0, 0)
    if "sessions" in spec:
        return slice(max(0, len(days) - spec["sessions"]), len(days))
    cut = _months_back(days[-1], spec["months"])
    first = next((i for i, d in enumerate(days) if d > cut), len(days))
    return slice(first, len(days))


def share(book: np.ndarray, rand: np.ndarray, sl: slice | np.ndarray) -> dict | None:
    """The window's figures; `sl` is a slice or an array of day indexes."""
    n = len(range(*sl.indices(len(book)))) if isinstance(sl, slice) else len(sl)
    if n <= 0:
        return None
    total = float(book[sl].sum())
    r = rand[sl].sum(axis=0)
    return {
        "days": n,
        "total": total,
        "random_p50": float(np.percentile(r, 50)),
        "random_p10": float(np.percentile(r, 10)),
        "random_p90": float(np.percentile(r, 90)),
        "beats_random_pct": float((r < total).mean() * 100),
    }


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
    fwd = share(bk, rd, rec)
    if fwd:
        fwd["from"] = days[int(rec[0])].isoformat()
        fwd["recorded_days"] = int(rec.size)
    out["windows"]["recorded"] = fwd
    return out


#: the drift alarm (owner, 2026-11-05): a book's 60-session gap to the base, in rupees per lot-day,
#: below this on two consecutive sessions opens a review
ALARM_WINDOW = 60
ALARM_BELOW = -500.0


def _edge_sigma(book: np.ndarray, rand: np.ndarray, sl: slice) -> float | None:
    """The window's book total minus the random baskets' mean, in their standard deviations."""
    tot = rand[sl].sum(axis=0)
    sd = float(tot.std())
    return float((book[sl].sum() - tot.mean()) / sd) if sd > 0 else None


def compare(root: Path | None = None, end: date | None = None) -> dict:
    """Both Adaptive books against the fixed base on the days all three have, per window: the
    mean gap in rupees per lot-day with a 90% block-bootstrap range (the read-out's), the share of
    days the book was ahead, and each book's edge over random in standard deviations (the
    ceiling-free counterpart of beats random); plus the drift alarm on the 60-session gap."""
    root = root or data_dir()
    end = end or today()
    data = {b: daily(root, b, date(2000, 1, 1), end) for b in BOOKS}
    common = sorted(set.intersection(*[set(d["days"]) for d in data.values()]))
    keep = set(common)
    cols: dict[str, dict] = {}
    for b, d in data.items():
        ix = [i for i, x in enumerate(d["days"]) if x in keep]
        cols[b] = {
            "book": d["book"][ix],
            "rand": d["random"][ix],
            "per_lot": d["book"][ix] / d["lots"][ix],
            "source": [d["source"][i] for i in ix],
        }
    out: dict = {
        "n_days": len(common),
        "first_day": common[0].isoformat() if common else None,
        "last_day": common[-1].isoformat() if common else None,
        "windows": {},
        "alarm": {"window": ALARM_WINDOW, "below": ALARM_BELOW, "books": {}},
    }
    if not common:
        return out
    for name, spec in (*WINDOWS, ("all", {"sessions": len(common)})):
        sl = window_slice(common, spec)
        row: dict = {"days": sl.stop - sl.start, "from": common[sl.start].isoformat(), "books": {}}
        for b in BOOKS:
            c = cols[b]
            got: dict = {
                "edge_sigma": _edge_sigma(c["book"], c["rand"], sl),
                "recorded_days": sum(1 for s in c["source"][sl] if s == "recorded"),
            }
            if b != "base":
                diff = (c["per_lot"] - cols["base"]["per_lot"])[sl]
                mean, lower, upper = block_bootstrap_mean(diff)
                got.update(
                    gap_mean=mean,
                    gap_lower=lower,
                    gap_upper=upper,
                    better_days_pct=float((diff > 0).mean() * 100),
                )
            row["books"][b] = got
        out["windows"][name] = row
    for b in ("core", "t1"):
        gap = cols[b]["per_lot"] - cols["base"]["per_lot"]
        if len(gap) < ALARM_WINDOW + 1:
            continue
        ends = range(ALARM_WINDOW, len(gap) + 1)
        roll = {e: float(gap[e - ALARM_WINDOW : e].mean()) for e in ends}
        last, before = roll[len(gap)], roll[len(gap) - 1]
        review = [
            e
            for e in ends
            if e > ALARM_WINDOW and roll[e] < ALARM_BELOW and roll[e - 1] < ALARM_BELOW
        ]
        state = ("review" if before < ALARM_BELOW else "watch") if last < ALARM_BELOW else "quiet"
        out["alarm"]["books"][b] = {
            "gap": last,
            "state": state,
            "last_review_day": common[review[-1] - 1].isoformat() if review else None,
        }
    return out
