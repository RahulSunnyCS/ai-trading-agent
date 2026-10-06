"""analysis.rotations on plain lists (BL-005 Phase 3) against the DataFrame version it replaced."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import analysis
from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest

WEEKS = pd.date_range("2018-01-05", periods=160, freq="W-FRI")


def reference_rotations(result) -> list[dict]:
    """`analysis.rotations` exactly as it was before: groupby, three boolean filters, itertuples."""
    trades = result.trades
    if trades.empty:
        return []
    out = []
    for week, group in trades.groupby("week", sort=True):
        sells = group[group["action"] == "SELL"]
        ins = group[group["action"].isin(["BUY", "ADD"])]
        trims = group[group["action"] == "TRIM"]
        out.append(
            {
                "week": week,
                "value": result.equity.get(week, float("nan")) * analysis.CAPITAL,
                "outs": [
                    {
                        "asset": r.asset,
                        "rank": r.rank,
                        "reason": r.reason,
                        "weeks_held": r.weeks_held,
                        "return": r.position_return,
                    }
                    for r in sells.itertuples()
                ],
                "ins": [
                    {"asset": r.asset, "rank": r.rank, "top_up": r.action == "ADD"}
                    for r in ins.itertuples()
                ],
                "trims": [{"asset": r.asset, "reason": r.reason} for r in trims.itertuples()],
                "parked": bool((group["action"] == "PARK").any()),
                "holdings": analysis._holdings_on(result, week),
            }
        )
    return out


def prices(seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    names = [f"S{i}" for i in range(9)]
    data = {name: 100 * np.cumprod(1 + rng.normal(0.002, 0.035, len(WEEKS))) for name in names}
    data[CASH] = 100 * np.cumprod(np.full(len(WEEKS), 1.001))
    data[BENCHMARK] = 100 * np.cumprod(1 + rng.normal(0.001, 0.02, len(WEEKS)))
    return pd.DataFrame(data, index=WEEKS)


def includes(frame: pd.DataFrame) -> dict[str, str]:
    return {name: ("defensive" if name == CASH else "core") for name in frame}


CONFIGS = [
    dict(portfolio="buffer", top_n=3, exit_rank=5),
    dict(portfolio="slots", top_n=3, exit_rank=5),
    dict(portfolio="buffer", top_n=4, exit_rank=6, max_position=0.3, defensive="ranked"),
    dict(portfolio="buffer", top_n=3, exit_rank=5, cost_pct=0.3, rebalance="monthly"),
]


@pytest.mark.parametrize("settings", CONFIGS)
@pytest.mark.parametrize("seed", [1, 2, 3])
def test_rotations_are_what_they_always_were(settings, seed):
    frame = prices(seed)
    result = run_backtest(
        frame,
        includes(frame),
        Config(lookbacks=(4, 13), start="2018-01-01", **settings),
    )
    new, old = analysis.rotations(result), reference_rotations(result)
    assert len(new) == len(old) > 10  # a real run: many weeks traded
    assert any(r["outs"] for r in new) and any(r["ins"] for r in new)  # sells and buys
    # what the API sends is the cleaned structure (NaN -> None, dates as text): compare that
    assert analysis._clean(new) == analysis._clean(old)
    # ... and the raw one too, element for element, ties in a week's holdings included
    for a, b in zip(new, old, strict=True):
        assert list(a) == list(b)
        assert a["week"] == b["week"] and type(a["week"]) is type(b["week"])
        assert [h["asset"] for h in a["holdings"]] == [h["asset"] for h in b["holdings"]]


def _result(seed: int = 4):
    frame = prices(seed)
    return run_backtest(
        frame,
        includes(frame),
        Config(lookbacks=(4, 13), start="2018-01-01", portfolio="buffer", top_n=3, exit_rank=5),
    )


def test_a_trade_log_out_of_week_order_gives_the_same_rotations():
    """The engine writes the log in week order, but nothing requires it."""
    result = _result()
    result.trades = result.trades.sample(frac=1, random_state=3)  # rows in any order
    new, old = analysis.rotations(result), reference_rotations(result)
    assert analysis._clean(new) == analysis._clean(old)
    assert [r["week"] for r in new] == sorted(r["week"] for r in new)


def test_a_row_with_no_week_is_left_out_as_groupby_left_it_out():
    result = _result()
    trades = result.trades.copy()
    trades.loc[trades.index[5], "week"] = pd.NaT
    trades.loc[trades.index[40], "week"] = pd.NaT
    result.trades = trades
    new, old = analysis.rotations(result), reference_rotations(result)
    assert analysis._clean(new) == analysis._clean(old)
    assert all(r["week"] is not pd.NaT for r in new)


def test_a_run_that_never_sells_has_rotations_without_the_sell_columns():
    frame = prices(5).iloc[:40]
    result = run_backtest(
        frame,
        includes(frame),
        Config(lookbacks=(4, 13), start="2018-01-01", portfolio="buffer", top_n=3, exit_rank=9),
    )
    assert analysis._clean(analysis.rotations(result)) == analysis._clean(
        reference_rotations(result)
    )


def test_no_trades_no_rotations():
    frame = prices(1)
    result = run_backtest(
        frame,
        includes(frame),
        Config(lookbacks=(4, 13), start="2018-01-01", portfolio="buffer", top_n=3, exit_rank=5),
    )
    result.trades = result.trades.iloc[0:0]
    assert analysis.rotations(result) == [] == reference_rotations(result)
