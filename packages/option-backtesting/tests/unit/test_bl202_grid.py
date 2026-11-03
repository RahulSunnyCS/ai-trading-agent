"""BL-202: the registered Buy grid is what Phase 0 says it is.

Every cell must validate through the legwise schema (no cell is silently dropped by the runner),
the counts are the registered ones, the SHA is the one recorded in the backlog item, every cell
carries the registered slippage, and each cohort's template cell is the rotation file untouched
but for that slippage.
"""

from __future__ import annotations

import csv
import importlib.util
import json
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


# --- the runner's resume signature and part round trip -------------------------------------


def _load_sibling(filename: str, name: str):
    """Load a bl202 script that does a bare `import grid`. Another research folder's `grid`
    (bl104's) may already sit in sys.modules under that name when the whole suite runs, so the
    script is pointed at this folder's grid while it imports, and the old entry put back."""
    spec = importlib.util.spec_from_file_location(name, GRID_PY.with_name(filename))
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    previous = sys.modules.get("grid")
    sys.modules["grid"] = grid
    try:
        spec.loader.exec_module(module)
    finally:
        if previous is None:
            sys.modules.pop("grid", None)
        else:
            sys.modules["grid"] = previous
    return module


def _load_runner():
    return _load_sibling("run_grid.py", "bl202_run_grid")


def test_signature_is_the_days_run_not_the_to_flag(tmp_path: Path) -> None:
    import argparse
    from datetime import date

    import numpy as np

    runner = _load_runner()
    days = [date(2024, 10, 9), date(2024, 10, 10)]
    job = ("N", "09:17", [None, {"x": 1}], days, str(tmp_path), 1.0)
    today = argparse.Namespace(start="2024-10-09", end="2026-11-03")
    later = argparse.Namespace(start="2024-10-09", end="2026-11-05")
    assert runner.signature(today, job) == runner.signature(later, job)
    sig = runner.signature(today, job)
    assert sig["to"] == "2024-10-10" and sig["n_days"] == 2 and sig["n_cells"] == 2
    assert sig["slippage"] == 1.0 and sig["grid"] == grid.grid_sha()
    # A part written with that signature is reused; one from another run is not.
    result = {
        "rows": [{"cohort": "B_N_0917", "label": "a", "net_inr": 1.0}],
        "matrix": np.zeros((2, 1), dtype=np.float32),
        "aux": {
            "stopped": np.zeros((2, 1), dtype=np.uint8),
            "win_sum": np.zeros((2, 1), dtype=np.float32),
            "loss_sum": np.zeros((2, 1), dtype=np.float32),
            "charges": np.zeros((2, 1), dtype=np.float32),
        },
        "labels": ["a"],
        "days": [d.isoformat() for d in days],
        "skipped": {},
        "run": sig,
    }
    runner.write_part(tmp_path, "B_N_0917", result)
    assert runner.part_matches(tmp_path, "B_N_0917", sig)
    assert set(np.load(tmp_path / "series" / "B_N_0917.aux.npz").files) == set(result["aux"])
    assert not runner.part_matches(tmp_path, "B_N_0917", {**sig, "slippage": 0.0})
    assert not runner.part_matches(tmp_path, "B_S_0917", sig)


# --- the scorer: the half split, the bootstrap, the drawdown and the gates -------------------


def _load_scorer():
    return _load_sibling("score.py", "bl202_score")


def test_half_split_is_at_fit_to() -> None:
    import numpy as np

    score = _load_scorer()
    days = np.array(["2025-10-07", "2025-10-08", "2025-10-09"], dtype="datetime64[D]")
    assert score.half_mask(days, "fit").tolist() == [True, True, False]
    assert score.half_mask(days, "test").tolist() == [False, False, True]
    assert score.half_mask(days, "all").all()


def test_drawdown_and_ulcer_match_the_runner() -> None:
    import numpy as np

    score, runner = _load_scorer(), _load_runner()
    rng = np.random.default_rng(1)
    net = rng.normal(-20, 800, size=(120, 7))
    dd, ulcer = score.drawdown_stats(net)
    for j in range(net.shape[1]):
        values = net[:, j].tolist()
        assert dd[j] == pytest.approx(runner.max_drawdown(values)[0])
        assert ulcer[j] == pytest.approx(runner.ulcer_index(values))


