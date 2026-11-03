"""BL-024 Phase 2: scoring the forward journal — which row is scored, the next-week check, the
live return at the engine's own costs, and the backtest comparison kept honest across rankings."""

import json
from datetime import UTC, datetime

import pandas as pd
import pytest
from trading_data.db import connect

from momentum_backtesting import engine, forward_journal, forward_score
from momentum_backtesting.engine import CASH

W1, W2, W3 = "2026-10-16", "2026-10-23", "2026-10-30"
CONFIG = {"dataset": "broad", "cost_model": "itemised", "slippage_bps": 15.0, "capital": 50000.0}


def _record(con, week, *, target, before, rows, sleeve_value, at, commit="aaa", config_id="s1"):
    entry = forward_journal.Entry(
        week=week,
        run_kind="final",
        source="favourite",
        config_id=config_id,
        config_name=f"Sleeve {config_id}",
        dataset="broad",
        settings=CONFIG,
        holdings_before=before,
        signal={
            "week": week,
            "rows": rows,
            "weights": before,
            "target_weights": target,
            "sleeve_value": sleeve_value,
        },
        data_fingerprint="x",
        code_commit=commit,
    )
    return forward_journal.record(con, entry, now=datetime.fromisoformat(at).astimezone(UTC))


def _prices() -> forward_score.PriceTables:
    index = pd.to_datetime(["2026-10-09", W1, W2, W3])
    close = pd.DataFrame(
        {
            "A": [100.0, 100.0, 110.0, 110.0],
            "B": [50.0, 50.0, 45.0, 45.0],
            "C": [10.0, 10.0, 10.0, 10.0],
            CASH: [1.0, 1.0, 1.001, 1.002],
        },
        index=index,
    )
    monday = close * 1.01
    monday.loc[pd.Timestamp(W2), "A"] = 112.0
    return forward_score.PriceTables(close=close, monday=monday)


def _versions(commit: str) -> str:
    return forward_score.F6_LABEL if commit.startswith("f6") else forward_score.PRE_F6_LABEL


def _score(con, **kwargs):
    return forward_score.score(
        forward_journal.entries(con),
        prices_for=lambda settings: _prices(),
        backtest_now=kwargs.pop("backtest_now", None),
        versions=_versions,
        **kwargs,
    )


def test_a_week_is_scored_from_the_next_weeks_portfolio_at_the_engines_costs():
    with connect() as con:
        _record(
            con,
            W1,
            target={"A": 0.5, "B": 0.5},
            before={"C": 1.0},
            rows=[
                {"asset": "A", "action": "BUY"},
                {"asset": "B", "action": "BUY"},
                {"asset": "C", "action": "SELL"},
            ],
            sleeve_value=1.0,
            at="2026-10-16T20:00:00+05:30",
        )
        _record(
            con,
            W2,
            target={"A": 0.55, "B": 0.45},
            before={"A": 0.55, "B": 0.45},
            rows=[{"asset": "A", "action": "HOLD"}],
            sleeve_value=0.99,
            at="2026-10-23T20:00:00+05:30",
        )
        result = _score(con)
    item = next(i for i in result["items"] if i["week"] == W1)
    assert item["status"] == "scored"
    # Selling all of C and buying A and B, at the engine's own rates.
    cost = forward_score.trade_cost(CONFIG, {"C": 1.0}, {"A": 0.5, "B": 0.5})
    assert item["live"]["cost"] == pytest.approx(cost)
    assert item["live"]["ideal"] == pytest.approx((1 - cost) * (0.5 * 1.1 + 0.5 * 0.9) - 1)
    assert item["live"]["achievable"] == pytest.approx(
        (1 - cost) * (0.5 * 112.0 / 101.0 + 0.5 * 0.9) - 1
    )
    assert item["backtest"]["recorded"] == pytest.approx(-0.01)
    assert item["gap"]["recorded"]["ideal"] == pytest.approx(item["live"]["ideal"] + 0.01)
    assert result["scored_weeks"] == [W1]
    later = next(i for i in result["items"] if i["week"] == W2)
    assert later["status"] == "waiting"


