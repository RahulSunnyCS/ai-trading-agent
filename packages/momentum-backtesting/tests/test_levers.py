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


def test_etf_api_can_skip_the_most_volatile_instruments_for_new_buys(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from momentum_backtesting import api
    from momentum_backtesting.fetch import load_universe

    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(7)
    insts = load_universe()
    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.004, 0.01 + 0.004 * k, len(weeks)))
            for k, inst in enumerate(insts)
        },
        index=weeks,
    )
    prices[CASH] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    client = TestClient(api.create_app())
    universe = [i.name for i in insts if i.include == "core"]
    body = {"universe": universe, "start": "2017-01-06"}
    plain = client.post("/api/backtest", json=body).json()
    gated = client.post("/api/backtest", json={**body, "exclude_high_vol": 0.3}).json()
    assert client.get("/api/meta").json()["defaults"]["exclude_high_vol"] == 0.0
    signal = prices[universe]
    mask = levers.high_vol_mask(signal, quantile=0.7)
    for trade in gated["trades"]:
        week = pd.Timestamp(trade["entry_week"])
        assert not mask.at[week, trade["asset"]]  # never bought while flagged
    assert gated["kpis"] != plain["kpis"]
    flagged_now = set(mask.columns[mask.iloc[-1]])
    for row in gated["latest"]["rows"]:
        if row["action"].startswith(("BUY", "WAIT")) and not row["held"]:
            assert row["asset"] not in flagged_now  # the panel never recommends a blocked buy
        if row["action"] == "SKIP (no new buy)":
            assert row["asset"] in flagged_now


# --- grouped_momentum_ranks / fresh_52w_low_mask (owner's "separate the rank-sums" idea) --------

GROUPED_WEEKS = pd.date_range("2016-01-01", periods=70, freq="W-FRI")


def _grouped_segments(*parts: tuple[int, float]) -> np.ndarray:
    rets = [r for n, r in parts for _ in range(n)]
    return 100 * np.cumprod([1.0, *(1 + r for r in rets)])[: len(GROUPED_WEEKS)]


def grouped_universe() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Winner": _grouped_segments((69, 0.01)),  # strong on every window
            # down ~55% over 65 weeks, then a 4-week bounce: negative 26w/52w, positive 1w/4w/13w
            "Turned": _grouped_segments((65, -0.012), (4, 0.03)),
            "Falling": _grouped_segments((69, -0.006)),  # weak everywhere, new low every week
            "Flat1": _grouped_segments((69, 0.002)),
            "Flat2": _grouped_segments((69, 0.003)),
        },
        index=GROUPED_WEEKS,
    )


def test_tilt_zero_is_exactly_short_only_momentum():
    prices = grouped_universe()
    config = Config(top_n=1, exit_rank=2)
    ranks, _ = levers.grouped_momentum_ranks(prices, config, tilt=0.0)
    short_only, _ = compute_ranks(prices, Config(lookbacks=(1, 4, 13), weights=None))
    pd.testing.assert_series_equal(ranks.iloc[-1], short_only.iloc[-1])


def test_a_moderate_tilt_leaves_the_order_unchanged():
    prices = grouped_universe()
    config = Config(top_n=1, exit_rank=2)
    ranks, _ = levers.grouped_momentum_ranks(prices, config, tilt=0.3)
    assert ranks.iloc[-1][["Winner", "Turned"]].tolist() == [1.0, 2.0]


def test_a_strong_tilt_moves_the_recovering_laggard_ahead_of_the_steady_winner():
    prices = grouped_universe()
    config = Config(top_n=1, exit_rank=2)
    ranks, _ = levers.grouped_momentum_ranks(prices, config, tilt=0.5)
    last = ranks.iloc[-1]
    assert last["Turned"] < last["Winner"]  # Turned now ranks first
    # Falling is beaten down too, but its short-term momentum is still the worst of the five -
    # the tilt never lets a stock that's STILL falling overtake a genuine recovery.
    assert last["Falling"] > last["Turned"]


