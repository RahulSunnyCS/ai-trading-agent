"""The owner's Options Lab favourites: the lists and strategies starred on the Strategies and
baskets page, which become the default selection wherever the dashboard has a picker (Correlation
first).

One small file, `TRADING_DATA_ROOT/options_lab/favourites.json`, so a star set on the laptop is the
same on the hosted dashboard (the browser keeps nothing):

    {"lists": ["A", "B", "C"], "strategies": ["nifty_buy_range_breakout"], "updated_at": "..."}

A missing or unreadable file reads as the default (Steady, Calendar and Adaptive starred, no
strategies), so the page always has something to show. Writes replace the whole file atomically
under an exclusive lock; nothing here is read by a ranking, a journal entry or a result.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .fyers.daily import data_dir

IST = ZoneInfo("Asia/Kolkata")

#: The rotation lists (Steady, Calendar, Adaptive), the old live rotation (REF) and the owner's
#: fixed base: everything the Strategies and baskets page can star besides a strategy.
LIST_KEYS = ("A", "B", "C", "REF", "base")
DEFAULT_LISTS = ("A", "B", "C")
#: A strategy file name or a rotation variant name (`nifty_widesl_917_otm1`, `N_wide_0917`).
STRATEGY_RE = re.compile(r"^[A-Za-z0-9_]{1,80}$")
MAX_STRATEGIES = 100


class FavouritesError(ValueError):
    """The favourites are refused; nothing was written."""


@dataclass(frozen=True)
class Favourites:
    lists: tuple[str, ...]
    strategies: tuple[str, ...]
    updated_at: str | None  # None until the owner has saved once
    warning: str | None = None  # why the stored file was not used, when it was not

    def as_dict(self) -> dict:
        return {
            "lists": list(self.lists),
            "strategies": list(self.strategies),
            "updated_at": self.updated_at,
            "is_default": self.updated_at is None,
            "warning": self.warning,
        }


def favourites_path(root: Path | None = None) -> Path:
    return (root or data_dir()) / "options_lab" / "favourites.json"


def _default(warning: str | None = None) -> Favourites:
    return Favourites(DEFAULT_LISTS, (), None, warning)


def clean(lists: object, strategies: object) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The validated, de-duplicated (first occurrence wins) lists and strategies, or
    FavouritesError. List keys keep the canonical order A, B, C, REF, base."""
    if not isinstance(lists, list | tuple) or not isinstance(strategies, list | tuple):
        raise FavouritesError("lists and strategies must both be lists")
    bad = [k for k in lists if k not in LIST_KEYS]
    if bad:
        raise FavouritesError(f"unknown list {bad[0]!r}; use one of {', '.join(LIST_KEYS)}")
    wanted = set(lists)
    kept_lists = tuple(k for k in LIST_KEYS if k in wanted)

    seen: dict[str, None] = {}
    for name in strategies:
        if not isinstance(name, str) or not STRATEGY_RE.match(name):
            raise FavouritesError(f"{name!r} is not a strategy name (letters, digits, underscore)")
        seen.setdefault(name, None)
    if len(seen) > MAX_STRATEGIES:
        raise FavouritesError(f"at most {MAX_STRATEGIES} favourite strategies")
    return kept_lists, tuple(seen)


def read(root: Path | None = None) -> Favourites:
    """The stored favourites, or the default when the file is missing or cannot be used (the
    reason is in `warning`; a later write replaces the bad file)."""
    path = favourites_path(root)
    if not path.exists():
        return _default()
    try:
        data = json.loads(path.read_text())
        lists, strategies = clean(data.get("lists"), data.get("strategies"))
        updated = data.get("updated_at")
        if updated is not None and not isinstance(updated, str):
            raise FavouritesError("updated_at must be text")
    except (OSError, json.JSONDecodeError, AttributeError, FavouritesError) as error:
        return _default(f"the saved favourites could not be read ({error}); showing the defaults")
    return Favourites(lists, strategies, updated)


@contextmanager
def _write_lock(root: Path | None) -> Iterator[None]:
    directory = favourites_path(root).parent
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / ".favourites.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def write(lists: object, strategies: object, root: Path | None = None) -> Favourites:
    """Replace the favourites. Validated first; the file is written to a temp name and renamed
    into place, so a reader never sees a half-written file."""
    kept_lists, kept_strategies = clean(lists, strategies)
    updated = datetime.now(IST).isoformat(timespec="seconds")
    payload = {
        "lists": list(kept_lists),
        "strategies": list(kept_strategies),
        "updated_at": updated,
    }
    path = favourites_path(root)
    with _write_lock(root):
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".favourites.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
    return Favourites(kept_lists, kept_strategies, updated)
