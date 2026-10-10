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
from trading_data import lake, quality

from ..fyers.daily import data_dir
from . import journal, store
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
    """The latest weekday before `day` that both indices have collected and `data_quality` does not
    exclude: the day whose results the pick must already have. Holiday-proof (a day the exchange
    was shut simply has no file), unlike a calendar walk."""
    excluded = {u: quality.excluded_days(root, "option", u) or {} for u in ("NIFTY", "SENSEX")}
    d = day - timedelta(days=1)
    for _ in range(14):
        if d.weekday() < 5 and all(
            lake.bars_1m_path(root, "option", u, d).exists()
            and lake.bars_1m_path(root, "index", u, d).exists()
            and d not in excluded[u]
            for u in ("NIFTY", "SENSEX")
        ):
            return d
        d -= timedelta(days=1)
    raise PickError(f"no collected trading day in the 14 days before {day}")


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
    prev = previous_data_day(root, day)
    if days[-1] != prev:
        raise PickError(
            f"results end {days[-1]} but the last collected trading day is {prev}: "
            f"run `obt rotation update --day {prev}`"
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
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
    dry_run: bool = False,
) -> PickResult:
    root = root or data_dir()
    if not dry_run and day != now_fn().astimezone(IST).date():
        raise PickError(f"{day} is not today (IST): an entry can only be recorded on its own day")
    source = "given"
    if vix_open is None:
        vix_open, source = vix_open_with_source(day)
    if vix_open is None:
        raise PickError(f"the 09:15 India VIX open for {day} could not be read; nothing recorded")
    dte, dte_source = listed_dte_labels(day)
    names = variant_names()
    lists = score_lists(day, vix_open, dte, root, names)
    fields = {
        "v": 2,
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": round(vix_open, 4),
        "vix_source": source,
        "vix_band": vix_band(vix_open),
        "dte": {"NIFTY": dte["dte_n"], "SENSEX": dte["dte_s"]},
        "dte_source": dte_source,
        "lists": lists,
        "commit": code_commit(),
        "universe": universe_fingerprint(names),
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