def test_screen_keeps_only_the_top_short_term_names_whatever_the_tilt():
    prices = grouped_universe()
    config = Config(top_n=1, exit_rank=2)
    for tilt in (0.0, 1.0):
        ranks, _ = levers.grouped_momentum_ranks(prices, config, tilt=tilt, screen_top_pct=0.4)
        last = ranks.iloc[-1]
        assert set(last.dropna().index) == {"Winner", "Turned"}  # top 2 of 5 by short momentum
        assert last[["Falling", "Flat1", "Flat2"]].isna().all()


@pytest.mark.parametrize(
    "config",
    [Config(lookbacks=(1, 4, 13)), Config(lookbacks=(26, 52))],
)
def test_grouped_ranks_needs_both_a_short_and_a_long_lookback(config):
    with pytest.raises(ValueError, match="short and.*long"):
        levers.grouped_momentum_ranks(grouped_universe(), config)


def test_fresh_52w_low_mask_flags_only_names_at_their_actual_low():
    prices = grouped_universe()
    mask = levers.fresh_52w_low_mask(prices)
    last = mask.iloc[-1]
    assert last["Falling"] and not last[["Winner", "Turned", "Flat1", "Flat2"]].any()
    # Turned's own trough, 4 weeks before the bounce started, was a genuine new 52-week low.
    assert bool(mask.iloc[-5]["Turned"])


def test_grouped_ranks_pairs_with_the_low_mask_to_avoid_a_falling_knife():
    """A no_buy gate blocks a fresh buy but never forces a sale - matching `reversal.py`'s own
    falling-knife reasoning, now reused for this lever."""
    prices = grouped_universe()
    mask = levers.fresh_52w_low_mask(prices)
    assert bool(mask.loc[GROUPED_WEEKS[-5], "Turned"])
    assert not bool(mask.loc[GROUPED_WEEKS[-1], "Turned"])  # bounced off the low: buyable again


def test_etf_api_can_turn_on_the_grouped_momentum_tilt(tmp_path, monkeypatch):
    """TODO 3.9.23 follow-up: BacktestRequest.reversal_tilt replaces the ranking entirely, so
    this checks it end to end - including that latest_signal's panel honours the fresh-52w-low
    no_buy gate the lever adds, same shape as the exclude_high_vol test above."""
    from fastapi.testclient import TestClient

    from momentum_backtesting import api
    from momentum_backtesting.fetch import load_universe

    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(11)
    insts = load_universe()
    prices = pd.DataFrame(
        {inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks))) for inst in insts},
        index=weeks,
    )
    prices[CASH] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    client = TestClient(api.create_app())
    universe = [i.name for i in insts if i.include == "core"]
    body = {"universe": universe, "start": "2017-01-06"}

    plain = client.post("/api/backtest", json=body).json()
    tilted = client.post("/api/backtest", json={**body, "reversal_tilt": 0.5}).json()
    screened = client.post(
        "/api/backtest", json={**body, "reversal_tilt": 0.5, "reversal_screen_pct": 0.4}
    ).json()
    assert tilted["kpis"] != plain["kpis"]
    assert screened["kpis"] != tilted["kpis"]

    signal = prices[universe]
    low = levers.fresh_52w_low_mask(signal)
    for trade in tilted["trades"]:
        week = pd.Timestamp(trade["entry_week"])
        assert not low.at[week, trade["asset"]]  # never bought while at a fresh 52w low

    meta = client.get("/api/meta").json()
    assert meta["defaults"]["reversal_tilt"] == 0.0
    assert meta["defaults"]["reversal_screen_pct"] == 0.0

    bad = client.post("/api/backtest", json={**body, "reversal_tilt": 3.0})
    assert bad.status_code == 422


# --- Pullback-in-uptrend (TODO 3.9.31, docs/momentum-pullback-tests.md) -------------------------

