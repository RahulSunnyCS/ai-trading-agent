"""BL-187: the swap rule as pure functions (no data, no engine), so the registered rule can be tested.

Slots are the four-digit strategy suffixes ("1417" = entry 14:17); minutes are minutes of the day.
"""

from __future__ import annotations

import numpy as np

# The Widesl slots after 14:00 and the Dir cut each implies (entry minus two minutes).
LATE_SLOTS = ("1402", "1417", "1432", "1447", "1502", "1517")
CUT_GAP = 2


def slot_of(name: str) -> str:
    return name.rsplit("_", 1)[1]


def slot_min(slot: str) -> int:
    return int(slot[:2]) * 60 + int(slot[2:])


def cut_label(minute: int) -> str:
    return f"{minute // 60:02d}:{minute % 60:02d}"


def cut_of(widesl_name: str) -> int:
    """The minute the Dir ends for a Widesl entering at this name's slot."""
    return slot_min(slot_of(widesl_name)) - CUT_GAP


def ranked_late_widesl(
    names: list[str],
    comp: np.ndarray,
    picked: set[int],
    is_wide,
    earliest_entry: int,
    exclude_slots: tuple[str, ...] = (),
    only_slot: str | None = None,
) -> list[int]:
    """Indices of the eligible Widesl, strongest first (composite, then name, as `score.select`
    orders ties): Widesl whose entry is at or after `earliest_entry`, not already picked, not in
    `exclude_slots`, and (for the fixed-time arms) exactly at `only_slot`."""
    out = [
        v
        for v in range(len(names))
        if is_wide(names[v])
        and v not in picked
        and slot_min(slot_of(names[v])) >= earliest_entry
        and slot_of(names[v]) not in exclude_slots
        and (only_slot is None or slot_of(names[v]) == only_slot)
    ]
    return sorted(out, key=lambda v: (-comp[v], names[v]))


def swap_for(dir_entry: int, widesl_name: str) -> int | None:
    """The Dir's cut minute when the swap happens, None when the Dir enters at or after the cut
    (the day is then left as picked)."""
    cut = cut_of(widesl_name)
    return cut if dir_entry < cut else None
