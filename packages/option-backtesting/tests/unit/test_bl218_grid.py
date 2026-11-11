"""BL-218: the registered grid's size and SHA, and that every cell builds a valid strategy."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research" / "bl218"))

import grid  # noqa: E402


def test_registered_counts_and_sha():
    assert {f: len(grid.cells(f)) for f in grid.FAMILIES} == {
        "dir": 96, "widesl": 96, "rb_m": 288, "rb_e": 288, "tb_m": 288, "tb_e": 324,
    }  # fmt: skip
    assert grid.grid_sha() == "88bc794621b0ee32"


def test_every_cell_builds_on_every_root_and_season():
    for cell in grid.all_cells():
        for root in grid.ROOTS:
            for season in ("summer", "winter"):
                s = grid.build(cell, root, season)
                assert s.execution.slippage_pct == 1.0


def test_session_exits_and_underlying_breakout_sides():
    rb = next(c for c in grid.cells("rb_e") if c.p["source"] == "underlying")
    s = grid.build(rb, "CRUDEOILM", "winter")
    assert s.exit_time == "23:40"
    assert {leg.option_type: leg.range_breakout.side for leg in s.legs} == {
        "CE": "high",
        "PE": "low",
    }
    assert grid.build(grid.cells("tb_m")[0], "GOLDM", "summer").exit_time == "16:55"
    assert grid.build(grid.cells("dir")[1], "GOLDM", "summer").exit_time == "23:15"


def test_neighbours_step_one_axis():
    c = grid.cells("dir")[0]
    for n in grid.neighbours(c):
        assert sum(a != b for a, b in zip(c.params, n.params, strict=True)) == 1
