"""Nightly scoring of the BL-083 intraday triggers: forward, unseen days, no live process.

For each collected day and index the first firing of four triggers is found from the 1-minute
bars (10:30..14:00). The three live templates (Widesl, Dir, Buy) are then simulated from the next
minute on the event day and on the 20 most recent earlier days with no event of that trigger (the
placebo), and the result is appended under TRADING_DATA_ROOT/rotation/triggers/. `summary()`
reports event minus placebo per trigger and template, day-clustered. Nothing here places or
recommends an order.

    T1  spot's close crosses yesterday's P, R1 or S1 for the first time today (closes from 09:15)
        and (close - 09:15 open) / 14-session ATR has the cross's sign with magnitude >= 0.3
    T2  VIX >= +2% on its 09:15 open and its 30-minute change <= -1%
    T3  09:20-ATM straddle was up >= 5% on its 10:00 value since, is now >= 3% below that high,
        and the last-30-minute spot range / ATR is below its trailing-252-session median
    T4  5-minute RSI-14 completes a block that crosses back below 70 (from >= 70) or above 30
        (from <= 30)

Definitions are the registered ones of backlog/BL-083 (research/bl083/triggers.py). A state at
stamp j uses bars stamped <= j only and the entry is the open of j + 1. Placebo differs from the
study in one way: the 20 days BEFORE the event day (a new day has no later days).
"""

from __future__ import annotations

import csv
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import yaml

from . import store
from .variants import STRATEGIES_DIR

TRIGGERS = ("T1", "T2", "T3", "T4")
TEMPLATES = ("wide", "dir", "buy")
OPEN_MIN = 555  # 09:15
N_BARS = 375
J0, J1 = 75, 285  # stamps 10:30 .. 14:00 (minutes after 09:15)
J_1000, J_EXIT = 45, 373
PLACEBO_WINDOW = 120  # earlier sessions scanned for placebo days (T4 fires on ~60% of sessions)
HISTORY = 400  # sessions loaded: 252 (T3's median) + 120 (placebo scan) + warm-up
MIN_SESSIONS = 372  # fewer than this and an index is skipped
CATCH_UP_DAYS = 14  # calendar days an unattended run looks back for unscored collected days
CATCH_UP_MAX = 5  # at most this many days per run (newest first), so a run stays short
PLACEBO_DAYS = 20
STEP = {"NIFTY": 50, "SENSEX": 100}
EVENT_COLUMNS = [
    "day",
    "underlying",
    "trigger",
    "stamp",
    "entry",
    "detail",
    "expiry_day",
    "fwd_spot",
    "fwd_straddle",
]
SIM_COLUMNS = [
    "kind",
    "ref_day",
    "trigger",
    "underlying",
    "day",
    "template",
    "entry",
    "net",
    "worst_mtm",
    "stopped_by",
]


@dataclass
class Grid:
    days: list[str]
    O: np.ndarray  # noqa: E741,N815
    H: np.ndarray
    L: np.ndarray
    C: np.ndarray


def triggers_dir(root: Path | None = None) -> Path:
    return store.rotation_dir(root) / "triggers"


# ---- pure trigger logic (numpy only) ----


def wilder_rsi(closes: np.ndarray, n: int = 14) -> np.ndarray:
    out = np.full(len(closes), np.nan)
    if len(closes) <= n:
        return out
    d = np.diff(closes)
    up, dn = np.maximum(d, 0), np.maximum(-d, 0)
    au, ad = up[:n].mean(), dn[:n].mean()
    out[n] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
    for i in range(n, len(d)):
        au = (au * (n - 1) + up[i]) / n
        ad = (ad * (n - 1) + dn[i]) / n
        out[i + 1] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
    return out


def atr14(grid: Grid) -> np.ndarray:
    """Mean true range of the previous 14 completed sessions, per session (NaN for the first 14)."""
    hi, lo, cl = grid.H.max(1), grid.L.min(1), grid.C[:, -1]
    prev = np.r_[np.nan, cl[:-1]]
    tr = np.maximum.reduce([hi - lo, np.abs(hi - prev), np.abs(lo - prev)])
    atr = np.full(len(tr), np.nan)
    for i in range(14, len(tr)):
        atr[i] = np.nanmean(tr[i - 14 : i])
    return atr


