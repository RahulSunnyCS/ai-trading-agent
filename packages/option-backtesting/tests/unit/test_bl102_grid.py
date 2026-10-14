"""BL-102: the registered Stage-1 grid is what Phase 0 says it is.

Every cell must validate through the legwise schema (no cell is silently dropped by the runner),
the counts are the registered ones, the SHA is the one recorded in the backlog item, and each
cohort's template cell is the rotation file untouched.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

GRID_PY = Path(__file__).resolve().parents[2] / "research" / "bl102" / "grid.py"
REGISTERED_SHA = "6a1078bb4fe68786"  # recorded in backlog/BL-102 Phase 0


def _load():
    spec = importlib.util.spec_from_file_location("bl102_grid", GRID_PY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["bl102_grid"] = module  # dataclasses resolve string annotations through here
    spec.loader.exec_module(module)
    return module


grid = _load()


def test_counts_are_the_registered_ones() -> None:
    counts = grid.registered()["counts"]
    assert counts == {"W": 24_192, "D": 16_512, "B": 22_680}
    # 14 cohorts per family, each with one template cell on top of the grid.
    for family in grid.FAMILIES:
        n = sum(len(grid.cells(family, i, s)) for i in grid.INDICES for s in grid.SLOTS)
        assert n == counts[family] + 14


def test_sha_matches_phase_0() -> None:
    assert grid.grid_sha() == REGISTERED_SHA


def test_bands() -> None:
    assert [grid.band(s) for s in grid.SLOTS] == ["A", "A", "A", "B", "B", "C", "D"]


def test_dir_cutoff_cells_excluded_only_at_or_after_the_cutoff() -> None:
    for slot in grid.SLOTS:
        has_cutoff = any(
            c.params["reentry"] is not None and c.params["reentry"][2] is not None
            for c in grid.cells("D", "N", slot, with_template=False)
        )
        assert has_cutoff == (slot < "13:00"), slot


@pytest.mark.parametrize("family", grid.FAMILIES)
@pytest.mark.parametrize("index", list(grid.INDICES))
@pytest.mark.parametrize("slot", grid.SLOTS)
def test_every_cell_validates(family: str, index: str, slot: str) -> None:
    template = grid.load_template(family, index, slot)
    seen: set[str] = set()
    for cell in grid.cells(family, index, slot):
        strategy = grid.build(cell, template)
        assert strategy.id == cell.label
        assert cell.label not in seen
        seen.add(cell.label)
        assert strategy.underlying == cell.underlying
        assert strategy.entry_time == slot
        # Round trip of the CSV columns the runner writes.
        row = grid.params_to_row(family, cell.params)
        assert grid.params_from_row(family, row) == cell.params


@pytest.mark.parametrize("family", grid.FAMILIES)
@pytest.mark.parametrize("index", list(grid.INDICES))
def test_template_cell_is_the_rotation_file(family: str, index: str) -> None:
    template = grid.load_template(family, index, "09:17")
    cell = grid.cells(family, index, "09:17")[0]
    assert cell.is_template
    built = grid.build(cell, template)
    expected = template.model_dump()
    expected["id"] = cell.label
    assert built.model_dump() == expected


def test_sensex_buy_scales_premium_and_points() -> None:
    cell = grid.Cell(
        "B",
        "S",
        "09:17",
        {
            "strike": "PLOW",
            "range": 10,
            "source": "instrument",
            "sl": 20,
            "target": 50,
            "trail": (1, 1),
            "mtm": 1000,
        },
    )
    s = grid.build(cell)
    assert s.legs[0].strike.closest_premium == 90
    assert s.legs[0].trail_sl.points == (3.0, 3.0)
    assert s.legs[0].range_breakout.until == "09:27"
    assert s.legs[0].target.percent == 50
    nifty = grid.build(grid.Cell("B", "N", "09:17", cell.params))
    assert nifty.legs[0].strike.closest_premium == 30
    assert nifty.legs[0].trail_sl.points == (1.0, 1.0)


def test_chains_cover_every_axis_value() -> None:
    for family, axes in grid.AXES.items():
        for axis, values in axes.items():
            covered = {v for chain in grid.CHAINS[family][axis] for v in chain}
            assert covered == set(values), (family, axis)
