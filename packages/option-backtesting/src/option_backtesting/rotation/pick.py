"""The 09:16 entry: score every list from the results through the previous trading day plus today's
weekday, VIX band and days to expiry, and write one hash-chained entry before the first entry
time."""

from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from ..fyers.daily import data_dir
from . import journal, store
from .attrs import last_collected_before
from .lists import LISTS, LOTS_PER, WARMUP
from .live import listed_dte_labels, vix_open_with_source
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


def previous_data_day(root: Path, day: date) -> date:
    """The latest collected, non-excluded weekday before `day`: the day whose results the pick must
    already have."""
    prev = last_collected_before(root, day)
    if prev is None:
        raise PickError(f"no collected trading day in the 14 days before {day}")
    return prev


def code_commit() -> str:
    """Short HEAD, with `+dirty` when the code this entry ran has uncommitted changes."""
    repo = Path(__file__).resolve().parents[3]
    try:
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            [
                "git",
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--",
                "src",
                "strategies/rotation",
            ],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
        ).stdout.strip()
        return head + ("+dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def universe_fingerprint(names: list[str]) -> dict:
    return {
        "variants": len(names),
        "sha": hashlib.sha256("\n".join(sorted(names)).encode()).hexdigest()[:12],
    }


@dataclass
class History:
    """The stored results and day attributes a pick ranks on, as arrays, plus a digest of them."""

    days: list[date]
    cols: list[str]
    values: np.ndarray  # days x variants, net P&L (history only: no row for the target day)
    weekday: list[str]
    band: list[str]
    dte_n: list[str]
    dte_s: list[str]
    digest: str


def load_history(day: date, root: Path, names: list[str]) -> History:
    """Everything the pick reads from disk. Raises PickError when the history is short or does not
    reach the last collected trading day."""
    if not names:
        raise PickError("no variant strategy files found")
    m = store.load_matrix(names, root, through=day - timedelta(days=1))
    attrs = store.read_days(root)
    keep = [i for i, d in enumerate(m.days) if d in attrs]
    days = [m.days[i] for i in keep]
    if len(days) < WARMUP:
        raise PickError(f"only {len(days)} days of results (need {WARMUP})")
    prev = previous_data_day(root, day)
    if days[-1] != prev:
        raise PickError(
            f"results end {days[-1]} but the last collected trading day is {prev}: "
            f"run `obt rotation update --day {prev}`"
        )
    values = m.values[keep]
    h = hashlib.sha256()
    for i, d in enumerate(days):
        a = attrs[d]
        h.update(
            f"{d}|{a['weekday']}|{a['vix_band']}|{a['dte_n']}|{a['dte_s']}|".encode()
            + ",".join(f"{v:.2f}" for v in values[i]).encode()
            + b"\n"
        )
    return History(
        days,
        list(m.names),
        values,
        [attrs[d]["weekday"] for d in days],
        [attrs[d]["vix_band"] for d in days],
        [attrs[d]["dte_n"] for d in days],
        [attrs[d]["dte_s"] for d in days],
        h.hexdigest(),
    )


def score_history(hist: History, day: date, vix_open: float | None, dte: dict[str, str]) -> dict:
    """{list: {core, buy, overridden, composite}} for `day`."""
    weekday = np.array([*hist.weekday, day.strftime("%a")])
    band = np.array([*hist.band, vix_band(vix_open)])
    dn = np.array([*hist.dte_n, dte["dte_n"]])
    ds = np.array([*hist.dte_s, dte["dte_s"]])
    cols = hist.cols
    Pv = np.vstack([hist.values, np.zeros((1, len(cols)))])
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


def score_lists(
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    root: Path | None = None,
    names: list[str] | None = None,
) -> dict:
    """{list: {core, buy, overridden, composite}} for `day`, from the stored results before it."""
    root = root or data_dir()
    hist = load_history(day, root, names or variant_names())
    return score_history(hist, day, vix_open, dte)


def record(
    day: date,
    root: Path | None = None,
    vix_open: float | None = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
    dry_run: bool = False,
) -> PickResult:
    root = root or data_dir()
    if not dry_run and day != now_fn().astimezone(IST).date():
        raise PickError(f"{day} is not today (IST): an entry can only be recorded on its own day")
    # everything slow and VIX-independent first: the 09:15 bar is served a few seconds after the
    # job starts, and only the band depends on it
    names = variant_names()
    dte, dte_source = listed_dte_labels(day)
    commit = code_commit()
    hist = load_history(day, root, names)
    source = "given"
    if vix_open is None:
        vix_open, source = vix_open_with_source(day)
    if vix_open is None:
        raise PickError(f"the 09:15 India VIX open for {day} could not be read; nothing recorded")
    lists = score_history(hist, day, vix_open, dte)
    fields = {
        "v": 3,
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": round(vix_open, 4),
        "vix_source": source,
        "vix_band": vix_band(vix_open),
        "dte": {"NIFTY": dte["dte_n"], "SENSEX": dte["dte_s"]},
        "dte_source": dte_source,
        "lists": lists,
        "commit": commit,
        "universe": universe_fingerprint(names),
        "inputs_sha": hist.digest,
        "inputs_days": len(hist.days),
        "lots_per_strategy": LOTS_PER,
    }
    path = store.journal_path(root)
    stamp = now_fn().astimezone(IST)  # taken right before the write, so the flag describes it
    fields["recorded_at"] = stamp.isoformat(timespec="seconds")
    fields["before_first_entry"] = stamp.time() < FIRST_ENTRY
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
    if not entry["before_first_entry"]:
        lines.append("LATE: recorded after 09:17 IST, this entry is NOT forward")
    return "\n".join(lines)
