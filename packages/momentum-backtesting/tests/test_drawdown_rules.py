"""BL-025's drawdown-rule test: the registered mechanics and the three look-ahead checks."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import choose
from momentum_backtesting import drawdown_rules as dr

CANDS = {c.label: c for c in dr.candidates()}


def weeks(n: int) -> pd.DatetimeIndex:
    return pd.date_range("2017-01-06", periods=n, freq="W-FRI")


def path(*levels: float) -> np.ndarray:
    return np.asarray(levels, dtype=float)


def test_candidates_come_from_the_criteria_file():
    crit = dr.load_criteria()["candidates"]
    assert list(CANDS) == ["R0", "R1", "R2", "R3", "R4", "R5"]
    assert CANDS["R0"].cut is None and CANDS["R0"].back == "none"
    for label, key in [("R1", "R1_as_written"), ("R5", "R5_owner_band_trend_back")]:
        assert CANDS[label].cut == crit[key]["cut_half_at"]
        assert CANDS[label].exit == crit[key]["exit_at"]
    assert CANDS["R3"].sma_weeks == crit["R3_trend_back"]["sma_weeks"] == CANDS["R5"].sma_weeks
    assert CANDS["R4"].rebound == crit["R4_rebound_back"]["rebound"]
    assert "N" not in CANDS  # listed, never scored


def test_cut_then_exit_from_the_same_high():
    curve = path(100, 110, 95, 87, 80, 76, 90)  # high 110: -20% at 88, -30% at 77
    sizes, actions = dr.decide(curve, CANDS["R1"])
    assert sizes.tolist() == [1, 1, 1, 0.5, 0.5, 0, 0]
    assert [(a.i, a.kind) for a in actions] == [(3, "cut"), (5, "exit")]


def test_a_week_crossing_both_lines_goes_straight_to_zero():
    sizes, actions = dr.decide(path(100, 100, 65, 70), CANDS["R1"])
    assert sizes.tolist() == [1, 1, 0, 0]
    assert [(a.kind, a.before, a.after) for a in actions] == [("exit", 1.0, 0.0)]


def test_r0_never_acts_and_r1_never_comes_back():
    curve = path(100, 60, 50, 120, 200)
    assert dr.decide(curve, CANDS["R0"])[0].tolist() == [1] * 5
    assert dr.decide(curve, CANDS["R1"])[0].tolist() == [1, 0, 0, 0, 0]


def test_r2_back_at_the_high_then_the_high_restarts():
    curve = path(100, 79, 85, 100, 110, 87, 86)
    sizes, actions = dr.decide(curve, CANDS["R2"])
    # cut at 79; back when it closes at 100 (the high it was measured from); then the high is
    # 110 and 87 is -20.9%: cut again
    assert [(a.i, a.kind) for a in actions] == [(1, "cut"), (3, "back"), (5, "cut")]
    assert sizes.tolist() == [1, 0.5, 0.5, 1, 1, 0.5, 0.5]


def test_r4_back_twenty_percent_above_the_low_since_the_action():
    curve = path(100, 75, 60, 70, 71.99, 72, 70)
    sizes, actions = dr.decide(curve, CANDS["R4"])
    # 75 is past the cut line only; 60 is past the exit; 72 is 20% over the low of 60
    assert [(a.i, a.kind) for a in actions] == [(1, "cut"), (2, "exit"), (5, "back")]
    assert sizes.tolist() == [1, 0.5, 0, 0, 0, 1, 1]


def test_high_restarts_at_the_close_of_the_return_friday():
    # R4 comes back at 72 (20% over 60) while 28% below the old high; the next 20% fall is
    # measured from 72, not from 100
    curve = path(100, 60, 72, 57, 56)
    sizes, actions = dr.decide(curve, CANDS["R4"])
    assert [(a.i, a.kind) for a in actions] == [(1, "exit"), (2, "back"), (3, "cut")]
    assert sizes.tolist() == [1, 0, 1, 0.5, 0.5]


def _sma_curve() -> np.ndarray:
    up = np.linspace(100, 140, 45)  # 45 closes, so the 40-week average exists
    down = np.array([110, 105, 103, 102, 101])  # -20% from 140 is 112: cut at 110, no exit
    rise = np.linspace(100, 130, 12)
    return np.concatenate([up, down, rise])


def test_r3_needs_a_close_below_the_average_then_a_close_above_it():
    curve = _sma_curve()
    sizes, actions = dr.decide(curve, CANDS["R3"])
    assert actions[0].kind == "cut" and actions[0].i == 45
    back = [a for a in actions if a.kind == "back"]
    assert back, "the rising curve crosses back above its average"
    t = back[0].i
    avg = curve[t - 39 : t + 1].mean()
    assert curve[t] > avg
    prev = t - 1
    assert curve[prev] <= curve[prev - 39 : prev + 1].mean()  # the first Friday above it


def test_r3_cannot_come_back_before_forty_closes_exist():
    curve = np.concatenate([[100, 75], np.linspace(76, 300, 30)])  # 32 closes only
    sizes, actions = dr.decide(curve, CANDS["R3"])
    assert [a.kind for a in actions] == ["cut"]
    assert sizes[-1] == 0.5


def test_r3_when_already_above_the_average_at_the_action():
    # a fall so fast the curve is still above its 40-week average on the cut Friday: it must
    # close below the average before a close above it brings it back
    curve = np.concatenate([np.linspace(50, 200, 60), [158, 159, 161]])
    sizes, actions = dr.decide(curve, CANDS["R3"])
    avg = curve[60 - 39 : 61].mean()
    assert curve[60] > avg  # above the average when cut
    assert [a.kind for a in actions] == ["cut"]  # never closed below it, so never back


def test_unregistered_exit_and_way_back_on_the_same_friday():
    # at half size, a Friday that meets both the exit line and the way back has no registered
    # order: the run stops. (A test candidate whose way back is always met makes the case.)
    with pytest.raises(dr.Unregistered):
        dr.decide(path(100, 79, 65), dr.Candidate("RX_test", 0.2, 0.3, "rebound", rebound=-0.5))


# --- look-ahead -------------------------------------------------------------------------------


def _random_curve(seed: int, n: int = 300) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return 100 * np.exp(np.cumsum(rng.normal(0.004, 0.06, n)))


@pytest.mark.parametrize("label", ["R1", "R2", "R3", "R4", "R5"])
def test_lookahead_check_2_changed_future_same_actions(label):
    cand = CANDS[label]
    for seed in range(5):
        curve = _random_curve(seed)
        full, actions = dr.decide(curve, cand)
        assert actions, "the random curve should trigger the rules"
        for t in (40, 97, 150, 233):
            other = curve.copy()
            other[t + 1 :] = _random_curve(seed + 100, len(curve) - t - 1) * other[t] / 50
            sizes, acts = dr.decide(other, cand)
            assert np.array_equal(sizes[: t + 1], full[: t + 1])
            assert [a for a in acts if a.i <= t] == [a for a in actions if a.i <= t]


@pytest.mark.parametrize("label", ["R1", "R2", "R3", "R4", "R5"])
def test_lookahead_check_1_prefix(label):
    assert dr.prefix_check(_random_curve(7, 160), CANDS[label]) == []


def test_lookahead_check_3_size_set_at_t_applies_from_t_plus_one():
    w = weeks(4)
    model = pd.Series([100, 100, 200, 200.0], index=w)
    cash = pd.Series([1, 1.01, 1.02, 1.03], index=w)
    sizes = np.array([1, 0, 0, 0.0])  # decided at position 1: the doubling t1 -> t2 is missed
    money = dr.simulate(model, cash, sizes, capital=100)
    assert money.value.iloc[1] == pytest.approx(100)  # the return ending at 1 was at full size
    assert money.value.iloc[2] == pytest.approx(100 * 1.02 / 1.01)
    assert money.in_force.tolist()[1:] == [1, 0, 0]
    late = dr.simulate(model, cash, dr.delayed(sizes), capital=100)
    assert late.value.iloc[2] == pytest.approx(200)  # a week late: the doubling is kept


def test_half_size_drifts_until_the_next_change():
    w = weeks(5)
    model = pd.Series([100, 100, 150, 75, 75.0], index=w)
    cash = pd.Series(1.0, index=w)
    sizes = np.array([0.5, 0.5, 0.5, 1, 1])
    money = dr.simulate(model, cash, sizes, capital=100)
    # 50 invested, 50 cash; invested 75 then 37.5; back to full at position 3: all 87.5 in
    assert money.value.tolist() == pytest.approx([100, 100, 125, 87.5, 87.5])
    assert [(t.before, t.after) for t in money.trades] == [(1, 0.5), (0.5, 1)]


def test_the_last_fridays_decision_books_no_trade():
    w = weeks(3)
    money = dr.simulate(
        pd.Series([1, 1, 1.0], index=w), pd.Series(1.0, index=w), np.array([1, 1, 0.0])
    )
    assert money.trades == []


# --- holdings, costs, tax ---------------------------------------------------------------------


def _component() -> dr.Component:
    w = weeks(3)
    trades = pd.DataFrame(
        [
            dict(week=w[0], action="BUY", asset="AAA", units=0.5, value=0.5, cost=0.0),
            dict(week=w[0], action="BUY", asset="BBB", units=0.25, value=0.5, cost=0.0),
            dict(week=w[1], action="TRIM", asset="AAA", units=0.25, value=0.3, cost=0.0),
        ]
    )
    weights = pd.DataFrame(
        {"AAA": [0.5, 0.25, 0.3], "BBB": [0.5, 0.5, 0.4], "Idle cash": [0, 0.25, 0.3]}, index=w
    )
    return dr.Component(pd.Series([1.0, 1.2, 1.25], index=w), weights, trades, {})


def test_lots_rebuilt_from_the_trade_log():
    comp = _component()
    lots = comp.lots_at(weeks(3)[1])
    assert lots["AAA"][0]["units"] == pytest.approx(0.25)
    assert lots["AAA"][0]["basis"] == pytest.approx(0.25)
    assert lots["BBB"][0]["units"] == pytest.approx(0.25)


def test_costs_and_tax_of_a_cut():
    comp = _component()
    w = weeks(3)
    book = dr.Book([comp], pd.DataFrame({0: 1.0}, index=w), dr.Rates(15.0))
    cost, sold = book.sell_cost(w[2], 0.5, 200_000)
    assert sold == pytest.approx(0.5 * 200_000 * 0.7)  # the idle share is not sold
    assert cost == pytest.approx(
        sold * book.rates.sell + 2 * 16 + (sold - sold * book.rates.sell - 32) * 0.00005
    )
    tax = book.sale_tax(w[2], 0.5, 200_000)
    # k = 200000 / 1.25; AAA value 0.375 over basis 0.25, BBB 0.5 over 0.5, both short-term
    k = 200_000 / 1.25
    gains = 0.5 * k * ((0.375 * (1 - book.rates.sell) - 0.25) + (0.5 * (1 - book.rates.sell) - 0.5))
    assert tax == pytest.approx(gains * 0.20 * 1.04)


def test_blend_shares_reproduce_the_ensemble_curve():
    rng = np.random.default_rng(3)
    w = pd.date_range("2017-01-06", periods=200, freq="W-FRI")
    curves = pd.DataFrame(np.exp(np.cumsum(rng.normal(0.003, 0.04, (200, 4)), axis=0)), index=w)
    curves = curves / curves.iloc[0]
    blend = choose.ensemble_curve(curves, list(curves.columns))
    shares = dr.blend_shares(curves)
    assert np.allclose(shares.sum(axis=1), 1)
    r = curves.pct_change().iloc[1:]
    rebuilt = (1 + (shares.shift(1).iloc[1:].to_numpy() * r.to_numpy()).sum(axis=1)).cumprod()
    assert np.allclose(rebuilt, (blend / blend.iloc[0]).iloc[1:].to_numpy())


# --- the verdict rule -------------------------------------------------------------------------


def _scores(spec: dict) -> dict:
    objects = ["sleeve_0", "blend", "ramp_a", "ramp_b", "ramp_c"]
    out = {}
    for cand, (fall, give, cagr) in spec.items():
        out[cand] = {
            o: {"worst_fall": fall, "give_up_pts": give, "cagr": cagr, "end_wealth": cagr}
            for o in objects
        }
    return out


def test_judge_names_the_simplest_within_one_point_of_the_best():
    crit = dr.load_criteria()
    scores = _scores(
        {
            "R0_hold_through": (-0.40, 0.0, 0.35),
            "R1_as_written": (-0.30, 20.0, 0.10),
            "R2_back_at_the_high": (-0.30, 2.5, 0.325),
            "R3_trend_back": (-0.30, 1.0, 0.34),
            "R4_rebound_back": (-0.36, 0.5, 0.345),
            "R5_owner_band_trend_back": (-0.33, 3.0, 0.32),
        }
    )
    out = dr.judge(scores, crit, ["ramp_a", "ramp_b", "ramp_c"])
    v = {c[:2]: r["verdict"] for c, r in out["candidates"].items()}
    assert v == {"R0": "kill", "R1": "kill", "R2": "pass", "R3": "pass", "R4": "kill", "R5": "pass"}
    assert out["best_end_wealth"] == "R3_trend_back"
    # R2 is 1.5 points behind R3, R5 2: only R3 is within one point
    assert out["named"] == "R3_trend_back"


def test_judge_ramp_median_not_judged_below_three_qualifying():
    crit = dr.load_criteria()
    scores = _scores({"R0_hold_through": (-0.30, 0.0, 0.3), "R2_back_at_the_high": (-0.3, 2, 0.28)})
    scores["R2_back_at_the_high"]["ramp_a"]["give_up_pts"] = 9.0
    out = dr.judge(scores, crit, ["ramp_a"])
    row = out["candidates"]["R2_back_at_the_high"]
    assert row["ramp_median_judged"] is False and row["verdict"] == "pass"
    assert out["r0_passes_a"] is True


def test_delay_of_zero_and_late_actions():
    sizes = np.array([1.0, 0.5, 0.5, 0.0])
    assert np.array_equal(dr.delayed(sizes, 0), sizes)
    acts = [dr.Action(1, "cut", 1.0, 0.5), dr.Action(3, "exit", 0.5, 0.0)]
    assert dr.delayed_actions(acts, len(sizes)) == [dr.Action(2, "cut", 1.0, 0.5)]
