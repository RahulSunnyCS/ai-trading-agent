"""A portfolio mark-to-market stop over a basket of strategies (BL-095).

Each strategy already has its own overall stop, per lot. The owner also runs the whole basket
under one stop on the combined P&L: the first minute the book's mark-to-market reaches the stop
level, everything closes at that minute's close and nothing that has not entered yet enters.
This module replays that on top of the engine's own per-minute curves; it stores nothing and
changes no stored result. The same construction and rule as BL-055's research script
(`research/bl055/evaluate.py`), which the unit tests reproduce.

Per member the one-lot path is: 0 before it starts, its MTM at each simulated minute, its
realised gross after it ends. The book is the sum of those paths, each times its lots. A stop of
`None`, 0 or below is no stop.

Trailing (optional; AlgoTest's three modes, written from its wording). `best` is the book's
highest MTM so far that day at a minute close, never below 0; the level only ever moves up:

* **Trail SL (X, Y)**: level = -stop + Y * floor(best / X). Needs a stop.
* **Lock profit (A, B)**: once best >= A, level = max(level, B).
* **Lock and trail (A, B, X, Y)**: once best >= A,
  level = max(level, B + Y * floor((best - A) / X)).

The two lock modes also work with no stop (a profit lock with no loss stop). The exit is the
same in every mode: everything closes at the close of the first minute at or below the level.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..legwise.market import N_MINUTES, minute_label

DEFAULT_STOP_INR = 10_000.0
MODES = ("sl", "lock", "locktrail")
_FIELDS = {"sl": ("x", "y"), "lock": ("a", "b"), "locktrail": ("a", "b", "x", "y")}


class PortfolioStopError(ValueError):
    """A setting that cannot be read, or a day that cannot be replayed."""


@dataclass(frozen=True)
class Trail:
    """One trailing mode. `a`/`b`: profit that arms the lock and the level it locks. `x`/`y`: for
    every `x` of profit the level moves up `y`."""

    mode: str
    a: float | None = None
    b: float | None = None
    x: float | None = None
    y: float | None = None

    def text(self) -> str:
        return f"{self.mode}:" + ",".join(f"{getattr(self, f):g}" for f in _FIELDS[self.mode])


@dataclass(frozen=True)
class Member:
    """One strategy in the basket: its one-lot path (N_MINUTES long) and the lots it carries."""

    name: str
    lots: int
    pnl: tuple[float, ...]


@dataclass(frozen=True)
class BookDay:
    combined: list[float]  # the book without a portfolio stop, per minute (last = the day's gross)
    stopped: list[float]  # the book with the stop applied, per minute
    level: list[float | None]  # the stop level at each minute up to the stop (None = no level)
    stop_minute: int | None
    fired_by: str | None  # "stop" | "trail" | "lock"
    gross_without: float
    gross_with: float
    members: list[dict]

    @property
    def stop_label(self) -> str | None:
        return None if self.stop_minute is None else minute_label(self.stop_minute)

    def to_dict(self) -> dict:
        return {
            "stop_minute": self.stop_minute,
            "stop_label": self.stop_label,
            "fired_by": self.fired_by,
            "gross_without": round(self.gross_without, 2),
            "gross_with": round(self.gross_with, 2),
            "members": self.members,
        }


def normalise_stop(value: float | None) -> float | None:
    """The stop amount, or None for empty, 0 or below."""
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError) as error:
        raise PortfolioStopError(f"portfolio stop must be a number, got {value!r}") from error
    if math.isnan(amount) or math.isinf(amount):
        raise PortfolioStopError("portfolio stop must be a finite number")
    return amount if amount > 0 else None


def parse_trail(text: str | None) -> Trail | None:
    """`sl:X,Y` | `lock:A,B` | `locktrail:A,B,X,Y`; empty is no trailing. A field that is empty,
    0 or below turns that mode off (None). Anything else that is malformed raises."""
    if text is None or not text.strip():
        return None
    mode, _, rest = text.strip().partition(":")
    mode = mode.strip().lower()
    if mode not in MODES:
        raise PortfolioStopError(f"trail mode must be one of {', '.join(MODES)}, got {mode!r}")
    names = _FIELDS[mode]
    raw = [p.strip() for p in rest.split(",")]
    if len(raw) != len(names):
        raise PortfolioStopError(f"trail {mode} needs {len(names)} numbers: {', '.join(names)}")
    values: dict[str, float] = {}
    for name, piece in zip(names, raw, strict=True):
        if piece == "":
            return None
        try:
            number = float(piece)
        except ValueError as error:
            raise PortfolioStopError(f"trail {name} must be a number, got {piece!r}") from error
        if math.isnan(number) or math.isinf(number):
            raise PortfolioStopError(f"trail {name} must be finite")
        if number <= 0:
            return None
        values[name] = number
    trail = Trail(mode, **values)
    _check(trail)
    return trail


def settings_from_query(stop: str | None, trail: str | None) -> tuple[float | None, Trail | None]:
    """The stop and trail as a route receives them: `stop` empty or missing is none, a malformed
    value raises PortfolioStopError (never silently ignored)."""
    amount: float | None = None
    if stop is not None and stop.strip() != "":
        try:
            amount = float(stop)
        except ValueError as error:
            raise PortfolioStopError(f"stop must be a number, got {stop!r}") from error
        if math.isnan(amount) or math.isinf(amount):
            raise PortfolioStopError("stop must be a finite number")
    return amount, parse_trail(trail)


def _check(trail: Trail) -> None:
    if trail.x is not None and trail.y is not None and trail.y > trail.x:
        raise PortfolioStopError("the stop cannot move more than the profit did (Y above X)")
    if trail.a is not None and trail.b is not None and trail.b > trail.a:
        raise PortfolioStopError("the locked profit cannot be above the profit that arms it")


def _candidates(stop: float | None, trail: Trail | None, best: float) -> tuple[float, str] | None:
    """The stop level for this minute and what set it, from the best MTM so far."""
    options: list[tuple[float, str]] = []
    if stop is not None:
        options.append((-stop, "stop"))
    if trail is not None:
        if trail.mode == "sl" and stop is not None:
            options.append((-stop + trail.y * math.floor(best / trail.x), "trail"))  # type: ignore[operator]
        elif trail.mode == "lock" and best >= trail.a:  # type: ignore[operator]
            options.append((trail.b, "lock"))  # type: ignore[arg-type]
        elif trail.mode == "locktrail" and best >= trail.a:  # type: ignore[operator]
            steps = math.floor((best - trail.a) / trail.x)  # type: ignore[operator]
            options.append((trail.b + trail.y * steps, "lock"))  # type: ignore[operator]
    if not options:
        return None
    return max(options, key=lambda o: o[0])


def apply_book(
    members: list[Member], stop_inr: float | None, trail: Trail | None = None
) -> BookDay:
    """The basket's day under the portfolio stop (and trailing, if any)."""
    for m in members:
        if len(m.pnl) != N_MINUTES:
            raise PortfolioStopError(f"{m.name}: path has {len(m.pnl)} minutes, not {N_MINUTES}")
    stop = normalise_stop(stop_inr)
    combined = [sum(m.lots * m.pnl[i] for m in members) for i in range(N_MINUTES)]
    stopped = list(combined)
    level: list[float | None] = []
    best = 0.0
    stop_minute: int | None = None
    fired_by: str | None = None
    for i, value in enumerate(combined):
        best = max(best, value)
        picked = _candidates(stop, trail, best)
        level.append(None if picked is None else picked[0])
        if picked is not None and value <= picked[0]:
            stop_minute, fired_by = i, picked[1]
            for j in range(i, N_MINUTES):
                stopped[j] = value
            break
    level += [None] * (N_MINUTES - len(level))
    at = N_MINUTES - 1 if stop_minute is None else stop_minute
    rows = [
        {
            "name": m.name,
            "lots": m.lots,
            "gross_without": round(m.lots * m.pnl[-1], 2),
            "at_stop": round(m.lots * m.pnl[at], 2),
        }
        for m in members
    ]
    return BookDay(
        combined=combined,
        stopped=stopped,
        level=level,
        stop_minute=stop_minute,
        fired_by=fired_by,
        gross_without=combined[-1],
        gross_with=stopped[-1],
        members=rows,
    )


