"""Every-K-weeks rebalancing (`rebalance_every` / `rebalance_offset`, TODO 3.9.23 Step 0b)."""

import hashlib

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import (
    BENCHMARK,
    CADENCE_EPOCH,
    CASH,
    Config,
    cadence_weeks,
    run_backtest,
)

WEEKS = pd.date_range("2016-01-01", periods=260, freq="W-FRI")
NAMES = [f"Asset {i}" for i in range(12)]


def market() -> pd.DataFrame:
    rng = np.random.default_rng(2026)
    drift = rng.normal(0.002, 0.002, len(NAMES))
    data = {
        n: 100 * np.cumprod(1 + rng.normal(d, 0.035, len(WEEKS)))
        for n, d in zip(NAMES, drift, strict=True)
    }
    data[CASH] = 100 * np.cumprod(np.full(len(WEEKS), 1.0012))
    data[BENCHMARK] = 100 * np.cumprod(1 + rng.normal(0.0018, 0.025, len(WEEKS)))
    return pd.DataFrame(data, index=WEEKS)


def run(**overrides):
    includes = {n: "core" for n in NAMES} | {CASH: "defensive", BENCHMARK: "core"}
    config = Config(**{"start": "2017-01-06", "top_n": 3, "exit_rank": 6, **overrides})
    return run_backtest(market(), includes, config)


def digest(result) -> str:
    h = hashlib.sha256()
    h.update(np.round(result.equity.to_numpy(), 10).tobytes())
    trades = result.trades
    if not trades.empty:
        h.update(trades[["week", "asset", "action"]].astype(str).to_csv(index=False).encode())
        h.update(np.round(trades["value"].to_numpy(dtype=float), 10).tobytes())
    return h.hexdigest()[:16]


# Captured from the engine BEFORE rebalance_every existed. Adding the option must not move a
# single trade or equity value for any existing configuration.
@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({}, "6990702752c87b20"),
        ({"entry": "make_room"}, "9015a668044a843a"),
        ({"portfolio": "slots"}, "94b3105cf2f0dea4"),
        ({"rebalance": "monthly"}, "ff034d9f99b85f28"),
        ({"signal_delay": 1}, "fc4646df80d703e7"),
    ],
)
def test_default_cadence_is_byte_identical_to_before(overrides, expected):
    assert digest(run(**overrides)) == expected
    assert digest(run(**overrides, rebalance_every=1, rebalance_offset=0)) == expected


# Same idea for tax-on runs: captured before tax_hold_band existed (TODO 3.9.23 experiment 6).
@pytest.mark.parametrize(
    ("overrides", "expected"),
    [({}, "c97f97c6d231e274"), ({"entry": "make_room"}, "a21768c897a8e618")],
)
def test_tax_on_default_is_byte_identical_to_before(overrides, expected):
    from momentum_backtesting.tax import TaxRules

    includes = {n: "core" for n in NAMES} | {CASH: "defensive", BENCHMARK: "core"}
    classes = {n: "equity" for n in NAMES} | {CASH: "debt", BENCHMARK: "equity"}
    config = Config(start="2017-01-06", top_n=3, exit_rank=6, tax=TaxRules(), **overrides)
    assert digest(run_backtest(market(), includes, config, classes)) == expected


def phase(week: pd.Timestamp, every: int) -> int:
    return ((week - CADENCE_EPOCH).days // 7) % every


@pytest.mark.parametrize("portfolio", ["buffer", "slots"])
def test_trades_only_happen_on_the_chosen_phase(portfolio):
    for offset in (0, 1):
        trades = run(portfolio=portfolio, rebalance_every=2, rebalance_offset=offset).trades
        assert not trades.empty
        assert {phase(w, 2) for w in trades["week"]} == {offset}


def test_offsets_trade_on_disjoint_weeks_and_differ():
    a = run(rebalance_every=2, rebalance_offset=0)
    b = run(rebalance_every=2, rebalance_offset=1)
    assert not set(a.trades["week"]) & set(b.trades["week"])
    assert digest(a) != digest(b)


def test_phase_is_anchored_to_the_calendar_not_the_start_date():
    early = run(rebalance_every=3, rebalance_offset=2, start="2017-01-06")
    late = run(rebalance_every=3, rebalance_offset=2, start="2017-01-13")
    assert {phase(w, 3) for w in early.trades["week"]} == {2}
    assert {phase(w, 3) for w in late.trades["week"]} == {2}


def test_slower_cadence_trades_less():
    weekly = run()
    fortnightly = run(rebalance_every=2)
    every4 = run(rebalance_every=4)
    assert len(weekly.trades) > len(fortnightly.trades) > len(every4.trades)


def test_cadence_weeks_helper():
    weeks = list(pd.date_range("2016-01-01", periods=6, freq="W-FRI"))
    assert sorted(cadence_weeks(weeks, 2, 0)) == weeks[0::2]
    assert sorted(cadence_weeks(weeks, 3, 1)) == weeks[1::3]


@pytest.mark.parametrize(
    "overrides",
    [
        {"rebalance_every": 0},
        {"rebalance_every": 2, "rebalance_offset": 2},
        {"rebalance_every": 2, "rebalance_offset": -1},
        {"rebalance_every": 2, "rebalance": "monthly"},
    ],
)
def test_invalid_cadence_is_rejected(overrides):
    with pytest.raises(ValueError):
        Config(**overrides)


def test_label_names_the_cadence_only_when_set():
    assert "every" not in Config().label
    assert Config(rebalance_every=2, rebalance_offset=1).label.endswith("_every2o1")


@pytest.fixture
def client(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from momentum_backtesting import api
    from momentum_backtesting.fetch import load_universe

    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(7)
    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks)))
            for inst in load_universe()
        },
        index=weeks,
    )
    prices[CASH] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    universe = [i.name for i in load_universe() if i.include == "core"]
    return TestClient(api.create_app()), universe


