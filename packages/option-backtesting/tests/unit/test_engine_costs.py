from option_backtesting.engine.costs import flat_cost


def test_flat_cost_is_lots_times_two_legs_times_per_leg_rt() -> None:
    # matches the reference: cost = len(ev) * 2 * COST_PER_LEG, here folded
    # into total_lots (a Fill's lots multiplier stands in for len(ev) when
    # every fill is 1 lot; total_lots generalizes it for multi-lot fills).
    assert flat_cost(total_lots=4, per_leg_rt=60.0) == 480.0


def test_zero_lots_is_zero_cost() -> None:
    assert flat_cost(total_lots=0, per_leg_rt=60.0) == 0.0


def test_legs_per_lot_is_overridable() -> None:
    assert flat_cost(total_lots=2, per_leg_rt=60.0, legs_per_lot=1) == 120.0
