"""Which strategies have daily results today, and their net P&L series (BL-090).

Nothing here is a fixed list. A strategy is found because it has results:

* a rotation variant: a CSV in `TRADING_DATA_ROOT/rotation/results/` (a new YAML under
  `strategies/rotation/` gets one the first evening `obt rotation update` runs);
* a legwise strategy: saved `daily` results in the trading-data catalog (a new YAML under
  `strategies/legwise/` gets them from `obt daily` or `obt legwise rerun`).

Legwise results belong to a version of the strategy (a hash of its validated settings). Only the
file's current version counts; a strategy whose saved days are all of an older version is listed
as stale and left out unless asked for, because those days are of a different strategy.

Selectors name strategies without listing them, so a strategy created tomorrow is addressable
the day it has results: an exact name, a glob (`N_*_0917`, `nifty_*`), `all`, `slot:0917`,
`family:wide|dir|buy|p80|ditm1|...`, `index:N|S`, `kind:legwise|variant`; `a+b` is both
(`slot:0917+index:N`). They match only against the enumerated names, never against a path.
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import yaml
from trading_data.db import connect

from ..analytics.correlation import Series
from ..fyers.daily import data_dir
from ..legwise import store as legwise_store
from ..legwise.schema import load_legwise
from ..presets import STRATEGIES_DIR
from . import store
from .variants import is_buy, is_dir, is_wide

LEGWISE_DIR = STRATEGIES_DIR / "legwise"
DEFAULT_SELECTORS = ["slot:0917"]


class SelectorError(ValueError):
    pass


@dataclass(frozen=True)
class Available:
    name: str
    kind: str  # "variant" | "legwise"
    first: date
    last: date
    n_days: int
    stale: bool = False
    values: dict[date, float] = field(default_factory=dict, repr=False, compare=False)

    def series(self) -> Series:
        return Series(self.name, self.kind, self.values)


def _parts(name: str) -> tuple[str, str, str] | None:
    bits = name.split("_")
    return (bits[0], bits[1], bits[2]) if len(bits) == 3 else None


def _current_versions(strategies_dir: Path) -> dict[str, str]:
    """{strategy id: spec hash} of the strategy files that load. A file that does not parse or
    validate is skipped (its strategy then reads as stale) instead of failing every comparison,
    including ones that only involve rotation variants."""
    out: dict[str, str] = {}
    for path in sorted(strategies_dir.glob("*.yaml")) if strategies_dir.exists() else []:
        try:
            strategy = load_legwise(path)
        except (ValueError, yaml.YAMLError, OSError):
            continue
        out[strategy.id] = legwise_store.spec_hash(strategy)
    return out


def _legwise(root: Path, strategies_dir: Path) -> list[Available]:
    try:
        with connect(root, read_only=True, views=()) as con:
            saved = legwise_store.load_daily_net(con)
    except FileNotFoundError:  # no catalog yet
        return []
    current = _current_versions(strategies_dir)
    by_strategy: dict[str, dict[str, dict[date, float]]] = {}
    for (sid, sha), days in saved.items():
        by_strategy.setdefault(sid, {})[sha] = days
    out = []
    for sid, versions in sorted(by_strategy.items()):
        want = current.get(sid)
        if want in versions:
            sha, stale = want, False
        else:  # the file changed since (or is gone): show the newest version, marked stale
            sha, stale = max(versions, key=lambda h: max(versions[h])), True
        days = versions[sha]
        out.append(Available(sid, "legwise", min(days), max(days), len(days), stale, values=days))
    return out


def available(root: Path | None = None, strategies_dir: Path | None = None) -> list[Available]:
    """Every strategy that has daily results now, variants first, each sorted by name."""
    root = root or data_dir()
    out = []
    results = store.results_dir(root)
    for path in sorted(results.glob("*.csv")) if results.exists() else []:
        values = store.read_net(path.stem, root)
        if values:
            out.append(
                Available(
                    path.stem, "variant", min(values), max(values), len(values), values=values
                )
            )
    out += _legwise(root, strategies_dir or LEGWISE_DIR)
    return out


_SLOT = re.compile(r"^\d{1,2}:?\d{2}$")


def _matches(selector: str, a: Available) -> bool:
    """`a+b` means both: `slot:0917+index:N` is the NIFTY strategies that start at 09:17."""
    if "+" in selector:
        return all(_matches(part, a) for part in selector.split("+") if part)
    key, sep, arg = selector.partition(":")
    if selector == "all":
        return True
    if sep and key == "kind":
        return a.kind == arg
    if sep and key in ("slot", "family", "index"):
        parts = _parts(a.name)
        if a.kind != "variant" or parts is None:
            return False
        index, family, tag = parts
        if key == "slot":
            return _SLOT.match(arg) is not None and tag == arg.replace(":", "").zfill(4)
        if key == "index":
            return index == arg.upper()
        wanted = arg.lower()
        if wanted == "wide":
            return is_wide(a.name)
        if wanted == "dir":
            return is_dir(a.name)
        if wanted == "buy":
            return is_buy(a.name)
        return family == wanted
    return fnmatch.fnmatchcase(a.name, selector)


def resolve(
    selectors: list[str], avail: list[Available], include_stale: bool = False
) -> list[Available]:
    """The strategies the selectors name, each once, in the order the selectors give them."""
    if not avail:
        raise SelectorError("no strategy has results yet (run `obt rotation update` / `obt daily`)")
    chosen: dict[str, Available] = {}
    for selector in selectors or DEFAULT_SELECTORS:
        hits = [a for a in avail if _matches(selector, a)]
        live = [a for a in hits if include_stale or not a.stale]
        if not live:
            if hits:
                names = ", ".join(a.name for a in hits)
                raise SelectorError(
                    f"{selector!r}: only stale results ({names}); the strategy file changed "
                    "since they were saved. Re-run it, or pass --include-stale"
                )
            kinds = {a.kind for a in avail}
            sample = ", ".join(a.name for a in avail[:3])
            raise SelectorError(
                f"{selector!r} matches nothing. {len(avail)} strategies have results "
                f"({', '.join(sorted(kinds))}; e.g. {sample}); `obt rotation corr-list` shows all"
            )
        for a in live:
            chosen.setdefault(a.name, a)
    return list(chosen.values())


def load(
    selectors: list[str],
    root: Path | None = None,
    include_stale: bool = False,
    strategies_dir: Path | None = None,
) -> list[Series]:
    """Series for the selectors, enumerated fresh each call."""
    avail = available(root, strategies_dir)
    return [a.series() for a in resolve(selectors, avail, include_stale)]