def range30_ratio(grid: Grid, atr: np.ndarray) -> np.ndarray:
    """(last-30-minute range) / ATR at every stamp >= 29, sessions x 375."""
    r30 = np.full((len(grid.days), N_BARS), np.nan)
    for j in range(29, N_BARS):
        r30[:, j] = (grid.H[:, j - 29 : j + 1].max(1) - grid.L[:, j - 29 : j + 1].min(1)) / atr
    return r30


def first_firings(
    grid: Grid,
    vix_open: float,
    vix_close: np.ndarray,
    i: int,
    atr: np.ndarray,
    r30: np.ndarray,
    rsi5: np.ndarray,
    straddle: np.ndarray | None,
) -> dict[str, tuple[int, str]]:
    """{trigger: (stamp, detail)} of the first firing of each trigger on session i. Reads only
    sessions < i and bars stamped <= the firing stamp of session i."""
    O, H, L, C = grid.O, grid.H, grid.L, grid.C  # noqa: E741, N806
    fired: dict[str, tuple[int, str]] = {}
    piv = (H[i - 1].max() + L[i - 1].min() + C[i - 1, -1]) / 3
    levels = {"P": piv, "R1": 2 * piv - L[i - 1].min(), "S1": 2 * piv - H[i - 1].max()}
    trend = (C[i] - O[i, 0]) / atr[i]
    crossed = dict.fromkeys(levels, False)
    for j in range(1, J1 + 1):
        for k, lv in levels.items():
            up = C[i, j - 1] < lv <= C[i, j]
            dn = C[i, j - 1] > lv >= C[i, j]
            if (up or dn) and not crossed[k]:
                crossed[k] = True
                with_trend = (up and trend[j] >= 0.3) or (dn and trend[j] <= -0.3)
                if J0 <= j <= J1 and "T1" not in fired and with_trend:
                    fired["T1"] = (j, f"{k}_{'up' if up else 'down'}")
    for j in range(J0, J1 + 1):
        if vix_close[j] / vix_open - 1 >= 0.02 and vix_close[j] / vix_close[j - 30] - 1 <= -0.01:
            fired["T2"] = (j, "")
            break
    if straddle is not None and i >= 252:
        med = np.nanmedian(r30[i - 252 : i, J0 : J1 + 1], axis=0)  # stamps J0..J1
        base = straddle[J_1000]
        for j in range(J0, J1 + 1):
            hi = np.nanmax(straddle[J_1000 + 1 : j + 1])
            if (
                hi >= 1.05 * base
                and straddle[j] <= 0.97 * hi
                and not np.isnan(r30[i, j])
                and not np.isnan(med[j - J0])
                and r30[i, j] < med[j - J0]
            ):
                fired["T3"] = (j, "")
                break
    for j in range(J0, J1 + 1):
        if (j - 4) % 5:
            continue
        k = (j - 4) // 5
        a, b = rsi5[i, k - 1], rsi5[i, k]
        if (a >= 70 > b) or (a <= 30 < b):
            fired["T4"] = (j, "from_over70" if a >= 70 else "from_under30")
            break
    return fired


# ---- reading the lake ----


def _bars(con, paths: list[Path]):
    return con.execute(
        "SELECT (epoch(ts)::BIGINT + 19800) // 86400 AS d,"
        " ((epoch(ts)::BIGINT + 19800) % 86400) / 60 AS m,"
        " open, high, low, close FROM read_parquet(?) ORDER BY 1, 2",
        [[str(p) for p in paths]],
    ).fetchall()


