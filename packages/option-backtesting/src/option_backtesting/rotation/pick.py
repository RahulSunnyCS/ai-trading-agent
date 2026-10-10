"""The 09:16 entry: score every list from the results through the previous trading day plus today's
weekday, VIX band and days to expiry, and write one hash-chained entry before the first entry
time."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from ..data.reference.loader import default_reference_data
from ..fyers.daily import data_dir
from . import journal, store
from .lists import LISTS, LOTS_PER, WARMUP
from .live import calendar_dte_labels, vix_open_live
from .score import composite, dte_matrix, family_index, select, vix_band
from .variants import variant_names

IST = ZoneInfo("Asia/Kolkata")
FIRST_ENTRY = time(9, 17)


class PickError(RuntimeError):
    """The entry cannot be recorded; nothing was written."""


@dataclass
class PickResult:
    entry: dict
    text: str


def previous_trading_day(day: date) -> date:
    ref = default_reference_data()
    d = day - timedelta(days=1)
    while d.weekday() >= 5 or ref.is_holiday(d):
        d -= timedelta(days=1)
    return d


def code_commit() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def score_lists(
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    root: Path | None = None,
    names: list[str] | None = None,
) -> dict:
    """{list: {core, buy, overridden, composite}} for `day`, from the stored results before it."""
    root = root or data_dir()
    names = names or variant_names()
    if not names:
        raise PickError("no variant strategy files found")
    m = store.load_matrix(names, root, through=day - timedelta(days=1))
    attrs = store.read_days(root)
    days = [d for d in m.days if d in attrs]
    if len(days) < WARMUP:
        raise PickError(f"only {len(days)} days of results (need {WARMUP})")
    prev = previous_trading_day(day)
    if days[-1] != prev:
        raise PickError(
            f"results end {days[-1]} but the previous trading day is {prev}: "
            "run `obt rotation update`"
        )
    keep = [i for i, d in enumerate(m.days) if d in attrs]
    cols = list(m.names)
    weekday = np.array([attrs[d]["weekday"] for d in days] + [day.strftime("%a")])
    band = np.array([attrs[d]["vix_band"] for d in days] + [vix_band(vix_open)])
    dn = np.array([attrs[d]["dte_n"] for d in days] + [dte["dte_n"]])
    ds = np.array([attrs[d]["dte_s"] for d in days] + [dte["dte_s"]])
    Pv = np.vstack([m.values[keep], np.zeros((1, len(cols)))])
    dmat = dte_matrix(dn, ds, cols)
    fam = family_index(cols)
    out = {}
    for key, lst in LISTS.items():
        comp = composite(Pv, weekday, band, dmat, cols, lst, fam)
        picks = select(comp, cols)
        out[key] = {
            "core": picks.core,
            "buy": picks.buy,
            "overridden": picks.overridden,
            "composite": {k: round(v, 4) for k, v in picks.composite.items()},
        }
    return out


def record(
    day: date,
    root: Path | None = None,
    vix_open: float | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
) -> PickResult:
    root = root or data_dir()
    now = now or datetime.now(IST)
    if vix_open is None:
        vix_open = vix_open_live(day)
    if vix_open is None:
        raise PickError(f"the 09:15 India VIX open for {day} could not be read; nothing recorded")
    dte = calendar_dte_labels(day)
    lists = score_lists(day, vix_open, dte, root)
    fields = {
        "v": 1,
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": round(vix_open, 4),
        "vix_band": vix_band(vix_open),
        "dte": {"NIFTY": dte["dte_n"], "SENSEX": dte["dte_s"]},
        "lists": lists,
        "commit": code_commit(),
        "recorded_at": now.isoformat(timespec="seconds"),
        "before_first_entry": now.astimezone(IST).time() < FIRST_ENTRY,
        "lots_per_strategy": LOTS_PER,
    }
    path = store.journal_path(root)
    if dry_run:
        entry = {**fields, "prev": journal.head(path), "hash": "(dry run)"}
    else:
        entry = journal.append(path, fields)
    return PickResult(entry, render(entry))


def render(entry: dict) -> str:
    lines = [
        f"Rotation picks {entry['day']} ({entry['weekday']}): "
        f"VIX {entry['vix_open']} ({entry['vix_band']}), "
        f"DTE NIFTY {entry['dte']['NIFTY']} / SENSEX {entry['dte']['SENSEX']}"
    ]
    for key, p in entry["lists"].items():
        picked = ", ".join(p["core"]) + (f" + Buy {', '.join(p['buy'])}" if p["buy"] else "")
        lines.append(f"{key}: {picked}")
    lines.append(f"chain {entry['hash'][:12]}  recorded {entry['recorded_at'][11:19]} IST")
    return "\n".join(lines)
