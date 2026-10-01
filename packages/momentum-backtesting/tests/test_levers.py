"""Research levers (TODO 3.9.23 Step 1): rank tables, no_buy masks, overlays, tax-aware hold."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import levers
from momentum_backtesting.engine import BENCHMARK, CASH, Config, compute_ranks, run_backtest
from momentum_backtesting.tax import TaxRules

WEEKS = pd.date_range("2016-01-01", periods=120, freq="W-FRI")


def walk(seed: int, names: list[str], drift: float = 0.002) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        {n: 100 * np.cumprod(1 + rng.normal(drift, 0.03, len(WEEKS))) for n in names}, WEEKS
    )


def test_skip_month_ranks_equal_plain_ranks_on_lagged_prices():
    prices = walk(1, ["A", "B", "C", "D"])
    config = Config(top_n=1, exit_rank=2)
    ranks, _ = levers.skip_month_ranks(prices, config)
    expected, _ = compute_ranks(
        prices.shift(4), Config(top_n=1, exit_rank=2, lookbacks=(9, 22, 48))
    )
    pd.testing.assert_frame_equal(ranks, expected)


def test_skip_month_ignores_the_last_four_weeks():
    prices = walk(2, ["A", "B", "C"])
    bumped = prices.copy()
    bumped.iloc[-3:, 0] *= 3  # a late spike in A must not change this week's skip-month rank
    a, _ = levers.skip_month_ranks(prices, Config(top_n=1, exit_rank=2))
    b, _ = levers.skip_month_ranks(bumped, Config(top_n=1, exit_rank=2))
    pd.testing.assert_series_equal(a.iloc[-1], b.iloc[-1])


def test_high52_proximity_and_mask():
    s = pd.Series([100.0] * 51 + [120.0, 90.0], index=WEEKS[:53])
    prox = levers.high52_proximity(s.to_frame("A"))["A"]
    assert prox.iloc[:51].isna().all()
    assert prox.iloc[51] == 1.0 and prox.iloc[52] == pytest.approx(0.75)
    mask = levers.below_high52_mask(s.to_frame("A"))["A"]
    assert not mask.iloc[51] and mask.iloc[52]


def test_high52_ranks_prefer_names_near_their_high():
    prices = walk(3, ["A", "B", "C", "D"])
    ranks, _ = levers.high52_ranks(prices, Config(top_n=1, exit_rank=2))
    assert set(ranks.iloc[-1].dropna()) == {1.0, 2.0, 3.0, 4.0}


def test_choppy_mask_blocks_a_jumpy_gainer():
    smooth = pd.Series(100 * 1.01 ** np.arange(60), index=WEEKS[:60])
    jumpy = pd.Series(np.where(np.arange(60) % 10 == 0, 1.3, 0.995), index=WEEKS[:60]).cumprod()
    mask = levers.choppy_mask(pd.DataFrame({"smooth": smooth, "jumpy": jumpy}))
    assert not mask["smooth"].iloc[-1]
    assert mask["jumpy"].iloc[-1]


def test_trend_and_breadth_gates_block_every_name_in_weak_weeks():
    up = pd.Series(np.linspace(100, 200, len(WEEKS)), index=WEEKS)
    down = up.iloc[::-1].set_axis(WEEKS)
    prices = pd.DataFrame({"A": up, "B": up * 2})
    assert not levers.trend_gate_mask(prices, up).any().any()
    weak = levers.trend_gate_mask(prices, down)
    assert weak.iloc[-1].all() and not weak.iloc[0].any()
    assert levers.breadth_gate_mask(pd.DataFrame({"A": down, "B": down})).iloc[-1].all()
    assert not levers.breadth_gate_mask(prices).iloc[-1].any()


def test_high_vol_mask_flags_the_most_volatile_name():
    rng = np.random.default_rng(4)
    prices = pd.DataFrame(
        {
            f"N{i}": 100 * np.cumprod(1 + rng.normal(0, 0.01 * (i + 1), len(WEEKS)))
            for i in range(5)
        },
        WEEKS,
    )
    mask = levers.high_vol_mask(prices)
    assert mask.iloc[-1]["N4"] and not mask.iloc[-1]["N0"]


class _Result:
    def __init__(self, equity, cash):
        self.equity, self.cash, self.benchmark = equity, cash, cash
        self.trades = pd.DataFrame()


def test_vol_target_never_levers_up_and_cuts_exposure_in_wild_weeks():
    rng = np.random.default_rng(6)
    rets = np.concatenate([rng.normal(0.003, 0.01, 60), rng.normal(0.0, 0.08, 60)])
    equity = pd.Series(np.cumprod(1 + rets), index=WEEKS)
    cash = pd.Series(1.001 ** np.arange(len(WEEKS)), index=WEEKS)
    curve = levers.vol_target(_Result(equity, cash), target=0.2, cost_pct=0.0)
    assert curve.exposure.max() <= 1.0
    assert curve.exposure.iloc[-1] < 0.5
    assert curve.exposure.iloc[30] == 1.0  # calm stretch: full exposure
    assert curve.equity.iloc[0] == 1.0


def test_full_exposure_overlay_reproduces_the_curve():
    equity = pd.Series(1.01 ** np.arange(len(WEEKS)), index=WEEKS)
    cash = pd.Series(1.001 ** np.arange(len(WEEKS)), index=WEEKS)
    curve = levers.vol_target(_Result(equity, cash), target=10.0)
    assert np.allclose(curve.equity, equity / equity.iloc[0])


# --- tax-aware exit hold (engine change, experiment 6) -------------------------------------------

HOLD_WEEKS = pd.date_range("2016-01-01", periods=70, freq="W-FRI")


def hold_case(**overrides):
    names = ["A", "B", "C", "D"]
    prices = pd.DataFrame({n: 100 * 1.003 ** np.arange(len(HOLD_WEEKS)) for n in names}, HOLD_WEEKS)
    prices[CASH] = 100 * 1.001 ** np.arange(len(HOLD_WEEKS))
    prices[BENCHMARK] = prices[CASH]
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0, "D": 4.0}, index=HOLD_WEEKS)
    ranks.loc[HOLD_WEEKS[50] :, "A"] = 4.0  # A slips just past exit_rank 3 at week 50 (~350 days)
    ranks.loc[HOLD_WEEKS[50] :, "D"] = 1.0
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "defensive"}
    classes = {n: "equity" for n in names} | {CASH: "debt", BENCHMARK: "debt"}
    config = Config(
        start="2016-01-01", top_n=1, exit_rank=3, cost_pct=0.0, tax=TaxRules(), **overrides
    )
    return run_backtest(prices, includes, config, classes, external_ranks=(ranks, ranks))


def sold_week(result, asset):
    sells = result.trades[(result.trades["action"] == "SELL") & (result.trades["asset"] == asset)]
    return sells["week"].iloc[0]


def test_tax_hold_waits_for_long_term_then_sells():
    assert sold_week(hold_case(), "A") == HOLD_WEEKS[50]
    held = hold_case(tax_hold_band=2, tax_hold_weeks=8)
    assert sold_week(held, "A") > HOLD_WEEKS[52]  # past 365 days
    assert (sold_week(held, "A") - HOLD_WEEKS[0]).days > 365


def test_tax_hold_is_inert_when_the_slip_is_beyond_the_band():
    assert sold_week(hold_case(tax_hold_band=0, tax_hold_weeks=8), "A") == HOLD_WEEKS[50]


def test_tax_hold_validation_and_label():
    with pytest.raises(ValueError):
        Config(tax_hold_band=-1)
    assert Config(tax_hold_band=3, tax_hold_weeks=8).label.endswith("_taxhold3w8")
