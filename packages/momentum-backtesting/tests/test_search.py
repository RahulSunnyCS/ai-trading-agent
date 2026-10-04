"""Search runner: sampling, feasibility, planning and profile selection (no market data needed)."""

import numpy as np
import pandas as pd

from momentum_backtesting import search as sr


def _space(tmp_path, body: str) -> sr.Space:
    path = tmp_path / "space.toml"
    path.write_text(body)
    return sr.load_space(path)


SPACE = """
name = "t"
arm = "A"
[fixed]
start = "2017-01-01"
[heavy]
lookbacks = { choice = [[1, 4, 13], [4, 13, 26]] }
score = { choice = ["ranksum", "voladj"] }
[light]
pool_top_n = { int = [50, 250] }
pool_band = { int = [0, 100] }
category_top_n = { int = [3, 10] }
category_band = { int = [0, 8] }
max_position = { choice = [0.2, 0.35, "none"] }
cap_band = { float = [0.02, 0.1] }
"""


def test_halton_is_in_range_deterministic_and_covers_evenly():
    a = sr.halton(64, 3, np.random.default_rng(7))
    b = sr.halton(64, 3, np.random.default_rng(7))
    assert a.shape == (64, 3) and np.array_equal(a, b)
    assert ((a >= 0) & (a < 1)).all()
    # Low discrepancy: every quarter of each axis gets close to a quarter of the points.
    for d in range(3):
        counts = np.histogram(a[:, d], bins=4, range=(0, 1))[0]
        assert counts.min() >= 14 and counts.max() <= 18


def test_dim_pick_covers_the_whole_range_including_the_top_end():
    assert sr.Dim("x", "int", (3, 5)).pick(0.0) == 3
    assert sr.Dim("x", "int", (3, 5)).pick(0.999999) == 5
    assert sr.Dim("x", "choice", ("a", "b")).pick(0.999999) == "b"
    assert sr.Dim("x", "float", (0.0, 1.0)).pick(0.5) == 0.5


def test_none_string_becomes_none(tmp_path):
    space = _space(tmp_path, SPACE)
    cap = next(d for d in space.light if d.name == "max_position")
    assert None in cap.values