def load_grid(
    root: Path, symbol: str, end_day: date, sessions: int = HISTORY, strict_open: bool = False
) -> Grid | None:
    """The last `sessions` index sessions (weekend special sessions included) up to and including
    end_day on the 375-minute grid. A missing minute carries its close forward; a session with no
    09:15 bar is dropped (strict_open: also one with a bar before 09:15, the study's rule)."""
    import duckdb
    from trading_data import lake

    days, d = [], end_day
    for _ in range(sessions * 2 + 40):
        if lake.bars_1m_path(
            root, "index", symbol, d
        ).exists():  # incl. weekend sessions, as the study
            days.append(d)
            if len(days) == sessions:
                break
        d -= timedelta(days=1)
    if not days or days[0] != end_day:
        return None
    days.reverse()
    con = duckdb.connect()
    try:
        rows = _bars(con, [lake.bars_1m_path(root, "index", symbol, x) for x in days])
    finally:
        con.close()
    epoch0 = {(x - date(1970, 1, 1)).days: x for x in days}
    per: dict[date, dict[int, tuple]] = {}
    for dnum, m, o, h, lo, c in rows:
        x = epoch0.get(int(dnum))
        if x is not None:
            per.setdefault(x, {})[int(m) - OPEN_MIN] = (o, h, lo, c)
    keep, O, H, L, C = [], [], [], [], []  # noqa: E741, N806
    for x in days:
        bars = per.get(x, {})
        if 0 not in bars or (strict_open and min(bars) < 0):
            continue  # strict_open: the study's rule, a session with pre-open bars is dropped
        o_, h_, l_, c_ = (np.full(N_BARS, np.nan) for _ in range(4))
        for m, (o, h, lo, c) in bars.items():
            if 0 <= m < N_BARS:
                o_[m], h_[m], l_[m], c_[m] = o, h, lo, c
        last = c_[0]
        for m in range(N_BARS):
            if np.isnan(c_[m]):
                o_[m] = h_[m] = l_[m] = c_[m] = last
            else:
                last = c_[m]
        keep.append(x.isoformat())
        O.append(o_), H.append(h_), L.append(l_), C.append(c_)
    return Grid(keep, np.array(O), np.array(H), np.array(L), np.array(C))


def straddle_series(
    root: Path, underlying: str, day: date, spot_0920: float
) -> tuple[np.ndarray, date] | None:
    """(straddle close per minute, expiry) of the 09:20-ATM call + put, nearest expiry with bars."""
    import duckdb
    from trading_data import lake

    path = lake.bars_1m_path(root, "option", underlying, day)
    if not path.exists():
        return None
    con = duckdb.connect()
    try:
        exp = con.execute(
            "SELECT min(expiry)::VARCHAR FROM read_parquet(?) WHERE expiry >= CAST(? AS DATE)",
            [str(path), day.isoformat()],
        ).fetchone()
        if not exp or not exp[0]:
            return None
        strike = round(spot_0920 / STEP[underlying]) * STEP[underlying]
        rows = con.execute(
            "SELECT ((epoch(ts)::BIGINT + 19800) % 86400) / 60 - ? AS m, option_type, close"
            " FROM read_parquet(?) WHERE expiry = CAST(? AS DATE) AND strike = ?",
            [OPEN_MIN, str(path), exp[0], float(strike)],
        ).fetchall()
    finally:
        con.close()
    px: dict[str, np.ndarray] = {}
    for side in ("C", "P"):
        a = np.full(N_BARS, np.nan)
        for m, t, c in rows:
            if str(t).upper()[:1] == side and 0 <= int(m) < N_BARS:
                a[int(m)] = c
        if np.isnan(a).all():
            return None
        last = np.nan
        for m in range(N_BARS):
            last = a[m] if not np.isnan(a[m]) else last
            a[m] = last
        px[side] = a
    return px["C"] + px["P"], date.fromisoformat(exp[0])


# ---- simulation ----


def _hhmm_plus(hhmm: str, minutes: int) -> str:
    m = int(hhmm[:2]) * 60 + int(hhmm[3:]) + minutes
    return f"{m // 60:02d}:{m % 60:02d}"


def make_strategy(underlying: str, template: str, entry: str):
    """The live template (strategies/rotation/<N|S>_<template>_1202.yaml) entered at `entry`; Buy's
    range window moves with it (entry + 10 minutes)."""
    from ..legwise.schema import LegwiseStrategy

    path = STRATEGIES_DIR / f"{underlying[0]}_{template}_1202.yaml"
    d = yaml.safe_load(path.read_text())["strategy"]
    d["entry_time"] = entry
    for leg in d["legs"]:
        if "range_breakout" in leg:
            leg["range_breakout"]["until"] = _hhmm_plus(entry, 10)
    return LegwiseStrategy.model_validate(d)


