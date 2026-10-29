"""The SL150% cap (BL-192, owner 2026-10-30; BL-191 Amendment 2's arm D2): on a day NIFTY does not
expire, Adaptive's picks hold at most one `N_wide-t1s4` (T1's SL150% NIFTY OTM1 Widesl).

From `CAP_FROM` (Fri 2026-10-30, the first 09:16 pick that uses it). Days before it are never
capped, so every recorded entry and every re-scored history day stays as it was. Only T1's universe
has the setting, so for Core-298 the cap never changes anything.

Like the expiring-index rule (`expiry.py`, BL-122) the cap is a FILTER of the ranking, not a
re-ranking: the composite is computed over the full universe exactly as before. Only when the
selected core holds two or more `N_wide-t1s4`, the one with the highest composite stays, the others
leave the candidate pool, and `score.select` runs again over the rest (top three, at least two
Widesl). The Buy add-on is never touched. On a NIFTY expiry day (DTE label "0") nothing changes.

The kill switch is the environment variable `ROTATION_SL150_CAP_FROM`, read at call time:
`YYYY-MM-DD` moves the start, `off` disables the cap. Anything else raises, so a typo stops the
pick loudly rather than silently recording without the cap.
"""

from __future__ import annotations

import os
from datetime import date

import numpy as np

from .score import Picks, runners_up, select

#: the first session whose 09:16 pick applies the cap (owner, 2026-10-30)
CAP_FROM = date(2026, 10, 30)
#: the environment override: `YYYY-MM-DD`, or `off`
ENV = "ROTATION_SL150_CAP_FROM"
#: the capped setting: T1's SL150% NIFTY OTM1 Widesl (`N_wide-t1s4_<HHMM>`)
SETTING = "N_wide-t1s4_"


class CapError(ValueError):
    """The switch has a value the cap cannot read."""


def effective_from() -> date | None:
    """The first day the cap applies, or None when the switch is `off`. Read at call time."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return CAP_FROM
    if raw.lower() == "off":
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise CapError(
            f"{ENV}={raw!r} is neither YYYY-MM-DD nor 'off': nothing recorded"
        ) from error


def applies(day: date, dte_n: object) -> bool:
    """True on `day` when the cap is on and NIFTY does not expire (its label is not "0")."""
    start = effective_from()
    return start is not None and day >= start and str(dte_n) != "0"


def _keep(comp: np.ndarray, names: list[str], core: list[str]) -> list[int] | None:
    """The candidate pool once the cap bites (every variant but the capped-out copies), or None when
    the core holds fewer than two copies."""
    mine = [n for n in core if n.startswith(SETTING)]
    if len(mine) < 2:
        return None
    index = {n: v for v, n in enumerate(names)}
    best = max(mine, key=lambda n: (comp[index[n]], n))
    return [v for v, n in enumerate(names) if not n.startswith(SETTING) or n == best]


def cap_picks(comp: np.ndarray, names: list[str], picks: Picks) -> Picks:
    """`picks` with at most one copy (the composite and the pool unchanged); `picks` itself when the
    cap does not bite."""
    keep = _keep(comp, names, picks.core)
    if keep is None:
        return picks
    sub = select(np.asarray(comp)[keep], [names[v] for v in keep])
    by_name = {n: float(comp[v]) for v, n in enumerate(names)}
    return Picks(
        core=sub.core,
        buy=list(picks.buy),
        overridden=sub.overridden,
        composite={n: by_name[n] for n in [*sub.core, *picks.buy]},
    )


def capped_runners_up(
    comp: np.ndarray, names: list[str], picks: Picks, capped: Picks
) -> dict[str, str | None]:
    """The next best Widesl and Dir after a capped pick, never a capped-out copy."""
    keep = _keep(comp, names, picks.core)
    if keep is None:
        return runners_up(comp, names, capped)
    return runners_up(np.asarray(comp)[keep], [names[v] for v in keep], capped)
