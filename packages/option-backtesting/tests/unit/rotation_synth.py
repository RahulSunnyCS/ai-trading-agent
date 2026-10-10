"""A synthetic rotation store for the daily log's tests and for `scripts/rotation-daylog-demo.py`.

Builds, under a root, what the nightly job and the 09:16 job leave behind: per-variant result CSVs,
`days.csv`, the lake's "collected" markers, and (through the real `pick.record`, so the entries are
genuine and hash-chained) journal entries. Nothing here is a model of the market: the numbers are
random with a stop-loss floor, shaped like the stored results (one lot, gross, `overall SL at HH:MM`
when the ₹2,500 overall stop fired).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
from trading_data import lake

from option_backtesting.rotation import pick, store
from option_backtesting.rotation.score import vix_band

IST = ZoneInfo("Asia/Kolkata")
SLOTS = ("0917", "1017", "1217", "1417")
FAMILIES = ("wide", "p80", "dir", "ditm1", "buy")
NAMES = [f"{i}_{f}_{s}" for i in "NS" for f in FAMILIES for s in SLOTS]  # 40 variants
DTE_CYCLE = ("4", "3", "2", "1", "0")
VIX_CYCLE = (12.2, 13.4, 14.1, 15.6, 16.8, 11.1, 14.7)


def weekdays(start: date, n: int, skip: Iterable[date] = ()) -> list[date]:
    out, d, skipped = [], start, set(skip)
    while len(out) < n:
        if d.weekday() < 5 and d not in skipped:
            out.append(d)
        d += timedelta(days=1)
    return out


def collect(root: Path, day: date) -> None:
    """Mark a day collected for both indices (empty files: only their existence is read)."""
    for u in ("NIFTY", "SENSEX"):
        for asset in ("option", "index"):
            p = lake.bars_1m_path(root, asset, u, day)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()


def attrs_for(day: date) -> dict:
    """A day's attributes, a function of the date alone so a store built in pieces is the same."""
    i = day.toordinal()
    v = VIX_CYCLE[i % len(VIX_CYCLE)]
    dte = DTE_CYCLE[i % len(DTE_CYCLE)]
    return {
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": v,
        "vix_band": vix_band(v),
        "dte_n": dte,
        "dte_s": str((int(dte) + 1) % 5),
    }


def result_row(rng: np.random.Generator, name: str, day: date) -> dict:
    """One variant-day: a Widesl keeps small gains and can hit the overall stop; a Dir swings more."""
    family = name.split("_")[1]
    if family == "buy":
        gross = float(rng.normal(-100, 1900))
    elif family in ("dir", "ditm1"):
        gross = float(rng.normal(150, 2200))
    else:  # Widesl, closest-premium Widesl included
        gross = float(rng.normal(350, 1500))
    stopped = ""
    if gross <= -2300:
        gross = -2500.0 + float(rng.normal(0, 60))
        stopped = f"overall SL at {int(rng.integers(10, 15)):02d}:{int(rng.integers(0, 60)):02d}"
    gross = round(gross, 2)
    return {
        "day": day.isoformat(),
        "net": gross,
        "gross": gross,
        "costs": 0.0,
        "worst_mtm": round(min(gross, 0.0) - abs(float(rng.normal(300, 250))), 2),
        "stopped_by": stopped,
        "n_trades": int(rng.integers(2, 7)),
    }


def build_store(
    root: Path, days: list[date], names: list[str] | None = None, seed: int = 11
) -> None:
    """Results, day attributes and collected markers for each day, as the nightly update leaves
    them (every variant has every day). Each day's numbers depend on (seed, date) only."""
    names = names or NAMES
    for d in days:
        rng = np.random.default_rng([seed, d.toordinal()])
        for n in names:
            store.append_result(n, result_row(rng, n, d), root)
        store.append_day(attrs_for(d), root)
        collect(root, d)


def record_entry(
    root: Path,
    day: date,
    at: tuple[int, int, int] = (9, 16, 4),
    vix_open: float | None = None,
    names: list[str] | None = None,
    vix_source: str = "fyers",
    dte_source: str = "master",
    dte: dict[str, str] | None = None,
) -> dict:
    """Write one genuine journal entry for `day` with `pick.record`, from the stored results before
    it, as if the job ran at `at` (IST). Live inputs are given, not fetched."""
    a = store.read_days(root).get(day) or attrs_for(day)
    labels = dte or {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
    vix = vix_open if vix_open is not None else float(a["vix_open"])
    saved = (
        pick.variant_names,
        pick.listed_dte_labels,
        pick.code_commit,
        pick.vix_open_with_source,
    )
    pick.variant_names = lambda: names or NAMES
    pick.listed_dte_labels = lambda d: (labels, dte_source)
    pick.code_commit = lambda: "synth01"
    pick.vix_open_with_source = lambda d: (vix, vix_source)
    try:
        stamp = datetime(day.year, day.month, day.day, *at, tzinfo=IST)
        return pick.record(
            day,
            root,
            vix_open=None,
            now_fn=lambda: stamp,
        ).entry
    finally:
        pick.variant_names, pick.listed_dte_labels, pick.code_commit, pick.vix_open_with_source = (
            saved
        )


#: The forward scenario's events, by position among the trading days from 2026-10-12 on.
FORWARD_EVENTS = (
    "on_time",
    "on_time",
    "late",
    "missing",
    "on_time",
    "angelone",
    "on_time",
    "waiting",
)
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=IST)


def forward_scenario(
    root: Path, history: int = 70, names: list[str] | None = None, seed: int = 11
) -> dict:
    """`history` weekdays of results to Fri 9 Oct 2026, then the forward days of FORWARD_EVENTS:
    two on time; one recorded late (09:41); one with no entry at all though collected; one on time
    with the VIX read from Angel One; Tue 20 Oct (Dussehra) is a holiday and is skipped; one on
    time; the last recorded on time but its results are not stored yet (the nightly job has not
    run). "Now" is NOW, the afternoon of the last of them."""
    end = date(2026, 10, 9)
    days, d = [], end
    while len(days) < history:
        if d.weekday() < 5:
            days.insert(0, d)
        d -= timedelta(days=1)
    build_store(root, days, names, seed)
    forward = weekdays(date(2026, 10, 12), len(FORWARD_EVENTS), skip=[date(2026, 10, 20)])
    entries: dict[date, dict] = {}
    for day, event in zip(forward, FORWARD_EVENTS, strict=True):
        if event == "late":
            entries[day] = record_entry(root, day, (9, 41, 12), names=names)
        elif event == "angelone":
            entries[day] = record_entry(
                root, day, (9, 16, 31), names=names, vix_source="angelone", vix_open=15.9
            )
        elif event != "missing":
            entries[day] = record_entry(root, day, names=names)
        if event != "waiting":
            build_store(root, [day], names, seed)
    return {
        "history": days,
        "forward": forward,
        "events": dict(zip(forward, FORWARD_EVENTS, strict=True)),
        "entries": entries,
        "now": NOW,
    }
