"""BL-190: a pick is finished only when nothing can re-enter (no look-ahead)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace as NS

_RESEARCH = Path(__file__).resolve().parents[2] / "research"
sys.path.insert(0, str(_RESEARCH / "common"))
_spec = importlib.util.spec_from_file_location("bl190_run", _RESEARCH / "bl190" / "run.py")
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)
finished_at = _mod.finished_at


def leg(id_, count=None):
    return NS(id=id_, reentry_on_sl=None if count is None else NS(count=count))


def trade(leg_id, exit_min, reason):
    return NS(leg_id=leg_id, exit_min=exit_min, exit_reason=reason)


def test_both_legs_stopped_without_reentry_is_finished_at_the_later_stop():
    s = NS(legs=[leg("ce"), leg("pe")])
    r = NS(trades=[trade("ce", 20, "SL"), trade("pe", 75, "TRAIL")], stopped_by=None)
    assert finished_at(s, r) == (75, "legs stopped")


def test_a_leg_still_running_is_not_finished():
    s = NS(legs=[leg("ce"), leg("pe")])
    r = NS(trades=[trade("ce", 20, "SL"), trade("pe", 373, "EXIT_TIME")], stopped_by=None)
    assert finished_at(s, r) == (None, "")


def test_an_unused_reentry_means_not_finished_even_if_it_never_happens():
    s = NS(legs=[leg("ce", 1), leg("pe", 1)])
    r = NS(
        trades=[trade("ce", 20, "SL"), trade("ce", 90, "SL"), trade("pe", 40, "SL")],
        stopped_by=None,
    )
    assert finished_at(s, r) == (None, "")


def test_the_overall_stop_finishes_at_its_minute():
    s = NS(legs=[leg("ce", 2), leg("pe", 2)])
    r = NS(
        trades=[trade("ce", 28, "SL"), trade("pe", 233, "OVERALL_SL")],
        stopped_by="overall SL at 13:08",
    )
    assert finished_at(s, r) == (233, "overall stop")