def test_bootstrap_is_paired_seeded_and_bounded() -> None:
    import numpy as np

    score = _load_scorer()
    n = 247
    counts = score.block_starts(n)
    assert counts.shape == (score.BOOTSTRAP["resamples"], n)
    # Every resample draws ceil(n / block) blocks of `block` days.
    blocks = -(-n // score.BOOTSTRAP["block"])
    assert np.all(counts.sum(axis=1) == blocks * score.BOOTSTRAP["block"])
    assert np.array_equal(counts, score.block_starts(n))  # the seed makes it reproducible
    rng = np.random.default_rng(2)
    net = rng.normal(50, 1000, size=(n, 3))
    net[:, 2] = 7.0  # a constant series has a lower bound equal to itself
    means = score.bootstrap_means(net, counts)
    lb = score.lower_bound(means)
    assert lb[2] == pytest.approx(7.0)
    assert (lb[:2] < net[:, :2].mean(axis=0)).all()
    # Paired: the lower bound of a difference is the bound of the same resamples' differences.
    diff = score.lower_bound(means - means[:, [2]])
    assert diff[2] == pytest.approx(0.0)
    assert diff[0] == pytest.approx(lb[0] - 7.0)


def test_gates_are_the_registered_ones() -> None:
    score = _load_scorer()
    good = {
        "n_days": 240,
        "sessions": 247,
        "entry_hit_rate": 0.5,
        "net_inr": 1.0,
        "profit_factor": 1.2,
        "stop_frequency": 0.3,
        "worst5_inr": -8000.0,
    }
    assert score.failed_gates(good) == []
    assert score.failed_gates({**good, "n_days": 200}) == ["coverage"]
    assert score.failed_gates({**good, "entry_hit_rate": 0.39}) == ["entry_hit_rate"]
    assert score.failed_gates({**good, "net_inr": 0.0}) == ["net"]
    assert score.failed_gates({**good, "profit_factor": 1.04}) == ["profit_factor"]
    assert score.failed_gates({**good, "stop_frequency": 0.61}) == ["stop_frequency"]
    assert score.failed_gates({**good, "worst5_inr": -15001.0}) == ["worst5"]
    assert score.failed_gates({**good, "stop_frequency": 0.6, "worst5_inr": -15000.0}) == []


def test_neighbours_follow_the_chains() -> None:
    score = _load_scorer()
    params = grid.cells("N", "09:17", with_template=False)[0].params
    assert params["trail"] is None
    keys = score.neighbour_keys(params)
    trails = {dict(k)["trail"] for k in keys if dict(k)["trail"] != params["trail"]}
    # None sits on both chains: next to [1,1]pts and next to [20,10]%.
    assert trails == {("pts", 1, 1), ("pct", 20, 10)}
    pts3 = score.neighbour_keys({**params, "trail": ("pts", 3, 1)})
    assert {dict(k)["trail"] for k in pts3 if dict(k)["trail"] != ("pts", 3, 1)} == {("pts", 1, 1)}


def test_test_half_needs_a_finalist_list(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    score = _load_scorer()
    monkeypatch.setattr(sys, "argv", ["score.py", "--tag", "nothing", "--half", "test"])
    with pytest.raises(SystemExit, match="finalists"):
        score.main()


# --- Stage 2: the template base and the generator ---------------------------------------------


def _load_stage2():
    return _load_sibling("stage2.py", "bl202_stage2")


STAGE2_FULL = {
    "exit": "15:28",
    "gap": 2.0,
    "valid": 60,
    "stop_on": "close",
    "reentry": ("cost", 1),
    "peak": (150, 70),
}


def test_template_base_applies_only_the_stage2_axes() -> None:
    """The Stage-2 template base keeps the rotation file's own Stage-1 values (SL 25 %, premium
    ₹50, the 1/1-point trail unscaled on SENSEX) and applies the Stage-2 keys alone."""
    template = grid.build(grid.Cell("S", "09:17", None))
    s = grid.build(grid.Cell("S", "09:17", {"base": "template", **STAGE2_FULL}))
    leg = s.legs[0]
    assert s.exit_time == "15:28"
    assert leg.strike.closest_premium == template.legs[0].strike.closest_premium == 50
    assert leg.stop_loss.percent == 25 and leg.trail_sl.points == (1.0, 1.0)
    assert leg.range_breakout.until == template.legs[0].range_breakout.until == "09:27"
    assert leg.range_breakout.gap_percent == 2.0 and leg.range_breakout.valid_until == "10:17"
    assert leg.stop_on == "close" and leg.reentry_on_sl.count == 1
    assert leg.trail_peak.activate_percent == 150
    assert s.execution.slippage_pct == grid.SLIPPAGE_PCT
    # Under Stage 2's defaults the template base IS the template cell.
    defaults = {"base": "template", "exit": "15:14", "gap": 0.0, "valid": None, "stop_on": "tick"}
    same = grid.build(grid.Cell("S", "09:17", defaults))
    assert same.model_dump(exclude={"id"}) == template.model_dump(exclude={"id"})
    params = {"base": "template", **STAGE2_FULL}
    row = grid.params_to_row(params)
    assert row["p_strike"] == "" and json.loads(row["p_extra"])["base"] == "template"
    assert grid.params_from_row(row) == {**dict.fromkeys(grid.AXES), **params}
    assert grid.grid_sha() == "5f6d9595a141c13c"  # the template path changed no registered value


def test_stage2_expand_counts_and_duplicates() -> None:
    stage2 = _load_stage2()
    cell = grid.cells("N", "09:17", with_template=False)[0]
    morning, dropped = stage2.expand({"index": "N", "params": cell.params}, "09:17")
    assert len(morning) == 288 and dropped == {
        "exit_before_min_hold": 0,
        "valid_until_collapses": 0,
    }
    assert sum(stage2.is_default(c["params"]) for c in morning) == 1
    late, dropped = stage2.expand({"index": "N", "params": None}, "14:17")
    # 13:00 and 14:30 are out; valid-until 60 / 120 past the 15:14 exit, and 120 past 15:28,
    # would be the same strategy as none, so they are not cells either.
    assert len(late) == 72
    assert dropped == {"exit_before_min_hold": 144, "valid_until_collapses": 72}
    assert all(c["params"]["base"] == "template" for c in late)
    for c in late:
        grid.build(grid.Cell("N", "14:17", c["params"]))  # every cell validates


def _ranked_rows(cohort: str, index: str, slot: str, labels_ranked: list[tuple[str, bool]]):
    """Synthetic B_ranked_fit.csv rows: (label suffix | 'template', candidate) in rank order."""
    rows = []
    cells = grid.cells(index, slot, with_template=False)
    for rank, (which, candidate) in enumerate(labels_ranked, start=1):
        params = None if which == "template" else cells[int(which)].params
        row = {
            "cohort": cohort,
            "index": index,
            "slot": slot,
            "label": grid.Cell(index, slot, params).label,
            **grid.params_to_row(params),
            "candidate": str(candidate),
            "passes": str(candidate),
            "cohort_rank": str(rank),
        }
        for field in (
            "robust",
            "lb_day_inr",
            "avg_day_inr",
            "profit_factor",
            "martin",
            "entry_hit_rate",
            "stop_frequency",
            "worst5_inr",
            "max_drawdown_inr",
            "neighbour_median_lb_inr",
        ):
            row[field] = "1.0"
        rows.append(row)
    return rows


def test_stage2_generate_takes_top_five_once_and_kills(tmp_path: Path, monkeypatch) -> None:
    stage2 = _load_stage2()
    monkeypatch.setattr(stage2, "RESULTS", tmp_path)
    monkeypatch.setattr(stage2, "HERE", tmp_path)
    rows = _ranked_rows(
        "B_N_0917",
        "N",
        "09:17",
        [("0", True), ("1", True), ("template", True)] + [(str(i), True) for i in range(2, 8)],
    )
    rows += _ranked_rows("B_N_1417", "N", "14:17", [("0", False), ("template", False)])
    rows += _ranked_rows("B_S_1417", "S", "14:17", [("0", True), ("template", False)])
    (tmp_path / "stage1").mkdir()
    with (tmp_path / "stage1" / "B_ranked_fit.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    spec = stage2.generate("stage1", 5, "2026-11-03")
    bases = [(b["cohort"], b["label"]) for b in spec["bases"]]
    assert [c for c, _ in bases] == ["B_N_0917"] * 5 + ["B_S_1417"] * 2
    assert sum(label.endswith("_template") for _, label in bases) == 2  # once per cohort
    assert list(spec["killed"]) == ["B_N_1417"]
    assert spec["counts"]["cells"] == 5 * 288 + 2 * 72
    assert spec["counts"]["per_cohort"] == {"B_N_0917": 1440, "B_S_1417": 144}
    committed, out = stage2.write_generated(dict(spec), "2026-11-03")
    assert len(json.loads(out.read_text())) == spec["counts"]["cells"]
    _, cells = stage2.reexpand(committed)
    assert len(cells) == spec["counts"]["cells"]
    edited = json.loads(committed.read_text())
    edited["bases"][0]["params"]["sl"] = 50 if edited["bases"][0]["params"]["sl"] != 50 else 40
    committed.write_text(json.dumps(edited))
    with pytest.raises(SystemExit, match="cells_sha"):
        stage2.reexpand(committed)