def simulate(
    root: Path,
    underlying: str,
    day: date,
    entries: dict[str, str],
    loader: Callable[[str, date], object] | None = None,
) -> dict:
    """{(template, entry): (net, worst_mtm, stopped_by)} for the wanted (template -> entry) pairs on
    one day. `loader(underlying, day)` returns the day's data or None (default: load_day)."""
    from ..data.reference.loader import MissingReferenceData, default_reference_data
    from ..legwise.engine import simulate_day
    from ..legwise.market import load_day
    from .lists import SIZING_DATE

    def default_loader(u: str, d: date):
        try:
            return load_day(root, u, d)
        except FileNotFoundError:
            return None

    data = (loader or default_loader)(underlying, day)
    if data is None:
        return {}
    out = {}
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    for template, entry in entries.items():
        try:
            r = simulate_day(make_strategy(underlying, template, entry), data, ref, sizing)
        except MissingReferenceData:
            continue
        out[(template, entry)] = (
            round(r.gross - r.costs, 2),
            round(r.worst_mtm, 2),
            r.stopped_by or "",
        )
    return out


# ---- store ----


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def read_events(root: Path | None = None) -> list[dict]:
    return _read(triggers_dir(root) / "events.csv")


def read_sims(root: Path | None = None) -> list[dict]:
    return _read(triggers_dir(root) / "sims.csv")


EVENT_KEY = ("underlying", "day", "trigger")
SIM_KEY = ("kind", "ref_day", "trigger", "underlying", "day", "template", "entry")
SCORED_COLUMNS = ["underlying", "day"]


def _append_unique(
    path: Path, columns: list[str], key: tuple[str, ...], rows: list[dict], root: Path | None
) -> int:
    """Append the rows whose key is not stored yet; the check and the write are one locked step, so
    two runs cannot both add a row. Returns how many were written."""
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with store._write_lock(root):  # noqa: SLF001 - the one lock for every rotation write
        have = {tuple(r[c] for c in key) for r in _read(path)}
        fresh = []
        for r in rows:
            k = tuple(str(r.get(c, "")) for c in key)
            if k not in have:
                have.add(k)
                fresh.append(r)
        if not fresh:
            return 0
        new = not path.exists()
        with path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(columns)
            for r in fresh:
                w.writerow([r.get(c, "") for c in columns])
    return len(fresh)


def read_scored(root: Path | None = None) -> set[tuple[str, str]]:
    """{(index, day)} already scored: a day that fired nothing is recorded too."""
    return {(r["underlying"], r["day"]) for r in _read(triggers_dir(root) / "scored_days.csv")}


@dataclass
class Prepared:
    atr: np.ndarray
    r30: np.ndarray
    rsi5: np.ndarray
    vix_ix: dict[str, int]


def prepare(grid: Grid, vix: Grid) -> Prepared:
    atr = atr14(grid)
    c5 = grid.C[:, 4::5]
    rsi5 = wilder_rsi(c5.reshape(-1)).reshape(c5.shape)
    return Prepared(atr, range30_ratio(grid, atr), rsi5, {d: k for k, d in enumerate(vix.days)})


def session_firings(
    root: Path, underlying: str, grid: Grid, vix: Grid, prep: Prepared, k: int
) -> dict[str, tuple[int, str]]:
    """The triggers' first firings on session k of `grid` (needs 252 sessions before it for T3;
    fewer gives T1, T2, T4 only). {} when the VIX has no bars that session."""
    vk = prep.vix_ix.get(grid.days[k])
    if vk is None or k < 14:
        return {}
    d = date.fromisoformat(grid.days[k])
    st = None
    if k >= 252 and d >= date(2022, 1, 3):
        try:
            st = straddle_series(root, underlying, d, grid.C[k, 5])
        except Exception:  # noqa: BLE001 - a day without option bars simply has no T3
            st = None
    return first_firings(
        grid,
        vix.O[vk, 0],
        vix.C[vk],
        k,
        prep.atr,
        prep.r30,
        prep.rsi5,
        None if st is None else st[0],
    )