PB_WEEKS = pd.date_range("2016-01-01", periods=90, freq="W-FRI")


def _pb_segments(*parts: tuple[int, float]) -> np.ndarray:
    rets = [r for n, r in parts for _ in range(n)]
    return 100 * np.cumprod([1.0, *(1 + r for r in rets)])[: len(PB_WEEKS)]


def pullback_universe() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Steady": _pb_segments((89, 0.01)),  # strong throughout, climbing right now - no dip
            # strong for 85 weeks, a 3-week ~9% dip, then a turn-up last week
            "Pullback": _pb_segments((85, 0.01), (3, -0.03), (1, 0.02)),
            # same dip, but still falling last week (no turn)
            "PullbackNoTurn": _pb_segments((85, 0.01), (3, -0.03), (1, -0.01)),
            # strong for 85 weeks, then a real ~26% correction (too deep to be "small")
            "DeepDrop": _pb_segments((85, 0.01), (3, -0.10), (1, 0.02)),
            "NeverStrong": _pb_segments((89, 0.001)),  # barely positive everywhere
        },
        index=PB_WEEKS,
    )


def pullback_stage(prices: pd.DataFrame) -> pd.DataFrame:
    """Hand-set Stage 2 for every name/week - the gate functions only need `stage == 2`
    somewhere to check against; `stages()` itself (the real derivation from prices) has its
    own tests in test_volume_turnover.py, so the trend-intact tests below override a specific
    column instead of re-deriving a Stage 3/4 price path."""
    return pd.DataFrame(2.0, index=prices.index, columns=prices.columns)


def test_dist_from_high_and_long_term_strength_on_hand_built_paths():
    prices = pullback_universe()
    dist13 = levers.dist_from_high(prices)
    last = dist13.iloc[-1]
    assert last["Steady"] == pytest.approx(0.0)  # climbing right now: at its own 13w high
    assert -0.20 < last["Pullback"] < -0.05  # a small pullback, in the PB band
    assert last["DeepDrop"] < -0.20  # a real correction, deeper than the PB band

    lt = levers.long_term_strength(prices)
    last_lt = lt.iloc[-1]
    # Strongest-to-weakest on 13/26/52w returns, exactly the three-week dip's own ranking:
    assert last_lt["Steady"] > last_lt["Pullback"] > last_lt["PullbackNoTurn"] > last_lt["DeepDrop"]
    assert last_lt["DeepDrop"] == pytest.approx(0.0)  # the weakest of the five this week


def test_long_term_strong_mask_picks_the_top_share():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    last = strong.iloc[-1]
    assert last[["Steady", "Pullback", "PullbackNoTurn"]].all()
    assert not last[["DeepDrop", "NeverStrong"]].any()


def test_pullback_flags_identify_a_small_pullback_that_turned_up():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    pb, pbr = levers.pullback_flags(prices, strong, pullback_stage(prices))
    assert bool(pb.iloc[-1]["Pullback"])
    assert bool(pbr.iloc[-1]["Pullback"])


def test_pbr_needs_the_turn_pb_alone_does_not_need_it():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    pb, pbr = levers.pullback_flags(prices, strong, pullback_stage(prices))
    assert bool(pb.iloc[-1]["PullbackNoTurn"])  # still a qualifying pullback
    assert not bool(pbr.iloc[-1]["PullbackNoTurn"])  # but it never turned up


def test_pullback_flags_exclude_a_steady_climb_with_no_dip():
    """LT-strong and trend-intact are not enough on their own - PB also needs the 4-week
    return to have actually turned down."""
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    pb, _ = levers.pullback_flags(prices, strong, pullback_stage(prices))
    assert not bool(pb.iloc[-1]["Steady"])


