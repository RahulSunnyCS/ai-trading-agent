"""BL-176 Stage 3: a tag ranking's arms are chosen among as one pool of scored curves."""

import json

import numpy as np
import pandas as pd

from momentum_backtesting import method

WEEKS = pd.date_range("2018-01-05", periods=8, freq="W-FRI")


def _arm(root, name, ids):
    results, scored = root / name, root / f"{name}_scored"
    results.mkdir()
    scored.mkdir()
    recs = [
        {"id": i, "heavy": {"lookbacks": [13, 26]}, "light": {"rebalance_every": 1}} for i in ids
    ]
    (results / "results-1.jsonl").write_text("\n".join(json.dumps(r) for r in recs))
    (scored / "scores-000.jsonl").write_text(
        "\n".join(json.dumps({"id": i, "every": 1, "cagr": 0.1}) for i in ids)
    )
    curves = pd.DataFrame({i: np.linspace(1, 2, len(WEEKS)) for i in ids}, index=WEEKS)
    curves.astype("float32").to_parquet(scored / "curves-000.parquet")
    return results, scored


def test_arms_pool_into_one_set_and_a_config_scored_twice_is_kept_once(tmp_path):
    a = _arm(tmp_path, "A", ["a1", "a2"])
    b = _arm(tmp_path, "B", ["b1", "a2"])  # a2 also scored under B (as arm B enters both rankings)
    scores, curves, records = method.load_pooled([a, b])
    assert sorted(curves.columns) == ["a1", "a2", "b1"]
    assert sorted(scores.index) == ["a1", "a2", "b1"]
    assert set(records) == {"a1", "a2", "b1"}
    assert curves.index.equals(WEEKS)


def test_nudges_never_tilt_a_lookback_set_the_tilt_cannot_use():
    from pathlib import Path

    from momentum_backtesting import robust, search

    space = search.load_space(
        Path(__file__).resolve().parents[1] / "search_spaces" / "round8_A_curated.toml"
    )
    run = search.plan(space, 1, 1, seed=3)[0]
    heavy = {**run["heavy"], "lookbacks": [26, 52], "score": "blend"}
    light = {**run["runs"][0]["light"], "stock_tilt": 0.0, "stock_tilt_screen_pct": 0.0}
    rec = {"heavy": heavy, "light": light}
    out = robust.nudges(rec, space)
    assert not [n for n in out if n["kind"] in ("stock_tilt", "stock_tilt_screen_pct")]

    tilted = {"heavy": {**heavy, "lookbacks": [13, 26]}, "light": {**light, "stock_tilt": 0.5}}
    for n in robust.nudges(tilted, space):
        if not search.tilt_possible(n["heavy"]["lookbacks"]):
            assert n["light"]["stock_tilt"] == 0.0


def test_config_facts_reads_a_direct_rank_config():
    """Arm B (no category layer) is pooled with the category arms in one ranking: its holdings
    are its direct top N, and it counts as no categories in the simplicity tie-break."""
    from momentum_backtesting import choose

    heavy = {"lookbacks": [13, 26]}
    records = {
        "a": {
            "heavy": heavy,
            "light": {
                "category_top_n": 5,
                "picks_per_category": 2,
                "pool_top_n": 300,
                "rebalance_every": 4,
            },
        },
        "b": {"heavy": heavy, "light": {"off_top_n": 12, "pool_top_n": 40, "rebalance_every": 1}},
        "b_small_pool": {
            "heavy": heavy,
            "light": {"off_top_n": 25, "pool_top_n": 20, "rebalance_every": 2},
        },
    }
    facts = choose.config_facts(records)
    assert facts.at["a", "holdings"] == 10
    assert facts.at["b", "holdings"] == 12
    assert facts.at["b_small_pool", "holdings"] == 20
    assert facts.at["b", "simplicity"][1] == 0


def test_arm_pairs_parses_also_and_refuses_a_bare_path(tmp_path):
    import pytest
    import typer

    from momentum_backtesting import cli

    a, s = tmp_path / "A", tmp_path / "A_scored"
    pairs = cli._arm_pairs(a, s, [f"{tmp_path / 'B'}={tmp_path / 'B_scored'}"])
    assert pairs == [(a, s), (tmp_path / "B", tmp_path / "B_scored")]
    assert cli._arm_pairs(a, s, None) == [(a, s)]
    with pytest.raises(typer.BadParameter):
        cli._arm_pairs(a, s, [str(tmp_path / "B")])


def test_ensemble_refuses_freeze_with_pooled_arms(tmp_path):
    from typer.testing import CliRunner

    from momentum_backtesting import cli

    done = CliRunner().invoke(
        cli.app,
        [
            "search",
            "ensemble",
            str(tmp_path),
            "--space",
            str(tmp_path / "x.toml"),
            "--freeze",
            "--also",
            f"{tmp_path}={tmp_path}",
        ],
    )
    assert done.exit_code == 1
    assert "frozen apart" in done.output