def test_trade_cost_matches_the_engines_own_buy_and_sell_rates():
    config = engine.Config(cost_model="itemised", slippage_bps=15.0, capital=50000.0)
    index = pd.to_datetime([W1])
    sim = engine._Sim(
        prices=pd.DataFrame({"A": [1.0], "B": [1.0], CASH: [1.0]}, index=index),
        ranks=pd.DataFrame({"A": [1.0], "B": [2.0]}, index=index),
        filter_ret=pd.DataFrame(index=index),
        config=config,
        ledger=None,
        tax_classes={},
    )
    expected = 0.3 * sim.buy_cost(0.3, "A") + 0.2 * sim.sell_cost(0.2, "B")
    # 30% idle before, 20% after: 10% comes out of the liquid fund (the engine's UNPARK leg).
    expected += 0.1 * sim.sell_cost(0.1, CASH)
    got = forward_score.trade_cost(CONFIG, {"B": 0.5, "A": 0.2}, {"B": 0.3, "A": 0.5})
    assert got == pytest.approx(expected)


def test_parking_money_costs_the_flat_rate_and_a_hold_week_costs_nothing():
    flat = {"cost_model": "flat", "cost_pct": 0.1}
    # Selling half of A into the liquid fund: one sale and one PARK leg, 0.1% each.
    assert forward_score.trade_cost(flat, {"A": 1.0}, {"A": 0.5}) == pytest.approx(0.001)
    # `holdings_before` is already the portfolio at the signal's close: no trade, no cost.
    assert forward_score.trade_cost(CONFIG, {"A": 0.6, "B": 0.4}, {"A": 0.6, "B": 0.4}) == 0.0


def test_settings_without_a_field_take_the_requests_defaults():
    rates = forward_score._rates({})
    assert (rates.cost_model, rates.capital, rates.slippage_bps) == ("flat", 1e6, 5.0)


def test_a_recorded_buy_missing_next_week_is_flagged_not_scored():
    with connect() as con:
        _record(
            con,
            W1,
            target={"A": 1.0},
            before={},
            rows=[{"asset": "A", "action": "BUY"}],
            sleeve_value=1.0,
            at="2026-10-16T20:00:00+05:30",
        )
        _record(
            con,
            W2,
            target={"B": 1.0},
            before={"B": 1.0},
            rows=[],
            sleeve_value=1.0,
            at="2026-10-23T20:00:00+05:30",
        )
        item = _score(con)["items"][0]
    assert item["status"] == "mismatch"
    assert item["mismatches"] == ["A: recorded BUY but not held the week after"]
    assert item["live"]["ideal"] is None


def test_the_latest_row_before_the_fill_is_scored_and_later_rows_are_corrections():
    with connect() as con:
        args = dict(before={}, rows=[{"asset": "A", "action": "BUY"}], sleeve_value=1.0)
        first = _record(con, W1, target={"A": 1.0}, at="2026-10-16T20:00:00+05:30", **args)
        second = _record(
            con, W1, target={"A": 1.0, "B": 0.0001}, at="2026-10-17T10:00:00+05:30", **args
        )
        # Monday 19 Oct after 09:15: too late to have been traded.
        late = _record(con, W1, target={"A": 0.9, "B": 0.1}, at="2026-10-19T10:00:00+05:30", **args)
        _record(
            con,
            W2,
            target={"A": 1.0},
            before={"A": 1.0},
            rows=[],
            sleeve_value=1.1,
            at="2026-10-23T20:00:00+05:30",
        )
        item = next(i for i in _score(con)["items"] if i["week"] == W1)
    assert first < second < late
    assert item["entry_id"] == second
    assert item["corrections"] == [late]


def test_every_row_after_the_fill_is_late_not_scored():
    with connect() as con:
        _record(
            con,
            W1,
            target={"A": 1.0},
            before={},
            rows=[],
            sleeve_value=1.0,
            at="2026-10-19T10:00:00+05:30",
        )
        _record(
            con,
            W2,
            target={"A": 1.0},
            before={"A": 1.0},
            rows=[],
            sleeve_value=1.0,
            at="2026-10-23T20:00:00+05:30",
        )
        item = next(i for i in _score(con)["items"] if i["week"] == W1)
    assert item["status"] == "late"