def test_api_accepts_an_every_k_weeks_cadence(client):
    http, universe = client
    body = {"universe": universe, "start": "2017-01-06", "rebalance_every": 2}
    res = http.post("/api/backtest", json={**body, "rebalance_offset": 1})
    assert res.status_code == 200, res.text
    weeks = {pd.Timestamp(t["entry_week"]) for t in res.json()["trades"]}
    assert weeks and {phase(w, 2) for w in weeks} == {1}
    bad = http.post("/api/backtest", json={**body, "rebalance": "monthly"})
    assert bad.status_code == 422
    meta = http.get("/api/meta").json()
    assert meta["defaults"]["rebalance_every"] == 1


# --- min_ranked: thin weeks (TODO 3.9.23) --------------------------------------------------------


def thin_case(**overrides):
    weeks = pd.date_range("2017-01-06", periods=12, freq="W-FRI")
    names = ["A", "B", "C"]
    prices = pd.DataFrame({n: 100 * 1.01 ** np.arange(12) for n in names}, weeks)
    prices[CASH] = 100 * 1.001 ** np.arange(12)
    prices[BENCHMARK] = prices[CASH]
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=weeks)
    ranks.iloc[5:8] = [[np.nan, 1.0, np.nan]] * 3  # three thin weeks: only B is ranked
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "defensive"}
    config = Config(start="2017-01-06", top_n=2, exit_rank=2, cost_pct=0.0, **overrides)
    return run_backtest(prices, includes, config, external_ranks=(ranks, ranks)), weeks


def test_default_skips_weeks_with_fewer_than_top_n_ranked():
    result, weeks = thin_case()
    assert not set(weeks[5:8]) & set(result.equity.index)
    assert "A" not in set(result.trades.loc[result.trades["action"] == "SELL", "asset"])


def test_min_ranked_simulates_thin_weeks_and_sells_what_dropped_out():
    result, weeks = thin_case(min_ranked=1)
    assert set(weeks[5:8]) <= set(result.equity.index)
    sells = result.trades[result.trades["action"] == "SELL"]
    assert (sells["asset"] == "A").any()
    assert sells.loc[sells["asset"] == "A", "week"].iloc[0] == weeks[5]


def test_min_ranked_validation_and_label():
    with pytest.raises(ValueError):
        Config(min_ranked=-1)
    assert Config(min_ranked=1).label.endswith("_minranked1")


# --- sell_every_week: exits move faster than new buys on a slow cadence (owner idea) ------------

CADENCE_WEEKS = pd.date_range("2016-01-01", periods=30, freq="W-FRI")


def cadence_case(**overrides):
    """3 names, top_n=1/exit_rank=2, every 2 weeks. A holds rank 1 until `flip_week` (a
    non-buy, phase-1 week), where ranks flip so A drops to rank 3 (must exit) and B takes
    rank 1. Flat, zero-cost prices - only trade timing is under test."""
    names = ["A", "B", "C"]
    flip_week = CADENCE_WEEKS[5]
    assert phase(flip_week, 2) == 1  # a non-buy week under rebalance_offset=0
    prices = pd.DataFrame({n: 100.0 for n in names}, index=CADENCE_WEEKS)
    prices[CASH] = 100.0
    prices[BENCHMARK] = 100.0
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=CADENCE_WEEKS)
    ranks.loc[flip_week:, ["A", "B", "C"]] = [3.0, 1.0, 2.0]
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "defensive"}
    config = Config(
        start="2016-01-01",
        top_n=1,
        exit_rank=2,
        cost_pct=0.0,
        max_position=None,  # top_n=1 would otherwise hit the 35% default cap
        rebalance_every=2,
        rebalance_offset=0,
        **overrides,
    )
    result = run_backtest(prices, includes, config, external_ranks=(ranks, ranks))
    return result, flip_week