def test_load_space_rejects_unknown_and_misplaced_parameters(tmp_path):
    for bad in (
        '[light]\nscore = { choice = ["ranksum"] }',  # a ranking parameter, not a light one
        "[light]\nnot_a_param = { int = [1, 2] }",
        "[heavy]\npool_top_n = { choice = [100] }",
    ):
        try:
            _space(tmp_path, 'name = "t"\narm = "A"\n' + bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def test_plan_is_deterministic_feasible_and_has_unique_ids(tmp_path):
    space = _space(tmp_path, SPACE)
    one = sr.plan(space, heavy_count=3, light_count=12, seed=5)
    assert one == sr.plan(space, heavy_count=3, light_count=12, seed=5)
    assert one != sr.plan(space, heavy_count=3, light_count=12, seed=6)
    ids = [r["id"] for g in one for r in g["runs"]]
    assert len(ids) == len(set(ids))
    assert len(one) == 3 and all(len(g["runs"]) == 12 for g in one)
    for group in one:
        for run in group["runs"]:
            merged = {**space.fixed, **run["light"]}
            assert sr.feasible("A", merged)
            assert merged["pool_exit_rank"] >= merged["pool_top_n"]
            assert merged["category_exit_rank"] >= merged["category_top_n"]


def test_heavy_combinations_returns_the_whole_product_when_small(tmp_path):
    space = _space(tmp_path, SPACE)
    assert len(sr.heavy_combinations(space, 100, 1)) == 4
    assert len(sr.heavy_combinations(space, 3, 1)) == 3


def test_changing_a_fixed_setting_changes_the_run_id():
    base = sr.run_id("A", {"x": 1}, {"y": 2}, {"start": "2017-01-01"})
    assert base == sr.run_id("A", {"x": 1}, {"y": 2}, {"start": "2017-01-01"})
    assert base != sr.run_id("A", {"x": 1}, {"y": 2}, {"start": "2019-01-01"})
    assert base != sr.run_id("B", {"x": 1}, {"y": 2}, {"start": "2017-01-01"})


def test_feasible_blocks_caps_that_hold_cash_back_and_impossible_pools():
    ok = {"pool_top_n": 100, "pool_exit_rank": 150, "category_top_n": 5, "category_exit_rank": 8}
    assert sr.feasible("A", {**ok, "max_position": 0.35})
    assert not sr.feasible("A", {**ok, "max_position": 0.1})  # 0.1 * 5 slots < 1
    assert not sr.feasible("A", {**ok, "pool_top_n": 200})  # exit below top
    assert not sr.feasible(
        "A", {**ok, "picks_per_category": 3, "pool_top_n": 10, "pool_exit_rank": 20}
    )
    assert not sr.feasible("A", {**ok, "category_exit_rank": 41})
    off = {"pool_top_n": 100, "pool_exit_rank": 150, "off_top_n": 10, "off_exit_rank": 20}
    assert sr.feasible("B", {**off, "max_position": 0.35})
    assert not sr.feasible("B", {**off, "max_position": 0.05})


def test_resolve_light_derives_exit_ranks_and_offsets():
    space = sr.Space("t", "A", {}, (), ())
    out = sr.resolve_light(
        space,
        {"pool_top_n": 100, "pool_band": 50, "rebalance_every": 4, "rebalance_offset_raw": 6},
    )
    assert out["pool_exit_rank"] == 150 and "pool_band" not in out
    assert out["rebalance_offset"] == 2  # 6 % 4


def test_weights_for_schemes():
    assert sr.weights_for("equal", 3) is None
    assert sr.weights_for("recent", 3) == (3.0, 2.0, 1.0)
    assert sr.weights_for("long", 3) == (1.0, 2.0, 3.0)


def _row(**kw):
    base = {
        "error": None,
        "cagr": 0.2,
        "mdd": -0.3,
        "bench_mdd": -0.35,
        "turnover_x": 2.0,
        "buys_per_yr": 50.0,
    }
    return {**base, **kw}


def test_profile_tables_apply_the_drawdown_multiples_and_turnover_cap():
    df = pd.DataFrame(
        [
            _row(id="hi_dd", cagr=0.40, mdd=-0.60),  # deeper than 1.5 x 0.35 = 0.525
            _row(id="mid", cagr=0.30, mdd=-0.45),  # inside 1.5x, outside 1.0x
            _row(id="low", cagr=0.25, mdd=-0.30),  # inside 1.0x
            _row(id="busy", cagr=0.50, mdd=-0.30, turnover_x=9.0),
        ]
    )
    tables = sr.profile_tables(df, max_turnover=5.0)
    assert list(tables["aggressive"]["id"]) == ["hi_dd", "mid", "low"]
    assert list(tables["balanced"]["id"]) == ["mid", "low"]
    assert list(tables["defensive"]["id"]) == ["low"]


def test_run_metrics_on_a_simple_curve():
    idx = pd.date_range("2018-01-05", periods=400, freq="7D")

    class R:
        equity = pd.Series(np.linspace(1.0, 2.0, 400), index=idx)
        benchmark = pd.Series(np.linspace(1.0, 1.5, 400), index=idx)
        cash = pd.Series(np.linspace(1.0, 1.1, 400), index=idx)
        weights = pd.DataFrame({"Idle cash": np.full(400, 0.1)}, index=idx)
        trades = pd.DataFrame({"action": ["BUY", "SELL", "BUY"], "value": [0.2, 0.2, 0.2]})

    m = sr.run_metrics(R, "Idle cash")
    assert m["mdd"] == 0.0 and m["cagr"] > m["bench_cagr"] > 0
    assert m["idle_share"] == 0.1 and m["roll3y_beat"] == 1.0
    assert m["turnover_x"] > 0 and m["weeks"] == 400


def test_sealed_from_requires_an_earlier_end_date(tmp_path):
    sealed = SPACE.replace('name = "t"', 'name = "t"\nsealed_from = "2023-01-01"')
    for bad in (
        sealed,
        sealed.replace('start = "2017-01-01"', 'start = "2017-01-01"\nend = "2023-06-30"'),
    ):
        try:
            _space(tmp_path, bad)
        except ValueError as error:
            assert "sealed_from" in str(error)
        else:
            raise AssertionError("accepted a space that could see the sealed period")
    ok = sealed.replace('start = "2017-01-01"', 'start = "2017-01-01"\nend = "2022-12-31"')
    assert _space(tmp_path, ok).sealed_from == "2023-01-01"


def test_underwater_stats_measure_depth_duration_and_recovery():
    from momentum_backtesting import metrics

    idx = pd.date_range("2020-01-03", periods=12, freq="7D")
    # up, drop to 0.7, climb back over 5 weeks to a new high, then a shallow dip left open
    curve = pd.Series([1.0, 1.1, 1.2, 1.0, 0.84, 0.9, 1.0, 1.1, 1.21, 1.3, 1.25, 1.27], index=idx)
    stats = metrics.underwater_stats(curve)
    assert (
        stats["max_underwater_weeks"] == 5
    )  # weeks 3..7 are below the 1.2 peak; week 8 is a new high
    assert stats["recovered"] == 1.0 and stats["recovery_weeks"] == 4  # trough week 4 -> week 8
    assert 0 < stats["underwater_share_5"] < 1 and stats["ulcer"] > 0
    flat_up = metrics.underwater_stats(pd.Series(np.linspace(1, 2, 20)))
    assert flat_up["max_underwater_weeks"] == 0 and flat_up["ulcer"] == 0
    never = metrics.underwater_stats(pd.Series([1.0, 1.2, 0.8, 0.85, 0.9]))
    assert never["recovered"] == 0.0 and never["recovery_weeks"] == 2