def test_rows_from_different_rankings_give_no_recorded_backtest():
    with connect() as con:
        _record(
            con,
            W1,
            target={"A": 1.0},
            before={},
            rows=[],
            sleeve_value=1.0,
            at="2026-10-16T20:00:00+05:30",
            commit="old",
        )
        _record(
            con,
            W2,
            target={"A": 1.0},
            before={"A": 1.0},
            rows=[],
            sleeve_value=1.2,
            at="2026-10-23T20:00:00+05:30",
            commit="f6new",
        )
        item = next(
            i for i in _score(con, backtest_now=lambda s, w, n: 0.05)["items"] if i["week"] == W1
        )
    assert item["backtest"]["recorded"] is None
    assert "different rankings" in item["backtest"]["recorded_note"]
    assert item["backtest"]["now"] == 0.05
    assert item["gap"]["now"]["ideal"] == pytest.approx(item["live"]["ideal"] - 0.05)


def test_two_rows_of_unknown_ranking_are_never_taken_as_the_same():
    def versions(commit: str) -> str:
        return "unknown"

    with connect() as con:
        for week, before, at in (
            (W1, {}, "2026-10-16T20:00:00+05:30"),
            (W2, {"A": 1.0}, "2026-10-23T20:00:00+05:30"),
        ):
            _record(con, week, target={"A": 1.0}, before=before, rows=[], sleeve_value=1.0, at=at)
        result = forward_score.score(
            forward_journal.entries(con),
            prices_for=lambda settings: _prices(),
            backtest_now=None,
            versions=versions,
        )
    item = next(i for i in result["items"] if i["week"] == W1)
    assert item["backtest"]["recorded"] is None
    assert "git history" in item["backtest"]["recorded_note"]


def test_a_group_is_its_sleeves_weighted_by_value():
    with connect() as con:
        for sleeve, value, asset in (("s1", 1.0, "A"), ("s2", 3.0, "B")):
            _record(
                con,
                W1,
                target={asset: 1.0},
                before={},
                rows=[],
                sleeve_value=value,
                at="2026-10-16T20:00:00+05:30",
                config_id=sleeve,
            )
            _record(
                con,
                W2,
                target={asset: 1.0},
                before={asset: 1.0},
                rows=[],
                sleeve_value=value,
                at="2026-10-23T20:00:00+05:30",
                config_id=sleeve,
            )
        result = _score(
            con, groups=[{"id": "g", "name": "G", "members": [{"id": "s1"}, {"id": "s2"}]}]
        )
    items = {i["config_id"]: i for i in result["items"] if i["week"] == W1}
    group = next(g for g in result["groups"] if g["week"] == W1)
    assert group["status"] == "scored"
    expected = 0.25 * items["s1"]["live"]["ideal"] + 0.75 * items["s2"]["live"]["ideal"]
    assert group["live"]["ideal"] == pytest.approx(expected)
    line = forward_score.headline_line(result, {"id": "g"})
    assert line.startswith("Forward score, week of 16 Oct: ")
    assert "as recorded" in line


def test_backtest_week_runs_from_before_one_weeks_trades_to_before_the_next():
    index = pd.to_datetime([W1, W2])
    result = engine.Result(
        config=engine.Config(),
        equity=pd.Series([0.99, 1.05], index=index),
        benchmark=pd.Series(dtype=float),
        cash=pd.Series(dtype=float),
        weights=pd.DataFrame(),
        holdings=pd.DataFrame(),
        trades=pd.DataFrame({"week": index, "cost": [0.01, 0.02]}),
        ranks=pd.DataFrame(),
        scores=pd.DataFrame(),
    )
    assert forward_score.backtest_week(result, W1, W2) == pytest.approx(1.07 / 1.00 - 1)


def test_the_score_file_round_trips(tmp_path):
    forward_score.save({"items": [], "weeks": []}, tmp_path)
    assert forward_score.load(tmp_path) == {"items": [], "weeks": [], "schema": 1}
    # A file of another shape (an older one) is not read as this one.
    (tmp_path / forward_score.SCORE_FILE).write_text(json.dumps({"items": [], "weeks": []}))
    assert forward_score.load(tmp_path) is None