def member_from_curve(name: str, lots: int, curve: list[tuple[int, float]], gross: float) -> Member:
    """A member's one-lot path from an engine day: 0 before it starts, the MTM at each simulated
    minute, the realised gross after its last minute (as BL-055 built it)."""
    if not curve:
        return Member(name, lots, (float(gross),) * N_MINUTES)
    path = [0.0] * N_MINUTES
    for minute, value in curve:
        path[minute] = float(value)
    last = curve[-1][0]
    for i in range(last + 1, N_MINUTES):
        path[i] = float(gross)
    return Member(name, lots, tuple(path))


_cache_lock = threading.Lock()
_paths: dict[tuple, tuple[float, ...]] = {}  # one-lot paths; a replay costs ~0.1-0.7 s a day
_PATHS_MAX = 6000  # about 12 distinct picks a day: the whole history is ~1,500


def _stamp(root: Path, day: date, name: str) -> tuple:
    """What the replay of `name` on `day` depends on: its strategy file and the day's lake files
    (a day repaired from Fyers changes them, so a long-running API never serves the old path)."""
    from trading_data import lake

    from .variants import strategy_path, underlying_of

    underlying = underlying_of(name)
    parts: list[int] = []
    for kind in ("option", "index"):
        try:
            parts.append(lake.bars_1m_path(root, kind, underlying, day).stat().st_mtime_ns)
        except OSError:
            parts.append(0)
    try:
        parts.append(strategy_path(name).stat().st_mtime_ns)
    except OSError:
        parts.append(0)
    return tuple(parts)


