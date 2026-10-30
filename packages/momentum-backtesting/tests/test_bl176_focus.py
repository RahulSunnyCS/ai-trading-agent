"""BL-176 Stage 2: the focus space is derived from Stage 1 results by the registered rule."""

import importlib.util
import json
from pathlib import Path

import pytest

from momentum_backtesting import search as sr

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("bl176_focus", ROOT / "scripts" / "bl176_focus.py")
focus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(focus)

SPACE = ROOT / "search_spaces" / "round8_A_curated.toml"


def _row(i: int, lb: float, baskets: list[str], **light) -> dict:
    base = {
        "coverage_floor": 0.05,
        "pool_top_n": 200,
        "pool_exit_rank": 300,
        "category_top_n": 4,
        "category_exit_rank": 8,
        "picks_per_category": 1,
        "max_position": 0.25,
        "max_category": None,
        "rebalance_every": 4,
        "rebalance_offset": 1,
        "entry": "wait",
        "stock_tilt": 0.0,
        "stock_tilt_screen_pct": 0.0,
        "top_sector_weight": 1.0,
        "fill": "mon_open",
    }
    heavy = {
        "lookbacks": [26, 52],
        "weight_scheme": "equal",
        "score": "voladj",
        "voladj_lookbacks": False,
        "voladj_skip": "long",
    }
    return {
        "id": f"r{i:04d}",
        "heavy": heavy,
        "light": {**base, **light},
        "metrics": {"cagr": 0.3},
        "rank": {"lb_fy_excess": lb, "fy_excess": {}, "baskets": baskets},
    }


def _write(tmp_path: Path, rows: list[dict]) -> Path:
    folder = tmp_path / "results"
    folder.mkdir()
    (folder / "results-1.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return folder


def test_a_basket_needs_twenty_top_runs_to_qualify(tmp_path):
    rows = [_row(i, i / 1000, ["medium"]) for i in range(399)]  # top 5% = 20
    kept, report = focus.pool(rows, ["conservative", "medium", "aggressive"])
    assert report == {"conservative": 0, "medium": 20, "aggressive": 0}
    assert {r["id"] for r in kept} == {f"r{i:04d}" for i in range(379, 399)}
    few = [_row(i, i / 1000, ["medium"]) for i in range(300)]  # top 5% = 15
    assert focus.pool(few, ["medium"])[0] == []


def test_ranges_are_the_tenth_to_ninetieth_percentile_and_choices_need_ten_percent(tmp_path):
    space = sr.load_space(SPACE)
    rows = [
        _row(
            i,
            1.0,
            ["medium"],
            pool_top_n=100 + i,
            pool_exit_rank=100 + i + 50,
            fill="mon_close" if i < 3 else "next_fri_close",
        )
        for i in range(40)
    ]
    out = focus.derive(space, rows)
    lo, hi = out["light"]["pool_top_n"][1]
    assert (lo, hi) == (103, 136)  # 10th 103.9 -> 103, 90th 135.1 -> 136
    assert out["light"]["pool_band"] == ("int", [50, 50])  # exit minus top
    assert out["light"]["fill"] == ("choice", ["next_fri_close"])  # 3 of 40 < 10%
    assert out["light"]["rebalance_offset_raw"] == ("int", [0, 3])  # never narrowed
    assert out["heavy"]["lookbacks"] == [(26, 52)]
    assert out["combos"] == 1 and out["light_per"] == 500


def test_the_script_writes_a_space_that_loads_and_says_when_nothing_qualifies(tmp_path, capsys):
    rows = [_row(i, i / 1000, ["aggressive"]) for i in range(400)]
    out = tmp_path / "focus.toml"
    assert focus.main([str(_write(tmp_path, rows)), "--space", str(SPACE), "--out", str(out)]) == 0
    loaded = sr.load_space(out)
    assert loaded.arm == "A" and loaded.fixed["category_tags"] == "curated"
    assert dict((d.name, d.values) for d in loaded.light)["fill"] == ("mon_open",)
    empty = tmp_path / "empty"
    (tmp_path / "e").mkdir()
    rows = [_row(i, 0.1, ["medium"]) for i in range(10)]
    (tmp_path / "e" / "results-1.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    assert focus.main([str(tmp_path / "e"), "--space", str(SPACE), "--out", str(empty)]) == 0
    assert not empty.exists() and "gets no Stage 2" in capsys.readouterr().out


@pytest.mark.parametrize("value", [None, True, "x", [1, 2], (26, 52), 0.25])
def test_toml_values_round_trip(tmp_path, value):
    import tomllib

    text = f"v = {focus.toml_value(value)}"
    got = tomllib.loads(text)["v"]
    expected = "none" if value is None else list(value) if isinstance(value, tuple) else value
    assert got == expected
