"""BL-209 (owner, 2026-11-04): T1 split across the two AlgoTest accounts. Each account no longer
trades every pick: of the day's three core picks the odd one (the Dir on a 1 Dir + 2 Widesl day,
the third Widesl on a 3-Widesl day, the Widesl on a 2 Dir + 1 Widesl day) still trades on each
account, and the like pair goes one per account, each at both accounts' lots. A 2-lot leg is one
order, so the pair costs half the brokerage; every pick trades the same lots across the two
accounts, and each account the same number of lots, as without the split.

The lead account (Shoonya, the cheaper one at ₹5 an order against Angel One's ₹20) takes the pair
member with a re-entry, since a re-entry is more orders; with none or both, the first in pick
order. A Dir ×2 extra lot stays on the account whose row has Dir ×2 on, so a pair member with more
lots on one account goes to that account. Anything else (not three picks, not two accounts, three
Dirs) is the layout without the split.

`split` is pure but for the re-entry test it is given (by default `has_reentry`, which reads the
strategy file). The export, the messages, the margin block and the BL-209 replay all call it, so
they never disagree."""

from __future__ import annotations

from collections.abc import Callable
from functools import lru_cache

from ..legwise.schema import load_legwise
from .variants import is_dir, strategy_path

#: the account that takes the re-entry pair member and the Buy add-on (owner, 2026-11-04)
LEAD = "finvasia"


@lru_cache(maxsize=1024)
def has_reentry(name: str) -> bool:
    """Whether any leg of the variant's strategy re-enters after a stop (False when unreadable)."""
    try:
        spec = load_legwise(strategy_path(name))
    except Exception:  # noqa: BLE001 - no file or a bad one: treated as no re-entry
        return False
    return any(leg.reentry_on_sl is not None for leg in spec.legs)


def shape(core: list[str]) -> tuple[str, list[str]] | None:
    """(the odd pick, the like pair in pick order), or None for a day the split leaves alone."""
    if len(core) != 3:
        return None
    dirs = [n for n in core if is_dir(n)]
    wides = [n for n in core if not is_dir(n)]
    if len(dirs) == 1:
        return dirs[0], wides
    if not dirs:
        return wides[2], wides[:2]
    if len(dirs) == 2:
        return wides[0], dirs
    return None


def split(
    core: list[str],
    lots: dict[str, dict[str, int]],
    lead: str = LEAD,
    reentry: Callable[[str], bool] = has_reentry,
) -> dict[str, dict[str, int]]:
    """{broker: {variant: lots}} in pick order. `lots` is each account's lots without the split,
    {broker: `live_lots.lots_for_day(core, dte, on=<its row's Dir ×2>)`}, for the two accounts
    that trade the list."""
    unchanged = {b: dict(v) for b, v in lots.items()}
    found = shape(core)
    if found is None or len(lots) != 2 or lead not in lots:
        return unchanged
    other = next(b for b in lots if b != lead)
    odd, pair = found
    a, b = pair
    even = lots[lead][a] == lots[other][a] and lots[lead][b] == lots[other][b]
    if lots[other][a] > lots[lead][a] or lots[lead][b] > lots[other][b]:
        a, b = b, a  # the extra lot stays on its account
    elif even and reentry(b) and not reentry(a):
        a, b = b, a
    take = {lead: {odd, a}, other: {odd, b}}
    return {
        broker: {
            n: (lots[broker][n] if n == odd else lots[lead][n] + lots[other][n])
            for n in core
            if n in take[broker]
        }
        for broker in (lead, other)
    }
