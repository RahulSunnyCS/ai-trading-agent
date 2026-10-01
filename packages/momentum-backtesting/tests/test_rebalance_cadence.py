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