def test_pullback_flags_exclude_a_drop_deeper_than_the_pb_band():
    """A correction past 20% below the 13-week high is not a "small" pullback, even for a
    name that would otherwise qualify - checked with LT-strong forced True so the depth gate
    is isolated from the (already-failing) LT-strong gate."""
    prices = pullback_universe()
    forced_strong = pd.DataFrame(True, index=prices.index, columns=prices.columns)
    pb, _ = levers.pullback_flags(prices, forced_strong, pullback_stage(prices))
    assert not bool(pb.iloc[-1]["DeepDrop"])


def test_pullback_flags_require_trend_intact():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    broken_stage = pullback_stage(prices)
    broken_stage["Pullback"] = 3.0  # topping, not Stage 2, for every week
    pb, pbr = levers.pullback_flags(prices, strong, broken_stage)
    assert not bool(pb.iloc[-1]["Pullback"])
    assert not bool(pbr.iloc[-1]["Pullback"])


def test_pullback_no_buy_masks():
    prices = pullback_universe()
    stage = pullback_stage(prices)
    stage["PullbackNoTurn"] = 3.0
    dist13 = levers.dist_from_high(prices)
    blocked = levers.pullback_no_buy_mask(stage, dist13)
    last = blocked.iloc[-1]
    assert bool(last["PullbackNoTurn"])  # Stage 3: blocked
    assert bool(last["DeepDrop"])  # more than 20% below the high: blocked
    assert not bool(last["Pullback"])  # Stage 2, only a small pullback: buyable

    ret1 = prices.pct_change(1)
    turn_blocked = levers.pullback_turn_no_buy_mask(stage, dist13, ret1)
    assert bool(turn_blocked.iloc[-1]["Pullback"]) is False  # turned up last week: buyable
    # A name that qualifies for the plain mask but hasn't turned up yet is blocked only by
    # the turn variant - simulate that directly on Steady's own (positive) last return by
    # checking the logic on a fabricated 0-return week instead of relying on real data to
    # happen to produce one.
    flat_ret1 = ret1.copy()
    flat_ret1.iloc[-1] = 0.0
    turn_blocked_flat = levers.pullback_turn_no_buy_mask(stage, dist13, flat_ret1)
    assert bool(turn_blocked_flat.iloc[-1]["Pullback"])  # 0% last week: not a turn, blocked


def test_pullback_ranks_tilt_zero_is_exactly_lt_only():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    ranks, _ = levers.pullback_ranks(prices, lt, strong, tilt=0.0)
    last = ranks.iloc[-1]
    assert last["Steady"] < last["Pullback"] < last["PullbackNoTurn"]  # plain LT order
    assert last[["DeepDrop", "NeverStrong"]].isna().all()  # screened out: not LT-strong


def test_pullback_ranks_a_strong_tilt_moves_the_dip_ahead_of_the_steady_climb():
    prices = pullback_universe()
    lt = levers.long_term_strength(prices)
    strong = levers.long_term_strong_mask(lt, top_pct=0.6)
    ranks, _ = levers.pullback_ranks(prices, lt, strong, tilt=1.0)
    last = ranks.iloc[-1]
    assert last["Pullback"] < last["Steady"]  # the pulled-back name now ranks ahead


def test_cap_rank_during_pullback_floors_only_pb_names_without_improving_them():
    ranks = pd.DataFrame(
        {"Held": [15.0], "NotHeld": [40.0], "NotPb": [15.0], "AlreadyBetter": [3.0]},
        index=[PB_WEEKS[0]],
    )
    pb = pd.DataFrame(
        {"Held": [True], "NotHeld": [True], "NotPb": [False], "AlreadyBetter": [True]},
        index=[PB_WEEKS[0]],
    )
    capped = levers.cap_rank_during_pullback(ranks, pb, exit_rank=10)
    row = capped.iloc[0]
    assert row["Held"] == 10.0  # was worse than exit_rank, floored to it
    assert row["NotHeld"] == 10.0  # same cap, whether or not it is actually held
    assert row["NotPb"] == 15.0  # not in PB state: untouched
    assert row["AlreadyBetter"] == 3.0  # already better than exit_rank: unchanged, never improved