def cache_dir() -> Path:
    """Where replayed one-lot paths are kept between runs of the API: a disposable cache outside
    the data root (`ATA_PORTFOLIO_CACHE_DIR` overrides it). Deleting it only makes the next
    request replay again."""
    env = os.environ.get("ATA_PORTFOLIO_CACHE_DIR")
    return Path(env) if env else Path.home() / ".cache" / "ai-trading-agent" / "portfolio-paths"


def _disk_file(key: tuple) -> Path:
    root, day, name, stamp = key
    digest = hashlib.sha1(f"{root}|{stamp}".encode()).hexdigest()[:12]  # noqa: S324 - a cache key
    return cache_dir() / name / f"{day.isoformat()}.{digest}.json"


def _disk_read(key: tuple) -> tuple[float, ...] | None:
    try:
        values = json.loads(_disk_file(key).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(values, list) or len(values) != N_MINUTES:
        return None
    try:
        return tuple(float(v) for v in values)
    except (TypeError, ValueError):
        return None


def _disk_write(key: tuple, path: tuple[float, ...]) -> None:
    """Best effort: a cache that cannot be written is simply not there next time. A stale file for
    the same pick-day (its lake files were repaired since) is removed."""
    target = _disk_file(key)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        for old in target.parent.glob(f"{key[1].isoformat()}.*.json"):
            if old != target:
                old.unlink(missing_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text(json.dumps(path))
        tmp.replace(target)
    except OSError:
        pass


def one_lot_path(root: Path, day: date, name: str, loaded: dict | None = None) -> tuple[float, ...]:
    """One variant's one-lot path on `day`, replayed exactly as the nightly update did (same
    strategy file, same lot-sizing date), and cached. `loaded` shares a day's loaded index data
    across picks of one call. Raises PortfolioStopError for a day or variant it cannot run."""
    from ..data.reference.loader import MissingReferenceData, default_reference_data
    from ..legwise.engine import simulate_day
    from ..legwise.market import load_day
    from ..legwise.schema import load_legwise
    from .lists import SIZING_DATE
    from .variants import strategy_path, underlying_of, variant_names

    if name not in set(variant_names()):  # matched against the enumerated files, never a path
        raise PortfolioStopError(f"{name!r} is not one of the rotation variants")
    key = (str(root), day, name, _stamp(root, day, name))
    with _cache_lock:
        hit = _paths.get(key)
    if hit is None:
        hit = _disk_read(key)
        if hit is not None:
            with _cache_lock:
                if len(_paths) >= _PATHS_MAX:
                    _paths.pop(next(iter(_paths)))
                _paths[key] = hit
    if hit is not None:
        return hit
    loaded = loaded if loaded is not None else {}
    underlying = underlying_of(name)
    try:
        if underlying not in loaded:
            loaded[underlying] = load_day(root, underlying, day)
        result = simulate_day(
            load_legwise(strategy_path(name)),
            loaded[underlying],
            default_reference_data(),
            date.fromisoformat(SIZING_DATE),
        )
    except FileNotFoundError as error:
        raise PortfolioStopError(f"no collected {underlying} data for {day}") from error
    except MissingReferenceData as error:
        raise PortfolioStopError(f"{name}: reference: {error}") from error
    path = member_from_curve(name, 1, result.mtm, result.gross).pnl
    with _cache_lock:
        if len(_paths) >= _PATHS_MAX:
            _paths.pop(next(iter(_paths)))
        _paths[key] = path
    _disk_write(key, path)
    return path


def book_day(
    root: Path,
    day: date,
    picks: list[tuple[str, int]],
    stop_inr: float | None,
    trail: Trail | None = None,
    loaded: dict | None = None,
) -> BookDay:
    """Replay each pick on `day` and apply the portfolio stop. `picks` is [(variant, lots)]. A day
    any pick cannot be run on raises PortfolioStopError, never a partial book."""
    if not picks:
        raise PortfolioStopError("a book needs at least one pick")
    loaded = loaded if loaded is not None else {}
    members = [Member(n, lots, one_lot_path(root, day, n, loaded)) for n, lots in picks]
    return apply_book(members, stop_inr, trail)


def clear_cache() -> None:
    with _cache_lock:
        _paths.clear()
