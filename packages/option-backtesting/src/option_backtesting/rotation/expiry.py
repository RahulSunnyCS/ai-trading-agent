"""The expiring-index rule (BL-122, owner 2026-10-18): on a day when exactly one index expires,
Adaptive (list C) takes only that index's strategies.

From `EXPIRY_ONLY_FROM` (Mon 2026-10-19, the first 09:16 pick that uses it) for the live list and
the T1 parallel track alike. Days before it are never filtered, so every recorded entry and every
re-scored history day stays as it was.

The rule is a FILTER of the ranking, not a re-ranking (BL-111 Amendment 1): the composite is
computed over the full universe exactly as before, then `score.select` runs over the expiring
index's variants only (Widesl minimum kept). The Buy add-on is the unrestricted list's, kept only
when it already is a variant of the expiring index; it is never replaced. On a day when both
indices expire, or neither, nothing changes.

The kill switch is the environment variable `ROTATION_EXPIRY_ONLY_FROM`, read at call time:
`YYYY-MM-DD` moves the start, `off` disables the rule. Anything else raises, so a typo stops the
pick loudly rather than silently recording the old rule.
"""

from __future__ import annotations

import os
from datetime import date

import numpy as np

from .score import Picks, runners_up, select
from .variants import underlying_of

#: the first session whose 09:16 pick applies the rule (owner, 2026-10-18)
EXPIRY_ONLY_FROM = date(2026, 10, 19)
#: the environment override: `YYYY-MM-DD`, or `off`
ENV = "ROTATION_EXPIRY_ONLY_FROM"
#: the lists the rule filters (Adaptive only; A, B and REF are recorded unfiltered)
RULE_LISTS: tuple[str, ...] = ("C",)
INDICES: tuple[str, ...] = ("NIFTY", "SENSEX")


class ExpiryRuleError(ValueError):
    """The rule cannot be applied as written (a bad switch value, no variant of the index)."""


def effective_from() -> date | None:
    """The first day the rule applies, or None when the switch is `off`. Read at call time."""
    raw = os.environ.get(ENV, "").strip()
    if not raw:
        return EXPIRY_ONLY_FROM
    if raw.lower() == "off":
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise ExpiryRuleError(
            f"{ENV}={raw!r} is neither YYYY-MM-DD nor 'off': nothing recorded"
        ) from error


def _known(label: str) -> bool:
    return label.isdigit() or label == "7+"


def expiring_index(dte_n: object, dte_s: object) -> str | None:
    """'NIFTY' or 'SENSEX' when exactly that index expires today (label '0' on the weekday basis),
    else None: neither, both, or either label not known ('unknown', None), because then it cannot
    be shown that only one index expires, and the list stays unrestricted as before."""
    labels = str(dte_n), str(dte_s)
    if not all(_known(x) for x in labels):
        return None
    n, s = labels[0] == "0", labels[1] == "0"
    if n and not s:
        return "NIFTY"
    if s and not n:
        return "SENSEX"
    return None


def rule_index(day: date, dte: dict[str, str]) -> str | None:
    """The index list C is restricted to on `day` ({'dte_n', 'dte_s'} on the weekday basis), or
    None: before the effective date, with the switch off, or when not exactly one index expires."""
    start = effective_from()
    if start is None or day < start:
        return None
    return expiring_index(dte.get("dte_n"), dte.get("dte_s"))


def _check_index(index: str) -> None:
    if index not in INDICES:
        raise ExpiryRuleError(f"unknown index {index!r} (known: {', '.join(INDICES)})")


def _keep(names: list[str], index: str) -> list[int]:
    _check_index(index)
    keep = [v for v, n in enumerate(names) if underlying_of(n) == index]
    if not keep:
        raise ExpiryRuleError(f"no {index} variant in the universe: the rule cannot be applied")
    return keep


def filter_picks(comp: np.ndarray, names: list[str], picks: Picks, index: str) -> Picks:
    """The list's picks under the rule. `comp` is the unrestricted composite over `names` (never
    recomputed); `picks` is the unrestricted selection, whose Buy add-on is kept only when it is a
    variant of `index`."""
    keep = _keep(names, index)
    sub = select(np.asarray(comp)[keep], [names[v] for v in keep])
    buy = [n for n in picks.buy if underlying_of(n) == index]
    by_name = {n: float(comp[v]) for v, n in enumerate(names)}
    return Picks(
        core=sub.core,
        buy=buy,
        overridden=sub.overridden,
        composite={n: by_name[n] for n in [*sub.core, *buy]},
    )


def filtered_runners_up(
    comp: np.ndarray, names: list[str], picks: Picks, index: str
) -> dict[str, str | None]:
    """`score.runners_up` over the expiring index's variants only (the optional next best on a
    rule day must come from the same index)."""
    keep = _keep(names, index)
    return runners_up(np.asarray(comp)[keep], [names[v] for v in keep], picks)