# ---- the nightly step ----


def _usable_days(root: Path, underlying: str, grid: Grid) -> set[str]:
    """Sessions that can serve as placebo days: option bars exist and data_quality does not exclude
    them (the study's backtest_days)."""
    from trading_data import lake

    from .attrs import excluded_map

    excluded = excluded_map(root).get(underlying, {})
    return {
        d
        for d in grid.days
        if lake.bars_1m_path(root, "option", underlying, date.fromisoformat(d)).exists()
        and date.fromisoformat(d) not in excluded
    }


def score_day(day: date, root: Path | None = None, log: Callable[[str], None] = print) -> dict:
    """Find the day's trigger events for both indices and simulate event and placebo entries.
    Idempotent and safe to run twice at once: a stored row is never rewritten or duplicated, and an
    index whose day was scored is recorded in scored_days.csv. Returns counts and skip reasons."""
    from functools import lru_cache

    from ..fyers.daily import data_dir
    from .attrs import UNDERLYINGS

    root = root or data_dir()
    out: dict = {"events": 0, "sims": 0, "skipped": []}
    scored = read_scored(root)
    vix = load_grid(root, "INDIAVIX", day)

    @lru_cache(maxsize=64)
    def day_data(und: str, d: date):
        from ..legwise.market import load_day

        try:
            return load_day(root, und, d)
        except FileNotFoundError:
            return None

    for und in UNDERLYINGS:
        if (und, day.isoformat()) in scored:
            continue
        grid = load_grid(root, und, day)
        if (
            grid is None
            or vix is None
            or grid.days[-1] != day.isoformat()
            or vix.days[-1] != day.isoformat()
        ):
            out["skipped"].append(f"{und}: no index/VIX bars for {day}")
            continue
        if len(grid.days) < MIN_SESSIONS:
            out["skipped"].append(f"{und}: only {len(grid.days)} sessions of history")
            continue
        prep = prepare(grid, vix)
        i = len(grid.days) - 1
        today = session_firings(root, und, grid, vix, prep, i)
        st_today = None
        try:
            st_today = straddle_series(root, und, day, grid.C[i, 5])
        except Exception:  # noqa: BLE001
            st_today = None
        # placebo candidates: the previous PLACEBO_WINDOW sessions that have option bars, are not
        # excluded by data_quality, and where T3 could be evaluated; their own firings decide
        usable = _usable_days(root, und, grid)
        window = [k for k in range(max(i - PLACEBO_WINDOW, 252), i) if grid.days[k] in usable]
        recent = {k: session_firings(root, und, grid, vix, prep, k) for k in window}
        new_events, new_sims = [], []
        for trig, (j, detail) in today.items():
            entry = f"{(OPEN_MIN + j + 1) // 60:02d}:{(OPEN_MIN + j + 1) % 60:02d}"
            st = st_today[0] if st_today else None
            new_events.append(
                dict(
                    day=day.isoformat(),
                    underlying=und,
                    trigger=trig,
                    stamp=j,
                    entry=entry,
                    detail=detail,
                    expiry_day=bool(st_today and st_today[1] == day),
                    fwd_spot=round(float(grid.C[i, J_EXIT] / grid.O[i, j + 1] - 1), 6),
                    fwd_straddle=""
                    if st is None or not st[j + 1] > 0
                    else round(float(st[J_EXIT] / st[j + 1] - 1), 6),
                )
            )
            placebo = [grid.days[k] for k in reversed(window) if trig not in recent[k]][
                :PLACEBO_DAYS
            ]
            for kind, sim_day in [("event", day.isoformat()), *[("placebo", p) for p in placebo]]:
                want = dict.fromkeys(TEMPLATES, entry)
                res = simulate(root, und, date.fromisoformat(sim_day), want, loader=day_data)
                for (t, e), (net, worst, stopped) in res.items():
                    new_sims.append(
                        dict(
                            kind=kind,
                            ref_day=day.isoformat(),
                            trigger=trig,
                            underlying=und,
                            day=sim_day,
                            template=t,
                            entry=e,
                            net=net,
                            worst_mtm=worst,
                            stopped_by=stopped,
                        )
                    )
        n_ev = _append_unique(
            triggers_dir(root) / "events.csv", EVENT_COLUMNS, EVENT_KEY, new_events, root
        )
        n_sim = _append_unique(
            triggers_dir(root) / "sims.csv", SIM_COLUMNS, SIM_KEY, new_sims, root
        )
        _append_unique(
            triggers_dir(root) / "scored_days.csv",
            SCORED_COLUMNS,
            tuple(SCORED_COLUMNS),
            [dict(underlying=und, day=day.isoformat())],
            root,
        )
        out["events"] += n_ev
        out["sims"] += n_sim
        log(
            f"{day} {und}: events {sorted(today)}, {n_ev} new, {n_sim} simulations, "
            f"{len(placebo) if today else 0} placebo days"
        )
    return out


