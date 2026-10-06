"""Round 3 helpers: candidate choice, the nudges, and the survive/fail verdict."""

import numpy as np
import pandas as pd

from momentum_backtesting import robust, search


def _space(arm: str = "A") -> search.Space:
    """A small space of the round 7 arm A shape."""
    return search.Space(
        name="t",
        arm=arm,
        fixed={"start": "2017-01-01"},
        heavy=(
            search.Dim("lookbacks", "choice", ((13, 26), (13, 26, 52), (4, 13, 26))),
            search.Dim("score", "choice", ("voladj", "blend", "ranksum")),
        ),
        light=(
            search.Dim("coverage_floor", "float", (0.0, 0.3)),
            search.Dim("pool_top_n", "int", (30, 350)),
            search.Dim("pool_band", "int", (0, 200)),
            search.Dim("category_top_n", "int", (1, 8)),
            search.Dim("category_band", "int", (0, 8)),
            search.Dim("picks_per_category", "int", (1, 3)),
            search.Dim("max_position", "choice", (0.2, 0.25, 0.35, 0.5, None)),
            search.Dim("rebalance_every", "choice", (1, 2, 4)),
            search.Dim("rebalance_offset_raw", "int", (0, 3)),
            search.Dim("entry", "choice", ("wait", "make_room")),
            search.Dim("stock_tilt", "choice", (0.0, 0.5, 1.0)),
        ),
    )


def _rec(**light):
    base = {
        "coverage_floor": 0.15,
        "pool_top_n": 100,
        "pool_exit_rank": 160,
        "category_top_n": 5,
        "category_exit_rank": 7,
        "picks_per_category": 2,
        "max_position": 0.25,
        "rebalance_every": 4,
        "rebalance_offset": 1,
        "entry": "wait",
        "stock_tilt": 0.5,
    }
    return {
        "id": "x",
        "heavy": {"lookbacks": [13, 26, 52], "score": "voladj"},
        "light": {**base, **light},
    }


def test_every_searched_dimension_is_nudged():
    kinds = {n["kind"] for n in robust.nudges(_rec(), _space())}
    searched = {d.name for d in (*_space().heavy, *_space().light)} - {"rebalance_offset_raw"}
    assert kinds == searched | {"offset", "start"}


def test_numbers_move_a_tenth_of_their_range_and_choices_by_order_or_all():
    found = {}
    for n in robust.nudges(_rec(), _space()):
        found.setdefault(n["kind"], []).append(n)
    assert sorted(n["light"]["coverage_floor"] for n in found["coverage_floor"]) == [0.12, 0.18]
    assert sorted(n["light"]["pool_top_n"] for n in found["pool_top_n"]) == [68, 132]
    assert sorted(n["light"]["max_position"] for n in found["max_position"]) == [0.2, 0.35]
    assert sorted(n["heavy"]["score"] for n in found["score"]) == ["blend", "ranksum"]
    assert sorted(map(tuple, (n["heavy"]["lookbacks"] for n in found["lookbacks"]))) == [
        (4, 13, 26),
        (13, 26),
    ]
    assert [n["light"]["entry"] for n in found["entry"]] == ["make_room"]
    assert sorted(n["light"]["stock_tilt"] for n in found["stock_tilt"]) == [0.0, 1.0]


def test_bands_and_tops_move_without_changing_each_other():
    found = {}
    for n in robust.nudges(_rec(), _space()):
        found.setdefault(n["kind"], []).append(n["light"])
    for light in found["pool_top_n"]:  # the band of 60 is kept
        assert light["pool_exit_rank"] - light["pool_top_n"] == 60
    for light in found["pool_band"]:  # the top is kept
        assert light["pool_top_n"] == 100 and light["pool_exit_rank"] in (140, 180)
    for light in found["category_band"]:
        assert light["category_top_n"] == 5 and light["category_exit_rank"] in (6, 8)


def test_nudges_stay_in_range_skip_infeasible_ones_and_never_repeat_the_base():
    edge = _rec(
        coverage_floor=0.0,
        picks_per_category=1,
        max_position=None,
        category_top_n=2,
        category_exit_rank=2,
    )
    found = robust.nudges(edge, _space())
    assert all(n["light"]["coverage_floor"] >= 0.0 for n in found)
    assert all(n["light"]["picks_per_category"] >= 1 for n in found)
    assert [n["light"]["max_position"] for n in found if n["kind"] == "max_position"] == [0.5]
    # With a 50% cap, one category fewer would leave half the money unplaceable: skipped.
    capped = robust.nudges({**edge, "light": {**edge["light"], "max_position": 0.5}}, _space())
    assert not [n for n in capped if n["light"]["category_top_n"] == 1]
    assert all(search.feasible("A", n["light"]) for n in found)
    for n in robust.nudges(_rec(), _space()):
        assert (n["light"], n["heavy"], n["window"]) != (_rec()["light"], _rec()["heavy"], {})


def test_offset_nudges_cover_every_other_day_of_the_cycle():
    offsets = [
        n["light"]["rebalance_offset"]
        for n in robust.nudges(_rec(), _space())
        if n["kind"] == "offset"
    ]
    assert sorted(offsets) == [0, 2, 3]  # every 4 weeks, currently offset 1
    weekly = robust.nudges(_rec(rebalance_every=1, rebalance_offset=0), _space())
    assert not [n for n in weekly if n["kind"] == "offset"]


def test_an_arm_without_categories_is_nudged_too():
    space = search.Space(
        name="b",
        arm="B",
        fixed={},
        heavy=(search.Dim("score", "choice", ("voladj", "blend")),),
        light=(
            search.Dim("pool_top_n", "int", (20, 300)),
            search.Dim("off_top_n", "int", (3, 25)),
            search.Dim("off_band", "int", (0, 25)),
        ),
    )
    rec = {
        "id": "b",
        "heavy": {"score": "voladj"},
        "light": {"pool_top_n": 100, "pool_exit_rank": 150, "off_top_n": 10, "off_exit_rank": 15},
    }
    kinds = {n["kind"] for n in robust.nudges(rec, space)}  # used to raise KeyError
    assert {"score", "pool_top_n", "off_top_n", "off_band", "start"} <= kinds


def test_start_shifts_stay_inside_the_tuning_window():
    starts = [n["window"]["start"] for n in robust.nudges(_rec(), _space()) if n["kind"] == "start"]
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


def test_bands_and_tops_use_values_the_space_fixed():
    space = search.Space(
        name="f",
        arm="A",
        fixed={"category_top_n": 4, "pool_exit_rank": 300},
        heavy=(),
        light=(
            search.Dim("category_band", "int", (0, 8)),
            search.Dim("pool_top_n", "int", (30, 350)),
        ),
    )
    rec = {
        "id": "f",
        "heavy": {},
        "light": {"category_exit_rank": 7, "pool_top_n": 200, "picks_per_category": 1},
    }
    found = {}
    for n in robust.nudges(rec, space):
        found.setdefault(n["kind"], []).append(n["light"])
    assert sorted(light["category_exit_rank"] for light in found["category_band"]) == [6, 8]
    for light in found["pool_top_n"]:  # the fixed band of 100 is kept
        assert light["pool_exit_rank"] - light["pool_top_n"] == 100
