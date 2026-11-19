"""BL-236: a due lot that holds shares trades what its sleeve's backtest trades (an equal split of
what is freed over what the sleeve buys), not the difference to the sleeve's end weights."""

from momentum_backtesting import lots, orders

PRICES = {
    "CUPID": 366.0,
    "NAZARA": 426.0,
    "ACMESOLAR": 409.0,
    "GRWRHITECH": 7790.0,
    "ATHER": 1925.0,
    "PVR": 1700.0,
    "SOUTH": 60.0,
    "SANSERA": 4720.0,
}
# What the sleeve bought this week, best rank first: ATHER (rank 5) at 1.5x, the rest equal.
SLICES = {"SOUTH": 1.0, "PVR": 1.0, "ATHER": 1.5, "SANSERA": 1.0}
KEEP = frozenset({"CUPID", "NAZARA", "GRWRHITECH"})
HELD = {"ACMESOLAR": 35.0, "CUPID": 42.0, "GRWRHITECH": 2.0, "NAZARA": 33.0}


def rows(plan):
    return {r.symbol: r for r in plan.rows}


def test_the_proceeds_of_a_name_the_sleeve_dropped_are_split_by_the_sleeves_weights():
    plan = orders.plan_equal_split(HELD, PRICES, SLICES, keep=KEEP, cash=15_000.0)
    by = rows(plan)
    assert by["ACMESOLAR"].action == "SELL" and by["ACMESOLAR"].quantity == 35
    # kept names are left alone: no trim to a drifted end weight, no top-up
    for name in KEEP:
        assert by[name].action == "" and by[name].quantity == 0
    # budget = 35 x 409 + 15,000 less the sell charges, split 1 : 1 : 1.5 : 1
    budget = 35 * 409.0 + 15_000.0 - by["ACMESOLAR"].charges
    assert by["ATHER"].quantity == int(budget * 1.5 / 4.5 // 1925.0)
    assert by["SOUTH"].quantity == int(budget / 4.5 // 60.0)
    assert plan.cash_after >= 0


def test_a_slice_under_one_share_is_skipped_and_the_leftover_buys_it_in_rank_order():
    plan = orders.plan_equal_split(HELD, PRICES, SLICES, keep=KEEP, cash=0.0)
    by = rows(plan)
    assert by["SANSERA"].action == "SKIP" and by["SANSERA"].note.startswith("less than one share")
    orders.use_leftover(plan, list(SLICES))
    # 14,315 - ATHER, SOUTH, PVR slices leave enough for one SANSERA only if it fits
    assert plan.cash_after >= 0


def test_no_minimum_applies_to_a_slice_but_a_cap_trim_keeps_it():
    held = {"CUPID": 100.0, "NAZARA": 10.0}
    prices = {"CUPID": 100.0, "NAZARA": 100.0, "SOUTH": 60.0}
    # CUPID is 10,000 of 11,000 (91%): over the 25% + 5% band, trim to 25% of the lot
    args = {"keep": frozenset(held), "max_position": 0.25, "cap_band": 0.05}
    plan = orders.plan_equal_split(held, prices, {"SOUTH": 1.0}, min_trade_rs=5_000.0, **args)
    assert rows(plan)["CUPID"].action == "TRIM" and rows(plan)["CUPID"].quantity == 72
    # the trim funds the buy, which has no minimum and stops at the 25% cap (2,750 / 60 = 45)
    assert rows(plan)["SOUTH"].action == "BUY" and rows(plan)["SOUTH"].quantity == 45
    # a trim worth less than the minimum is skipped, as for any held name
    small = orders.plan_equal_split(held, prices, {"SOUTH": 1.0}, min_trade_rs=10_000.0, **args)
    assert rows(small)["CUPID"].action == "SKIP"


def test_a_held_name_in_the_slices_is_topped_up_and_never_pushed_past_the_cap():
    held = {"CUPID": 10.0}
    prices = {"CUPID": 100.0, "SOUTH": 60.0}
    plan = orders.plan_equal_split(
        held,
        prices,
        {"CUPID": 1.0, "SOUTH": 1.0},
        keep=frozenset(held),
        cash=9_000.0,
        max_position=0.25,
    )
    by = rows(plan)
    # CUPID is 1,000 of 10,000 (10%): room to 2,500 only; the rest of its half goes to SOUTH
    assert by["CUPID"].action == "ADD" and by["CUPID"].quantity == 15
    assert by["SOUTH"].action == "BUY" and by["SOUTH"].quantity > 15


def test_a_blocked_name_is_held_and_its_slice_goes_to_the_others():
    held = {"ACMESOLAR": 35.0}
    plan = orders.plan_equal_split(
        held, PRICES, {"SOUTH": 1.0, "PVR": 1.0}, keep=frozenset(), cash=0.0, blocked={"SOUTH"}
    )
    by = rows(plan)
    assert by["SOUTH"].action in ("", "SKIP") and by["SOUTH"].quantity == 0
    assert by["PVR"].quantity == 8  # all of 14,315 less charges, 1,700 each


def test_plan_lots_uses_the_equal_split_for_a_rebalancing_lot_and_the_old_rule_without_slices():
    held = {"ACMESOLAR": 35.0, "CUPID": 42.0}
    name_of = {n: n for n in PRICES}
    common = dict(
        id="s1",
        label="Lot 1",
        name="Lot 1",
        due=True,
        next_due="2026-12-18",
        positions=held,
        target={"CUPID": 0.5, "SOUTH": 0.5},
        has_history=True,
    )
    for slices, rule in (
        (SLICES, "equal"),
        (None, "target"),
    ):
        lot = lots.Lot(**common, slices=slices, keep=frozenset({"CUPID"}) if slices else None)
        out = lots.plan_lots(
            [lot],
            name_of=name_of,
            prices=PRICES,
            free_cash=0.0,
            lot_size=50_000.0,
            min_trade_rs=10_000.0,
        )
        assert out["lots"][0]["rule"] == rule
    # equal: ACMESOLAR sold in full, CUPID untouched
    lot = lots.Lot(**common, slices=SLICES, keep=frozenset({"CUPID"}))
    out = lots.plan_lots(
        [lot],
        name_of=name_of,
        prices=PRICES,
        free_cash=0.0,
        lot_size=50_000.0,
        min_trade_rs=10_000.0,
    )
    plan = {r["symbol"]: r for r in out["lots"][0]["plan"]["rows"]}
    assert plan["ACMESOLAR"]["action"] == "SELL" and plan["CUPID"]["quantity"] == 0


def test_the_leftover_buys_a_held_name_whose_slice_was_under_a_share_in_rank_order():
    held = {"CUPID": 10.0}
    prices = {"CUPID": 366.0, "SANSERA": 4720.0, "PVR": 1700.0}
    # CUPID (rank 1, held) and SANSERA both get a slice under their price; PVR is not affordable
    plan = orders.plan_equal_split(
        held,
        prices,
        {"CUPID": 1.0, "SANSERA": 1.0, "PVR": 1.0},
        keep=frozenset(held),
        cash=1_000.0,
    )
    orders.use_leftover(plan, ["CUPID", "SANSERA", "PVR"])
    by = rows(plan)
    assert by["CUPID"].action == "ADD" and by["CUPID"].quantity >= 1
    assert plan.cash_after >= 0


def test_the_recipe_drops_a_name_the_engine_sold_even_when_it_still_ranks_inside_the_exit_rank():
    import pandas as pd

    from momentum_backtesting import api

    week = pd.Timestamp("2026-11-20")
    result = type("R", (), {})()
    result.weights = pd.DataFrame({"CUPID": [0.5], "NEW": [0.5]}, index=[week])
    acted = pd.DataFrame(
        [
            {"asset": "SOLD", "action": "SELL", "rank": None, "value": 1.0},
            {"asset": "NEW", "action": "BUY", "rank": 2.0, "value": 2.0},
        ]
    )
    ranks = pd.Series({"SOLD": 5.0, "CUPID": 4.0, "NEW": 2.0, "FAR": 90.0})
    req = type("Q", (), {"broad_category_exit_rank": 19, "max_position": 0.25, "cap_band": 0.05})()
    recipe = api._equal_split_recipe(req, result, acted, ranks, week)
    assert recipe["keep"] == ["CUPID", "NEW"]  # SOLD ranks 5 but was sold; FAR is outside
    assert recipe["slices"] == {"NEW": 2.0}
