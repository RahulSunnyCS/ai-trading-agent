"""BL-202: the registered Buy grid is what Phase 0 says it is.

Every cell must validate through the legwise schema (no cell is silently dropped by the runner),
the counts are the registered ones, the SHA is the one recorded in the backlog item, every cell
carries the registered slippage, and each cohort's template cell is the rotation file untouched
but for that slippage.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

GRID_PY = Path(__file__).resolve().parents[2] / "research" / "bl202" / "grid.py"
REGISTERED_SHA = "5f6d9595a141c13c"  # recorded in backlog/BL-202 Phase 0


def _load():
    spec = importlib.util.spec_from_file_location("bl202_grid", GRID_PY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["bl202_grid"] = module  # dataclasses resolve string annotations through here
    spec.loader.exec_module(module)
    return module


grid = _load()


def test_counts_are_the_registered_ones() -> None:
    counts = grid.registered()["counts"]
    assert counts == {"per_cohort": 10_240, "total": 81_920}
    # 8 cohorts, each with one template cell on top of the grid.
    n = sum(len(grid.cells(i, s)) for i in grid.INDICES for s in grid.SLOTS)
    assert n == counts["total"] + 8


def test_sha_matches_phase_0() -> None:
    assert grid.grid_sha() == REGISTERED_SHA


def test_bands_one_slot_each() -> None:
    assert [grid.band(s) for s in grid.SLOTS] == ["A", "B", "C", "D"]


def test_stage1_excludes_nothing() -> None:
    for slot in grid.SLOTS:
        assert all(grid.excluded(slot, p) is None for p in grid.cartesian())


@pytest.mark.parametrize("index", list(grid.INDICES))
@pytest.mark.parametrize("slot", grid.SLOTS)
def test_every_cell_validates(index: str, slot: str) -> None:
    template = grid.load_template(index, slot)
    seen: set[str] = set()
    for cell in grid.cells(index, slot):
        strategy = grid.build(cell, template)
        assert strategy.id == cell.label
        assert cell.label not in seen
        seen.add(cell.label)
        assert strategy.underlying == cell.underlying
        assert strategy.entry_time == slot
        assert strategy.execution is not None
        assert strategy.execution.slippage_pct == grid.SLIPPAGE_PCT
        # Round trip of the CSV columns the runner writes.
        assert grid.params_from_row(grid.params_to_row(cell.params)) == cell.params


@pytest.mark.parametrize("index", list(grid.INDICES))
def test_template_cell_is_the_rotation_file_plus_slippage(index: str) -> None:
    template = grid.load_template(index, "09:17")
    cell = grid.cells(index, "09:17")[0]
    assert cell.is_template
    built = grid.build(cell, template)
    expected = template.model_dump()
    expected["id"] = cell.label
    expected["execution"] = grid.execution_for().model_dump()
    assert built.model_dump() == expected
    # At slippage 0 it is BL-104's template cell (the regression anchor).
    anchor = grid.build(cell, template, slippage=0.0)
    assert anchor.execution.slippage_pct == 0.0


def test_sensex_scales_premium_and_points_not_percent() -> None:
    params = {
        "strike": "PLOW",
        "range": 5,
        "source": "instrument",
        "sl": 15,
        "target": 200,
        "trail": ("pts", 1, 1),
        "mtm": None,
    }
    s = grid.build(grid.Cell("S", "09:17", params))
    assert s.legs[0].strike.closest_premium == 90
    assert s.legs[0].trail_sl.points == (3.0, 3.0)
    assert s.legs[0].range_breakout.until == "09:22"
    assert s.legs[0].target.percent == 200
    assert s.overall.stop_loss_inr is None
    n = grid.build(grid.Cell("N", "09:17", params))
    assert n.legs[0].strike.closest_premium == 30
    assert n.legs[0].trail_sl.points == (1.0, 1.0)
    pct = grid.build(grid.Cell("S", "09:17", {**params, "trail": ("pct", 20, 10)}))
    assert pct.legs[0].trail_sl.percent == (20.0, 10.0)


def test_stage2_extras_build_and_round_trip() -> None:
    base = grid.cells("N", "12:17", with_template=False)[0].params
    params = {
        **base,
        "exit": "15:28",
        "gap": 1.0,
        "valid": 60,
        "stop_on": "close",
        "reentry": ("cost", 1),
        "peak": (150, 70),
    }
    s = grid.build(grid.Cell("N", "12:17", params))
    leg = s.legs[0]
    assert s.exit_time == "15:28"
    assert leg.range_breakout.gap_percent == 1.0
    assert leg.range_breakout.valid_until == "13:17"
    assert leg.stop_on == "close"
    assert leg.reentry_on_sl.mode == "cost" and leg.reentry_on_sl.count == 1
    assert leg.trail_peak.activate_percent == 150 and leg.trail_peak.exit_percent == 70
    assert grid.params_from_row(grid.params_to_row(params)) == params
    # A valid-until that closes nothing (at or before the range end) is none, not a half-cell.
    none = grid.build(grid.Cell("N", "12:17", {**base, "range": 30, "valid": 30}))
    assert none.legs[0].range_breakout.valid_until is None


def test_stage2_exit_before_an_hour_is_excluded() -> None:
    assert grid.excluded("14:17", {"exit": "13:00"})
    assert grid.excluded("14:17", {"exit": "14:30"})
    assert grid.excluded("14:17", {"exit": "15:17"}) is None
    assert grid.excluded("12:17", {"exit": "13:00"})
    assert grid.excluded("12:17", {"exit": "14:30"}) is None
    assert all(grid.excluded(s, {"exit": "15:14"}) is None for s in grid.SLOTS)


def test_chains_cover_every_axis_value() -> None:
    for axis, values in grid.AXES.items():
        covered = {v for chain in grid.CHAINS[axis] for v in chain}
        assert covered == set(values), axis