def sell_week_of(result, asset: str) -> pd.Timestamp:
    sells = result.trades[(result.trades["action"] == "SELL") & (result.trades["asset"] == asset)]
    return sells["week"].iloc[0]


def test_default_defers_the_exit_to_the_next_buy_week():
    result, flip_week = cadence_case()
    assert sell_week_of(result, "A") == CADENCE_WEEKS[6]  # next phase-0 week, not flip_week


def test_sell_every_week_exits_immediately_on_a_non_buy_week():
    result, flip_week = cadence_case(sell_every_week=True)
    assert sell_week_of(result, "A") == flip_week


def test_sell_every_week_still_waits_for_the_cadence_to_buy():
    """Only the sell moves; the vacated slot is filled on the usual cadence either way."""
    deferred, flip_week = cadence_case()
    immediate, _ = cadence_case(sell_every_week=True)
    for result in (deferred, immediate):
        buys = result.trades[(result.trades["action"] == "BUY") & (result.trades["asset"] == "B")]
        assert buys["week"].iloc[0] == CADENCE_WEEKS[6]
    at_flip = immediate.trades[immediate.trades["week"] == flip_week]
    assert set(at_flip["action"]) == {"SELL"}  # no BUY yet at the non-buy week itself


def test_sell_every_week_parks_the_proceeds_as_idle_until_the_buy_week():
    """A fully-idle week (nothing held, nothing invested) has an empty `weights` row, which
    pandas drops entirely - a pre-existing display quirk (the same thing happens before the
    very first trade under rebalance="monthly"). `holdings` is built from a plain list of
    per-week dicts instead, so it always has a row and shows the 0 holdings directly."""
    result, flip_week = cadence_case(sell_every_week=True)
    assert flip_week not in result.weights.index
    assert result.holdings.loc[flip_week, "count"] == 0
    assert result.weights.loc[CADENCE_WEEKS[6], "B"] > 0.99
    assert result.holdings.loc[CADENCE_WEEKS[6], "holdings"] == "B"


def test_sell_every_week_needs_the_buffer_rule():
    with pytest.raises(ValueError, match="buffer"):
        Config(sell_every_week=True, portfolio="slots")


def test_sell_every_week_label():
    assert Config(sell_every_week=True).label.endswith("_sellweekly")
    assert "sellweekly" not in Config().label


def test_api_accepts_sell_every_week_and_rejects_it_without_the_buffer_rule(client):
    http, universe = client
    body = {"universe": universe, "start": "2017-01-06", "rebalance_every": 2}
    res = http.post("/api/backtest", json={**body, "sell_every_week": True})
    assert res.status_code == 200, res.text
    bad = http.post(
        "/api/backtest",
        json={**body, "sell_every_week": True, "portfolio": "slots"},
    )
    assert bad.status_code == 422
    meta = http.get("/api/meta").json()
    assert meta["defaults"]["sell_every_week"] is False


# --- rebalance preview as a background job (Cloudflare 524) --------------------------------------


def _wait_for_job(http, job_id):
    import time

    for _ in range(100):
        job = http.get(f"/api/rebalance-preview/jobs/{job_id}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("preview job never finished")


def test_rebalance_preview_job_returns_the_result_and_the_refusals(client, monkeypatch):
    from fastapi import HTTPException

    from momentum_backtesting import api

    http, universe = client
    body = {"universe": universe, "portfolio_value": 1000, "holdings_pct": {}}

    monkeypatch.setattr(api, "rebalance_preview", lambda req: {"signal_week": "2026-10-02"})
    started = http.post("/api/rebalance-preview/jobs", json=body)
    assert started.status_code == 202
    done = _wait_for_job(http, started.json()["id"])
    assert done["status"] == "done" and done["result"] == {"signal_week": "2026-10-02"}

    def refuse(req):
        raise HTTPException(422, "Rebalance preview supports Stock and Broad Momentum.")

    monkeypatch.setattr(api, "rebalance_preview", refuse)
    failed = _wait_for_job(http, http.post("/api/rebalance-preview/jobs", json=body).json()["id"])
    assert failed["status"] == "failed" and failed["error_status"] == 422
    assert "Stock and Broad" in failed["error"]

    assert http.get("/api/rebalance-preview/jobs/ffff").status_code == 404