def score_pending(
    today: date, root: Path | None = None, log: Callable[[str], None] = print
) -> list[dict]:
    """Score `today` and any collected day of the last CATCH_UP_DAYS calendar days that is not
    scored for both indices (newest first, at most CATCH_UP_MAX), so a failed or skipped night is
    retried by the next run instead of being lost. Skip reasons are logged."""
    from ..fyers.daily import data_dir
    from .attrs import UNDERLYINGS, excluded_map, is_collected

    root = root or data_dir()
    scored = read_scored(root)
    excluded = excluded_map(root)
    days = []
    d = today
    for _ in range(CATCH_UP_DAYS + 1):
        done = all((u, d.isoformat()) in scored for u in UNDERLYINGS)
        if not done and (d == today or is_collected(root, d, excluded)):
            days.append(d)
        d -= timedelta(days=1)
    results = []
    for d in days[:CATCH_UP_MAX]:
        r = score_day(d, root, log=log)
        for reason in r["skipped"]:
            log(f"{d} skipped: {reason}")
        results.append(r)
    return results


# ---- reporting ----


def summary(
    root: Path | None = None, since: str | None = None, until: str | None = None
) -> list[dict]:
    """Event minus placebo per trigger x template: events, days, mean event / placebo / difference
    and the day-clustered t (same-day events of the two indices are one observation).
    `since` / `until` (ISO days, inclusive) keep only the events of those days and their
    simulations: the shadow scoreboard reads only the forward window with it."""
    events = read_events(root)
    sims = read_sims(root)
    if since or until:

        def inside(day: str) -> bool:
            return (not since or day >= since) and (not until or day <= until)

        events = [e for e in events if inside(e["day"])]
        sims = [r for r in sims if inside(r["ref_day"])]
    ev: dict[tuple, float] = {}
    pl: dict[tuple, list[float]] = {}
    for r in sims:
        key = (r["underlying"], r["ref_day"], r["trigger"], r["template"])
        if not r["net"]:
            continue
        if r["kind"] == "event":
            ev[key] = float(r["net"])
        else:
            pl.setdefault(key, []).append(float(r["net"]))
    rows = []
    for trig in TRIGGERS:
        for tpl in TEMPLATES:
            diffs: dict[str, list[float]] = {}
            evs, pls = [], []
            for e in events:
                if e["trigger"] != trig:
                    continue
                key = (e["underlying"], e["day"], trig, tpl)
                if key in ev and len(pl.get(key, [])) >= 10:
                    p = float(np.mean(pl[key]))
                    evs.append(ev[key])
                    pls.append(p)
                    diffs.setdefault(e["day"], []).append(ev[key] - p)
            if not evs:
                continue
            dm = np.array([np.mean(v) for v in diffs.values()])
            t = (
                float(dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm))))
                if len(dm) > 4 and dm.std(ddof=1) > 0
                else None
            )
            rows.append(
                dict(
                    trigger=trig,
                    template=tpl,
                    events=len(evs),
                    days=len(dm),
                    event=float(np.mean(evs)),
                    placebo=float(np.mean(pls)),
                    diff=float(np.mean(evs) - np.mean(pls)),
                    t=t,
                )
            )
    return rows
