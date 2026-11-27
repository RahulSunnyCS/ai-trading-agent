"""BL-247: the registered grid's size and SHA, and that each side of a pair differs only in entry."""

import importlib.util
import sys
from pathlib import Path

# loaded under its own name: other items' tests import a different `grid` module
_PATH = Path(__file__).resolve().parents[2] / "research" / "bl247" / "grid.py"
_SPEC = importlib.util.spec_from_file_location("bl247_grid", _PATH)
grid = importlib.util.module_from_spec(_SPEC)
sys.modules["bl247_grid"] = grid
_SPEC.loader.exec_module(grid)


def test_registered_counts_and_sha():
    assert {f: len(grid.pairs(f)) for f in grid.FAMILIES} == {"dir": 24, "widesl": 24}
    assert grid.grid_sha() == "5364a4f9a71161f3"


def test_a_pair_differs_only_in_its_entry_time():
    for family in grid.FAMILIES:
        for params in grid.pairs(family):
            for root in grid.ROOTS:
                for season in ("summer", "winter"):
                    new, base = (
                        grid.build(family, params, entry, root, season).model_dump()
                        for entry in grid.ENTRIES
                    )
                    assert (new.pop("entry_time"), base.pop("entry_time")) == ("15:30", "17:05")
                    new.pop("id"), base.pop("id")
                    assert new == base
                    assert new["execution"]["slippage_pct"] == 1.0


def test_close_exit_follows_the_season():
    params = {"strike": "ATM", "sl": 21, "reentry": "cost1", "exit": "close"}
    assert grid.build("dir", params, "15:30", "GOLDM", "winter").exit_time == "23:40"
    assert grid.build("dir", params, "15:30", "GOLDM", "summer").exit_time == "23:15"
