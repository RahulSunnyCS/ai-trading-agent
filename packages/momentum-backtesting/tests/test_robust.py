"""Round 3 helpers: candidate choice, the nudges, and the survive/fail verdict."""

import numpy as np
import pandas as pd

from momentum_backtesting import robust


def _rec(**light):
    base = {
        "coverage_floor": 0.15,
        "pool_top_n": 100,
        "pool_exit_rank": 160,
        "category_top_n": 5,
        "category_exit_rank": 9,
        "picks_per_category": 2,
        "max_position": 0.25,
        "rebalance_every": 4,
        "rebalance_offset": 1,
    }
    return {
        "id": "x",
        "heavy": {"lookbacks": [13, 26, 52], "score": "voladj"},
        "light": {**base, **light},
    }


def test_nudges_cover_each_kind_and_keep_the_bands():
    kinds = {n["kind"] for n in robust.nudges(_rec())}
    assert kinds == {
        "floor",
        "pool",
        "cats",
        "picks",
        "reb",
        "offset",
        "maxpos",
        "score",
        "lookbacks",
        "start",
    }
    pool = [n for n in robust.nudges(_rec()) if n["kind"] == "pool"]
    for n in pool:  # exit rank moves with the top so the band width stays 60
        assert n["light"]["pool_exit_rank"] - n["light"]["pool_top_n"] == 60
    cats = [n for n in robust.nudges(_rec()) if n["kind"] == "cats"]
    for n in cats:
        assert n["light"]["category_exit_rank"] - n["light"]["category_top_n"] == 4


def test_nudges_respect_limits_and_never_return_the_base_config():
    edge = robust.nudges(
        _rec(
            coverage_floor=0.05,
            picks_per_category=1,
            category_top_n=3,
            category_exit_rank=7,
            max_position=0.35,
        )
    )
    floors = [n["light"]["coverage_floor"] for n in edge if n["kind"] == "floor"]
    assert min(floors) >= 0.05 and 0.05 not in floors
    assert all(n["light"]["picks_per_category"] >= 1 for n in edge)
    assert all(n["light"]["category_top_n"] >= 3 for n in edge)
    for n in robust.nudges(_rec()):
        assert (n["light"], n["heavy"], n["window"]) != (_rec()["light"], _rec()["heavy"], {})


def test_offset_nudges_cover_every_other_day_of_the_cycle():
    offsets = [
        n["light"]["rebalance_offset"] for n in robust.nudges(_rec()) if n["kind"] == "offset"
    ]
    assert sorted(offsets) == [0, 2, 3]  # every 4 weeks, currently offset 1
    weekly = robust.nudges(_rec(rebalance_every=1, rebalance_offset=0))
    assert not [n for n in weekly if n["kind"] == "offset"]


def test_start_shifts_stay_inside_the_tuning_window():
    starts = [n["window"]["start"] for n in robust.nudges(_rec()) if n["kind"] == "start"]
    assert starts == list(robust.START_SHIFTS) and all(s < "2022-12-31" for s in starts)


def test_pick_candidates_mixes_groups_and_drops_overtraded_runs():
    n = 300
    rng = np.random.default_rng(1)
    df = pd.DataFrame(
        {
            "id": [f"r{i}" for i in range(n)],
            "error": [None] * n,
            "cagr": rng.uniform(0.05, 0.40, n),
            "mdd": -rng.uniform(0.10, 0.40, n),
            "roll3y_worst": rng.uniform(-0.05, 0.2, n),
            "turnover_x": rng.uniform(0.1, 4, n),
            "buys_per_yr": 40.0,
        }
    )
    picked = robust.pick_candidates(df, top=20)
    assert 0 < len(picked) <= 20 and picked.id.is_unique
    assert (picked.turnover_x <= 3).all() and (picked.mdd >= -0.26).any()


def test_verdict_flags_a_candidate_that_collapses_when_nudged():
    def rows(cid, nudged_cagr):
        out = [
            {
                "cid": cid,
                "kind": "base",
                "label": "base",
                "error": None,
                "cagr": 0.35,
                "mdd": -0.2,
                "turnover_x": 1.0,
                "roll3y_worst": 0.1,
                "hurdle": 0.19,
            }
        ]
        for kind in ("floor", "pool", "cats", "picks", "reb", "offset", "start"):
            for _ in range(3):
                out.append(
                    {
                        "cid": cid,
                        "kind": kind,
                        "label": kind,
                        "error": None,
                        "cagr": nudged_cagr,
                        "mdd": -0.22,
                        "turnover_x": 1.0,
                        "roll3y_worst": 0.05,
                        "hurdle": 0.19,
                    }
                )
        return out

    v = robust.verdicts(pd.DataFrame(rows("steady", 0.30) + rows("lucky", 0.10)))
    by = v.set_index("cid")
    assert bool(by.loc["steady", "survives"]) and not bool(by.loc["lucky", "survives"])
    assert by.loc["steady", "nudge_p25"] > by.loc["lucky", "nudge_p25"]
