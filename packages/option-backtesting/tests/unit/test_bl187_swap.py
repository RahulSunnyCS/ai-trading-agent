"""BL-187: the registered swap rule (pure functions in research/bl187/swap.py)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import numpy as np

_PATH = Path(__file__).resolve().parents[2] / "research" / "bl187" / "swap.py"
_spec = importlib.util.spec_from_file_location("bl187_swap", _PATH)
swap = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules[_spec.name] = swap
_spec.loader.exec_module(swap)


def is_wide(name: str) -> bool:
    return "_wide" in name or "_p" in name


NAMES = [
    "N_wide_0917",  # 0: morning, not eligible
    "N_wide_1402",  # 1
    "N_wide_1417",  # 2
    "S_p250_1432",  # 3
    "N_dir_1417",  # 4: a Dir is never a candidate
    "N_wide-t1s4_1447",  # 5
    "S_wide_1517",  # 6
]


def test_cut_is_two_minutes_before_the_widesl_entry():
    assert swap.cut_of("N_wide_1417") == 14 * 60 + 15
    assert swap.cut_of("N_wide_1402") == 14 * 60
    assert swap.cut_of("S_wide_1517") == 15 * 60 + 15
    assert [swap.cut_label(swap.cut_of(f"N_wide_{s}")) for s in swap.LATE_SLOTS] == [
        "14:00", "14:15", "14:30", "14:45", "15:00", "15:15",
    ]  # fmt: skip


def test_strongest_late_widesl_skips_morning_dir_and_picked():
    comp = np.array([9.0, 1.0, 5.0, 4.0, 8.0, 5.0, 2.0])
    got = swap.ranked_late_widesl(
        NAMES, comp, picked=set(), is_wide=is_wide, earliest_entry=swap.slot_min("1402")
    )
    # 5.0 ties break on the name: N_wide-t1s4_1447 sorts before N_wide_1417
    assert [NAMES[v] for v in got] == [
        "N_wide-t1s4_1447", "N_wide_1417", "S_p250_1432", "S_wide_1517", "N_wide_1402",
    ]  # fmt: skip
    again = swap.ranked_late_widesl(
        NAMES, comp, picked={5}, is_wide=is_wide, earliest_entry=swap.slot_min("1402")
    )
    assert 5 not in again


def test_threshold_exclusion_and_fixed_slot():
    comp = np.arange(len(NAMES), dtype=float)
    after_1430 = swap.ranked_late_widesl(
        NAMES, comp, set(), is_wide, earliest_entry=swap.slot_min("1432")
    )
    assert {NAMES[v] for v in after_1430} == {"S_p250_1432", "N_wide-t1s4_1447", "S_wide_1517"}
    no1447 = swap.ranked_late_widesl(
        NAMES, comp, set(), is_wide, swap.slot_min("1402"), exclude_slots=("1447",)
    )
    assert all(swap.slot_of(NAMES[v]) != "1447" for v in no1447)
    fixed = swap.ranked_late_widesl(
        NAMES, comp, set(), is_wide, swap.slot_min("1432"), only_slot="1432"
    )
    assert [NAMES[v] for v in fixed] == ["S_p250_1432"]


def test_a_dir_entering_at_or_after_the_cut_leaves_the_day_alone():
    entry_1417 = 14 * 60 + 17
    assert swap.swap_for(entry_1417, "N_wide_1417") is None  # cut 14:15 is before the Dir enters
    assert swap.swap_for(9 * 60 + 17, "N_wide_1417") == 14 * 60 + 15
    assert swap.swap_for(14 * 60 + 15, "N_wide_1417") is None  # enters at the cut
    assert swap.swap_for(14 * 60 + 14, "N_wide_1417") == 14 * 60 + 15
