"""Tests for categories/circuit_exposure.py -- the pure run detection and holding periods."""

from __future__ import annotations

import pandas as pd

from momentum_backtesting.categories import circuit_exposure as ce
from momentum_backtesting.engine import IDLE


def _bars(moves: list[float]) -> pd.DataFrame:
    dates = pd.bdate_range("2024-01-01", periods=len(moves))
    return pd.DataFrame({"date": dates, "move": moves})


def test_runs_group_same_direction_band_edge_closes() -> None:
    # +5, +5, +5 (UC run of 3), a normal day, then -10, -10 (LC run of 2)
    runs = ce._runs(_bars([0.05, 0.0499, 0.05, 0.01, -0.10, -0.099]))
    assert [(r["direction"], r["days"]) for r in runs] == [("UC", 3), ("LC", 2)]
    assert runs[0]["band"] == 0.05 and runs[1]["band"] == 0.10
    assert round(runs[0]["move"], 3) == round(1.05 * 1.0499 * 1.05 - 1, 3)


def test_opposite_directions_do_not_form_one_run() -> None:
    runs = ce._runs(_bars([0.05, -0.05, 0.05]))
    assert [r["days"] for r in runs] == [1, 1, 1]


def test_ordinary_moves_make_no_run() -> None:
    assert ce._runs(_bars([0.03, -0.012, 0.07, 0.0])) == []


def test_holding_periods_split_a_stock_held_twice_and_skip_cash() -> None:
    weeks = pd.date_range("2024-01-05", periods=7, freq="W-FRI")
    weights = pd.DataFrame(
        {
            "AAA": [0.2, 0.2, 0.0, 0.0, 0.3, 0.3, 0.3],
            "BBB": [0.0, 0.1, 0.1, 0.0, 0.0, 0.0, 0.0],
            IDLE: [0.8, 0.7, 0.9, 1.0, 0.7, 0.7, 0.7],
        },
        index=weeks,
    )

    class _Result:
        pass

    result = _Result()
    result.weights = weights  # type: ignore[attr-defined]
    periods = ce.holding_periods(result, {"AAA": "AAA", "BBB": "BBB"})  # type: ignore[arg-type]
    got = sorted((r.symbol, r.buy, r.sell) for r in periods.itertuples())
    assert [(sym, buy) for sym, buy, _ in got] == [
        ("AAA", weeks[0]),
        ("AAA", weeks[4]),
        ("BBB", weeks[1]),
    ]
    assert got[0][2] == weeks[2] and got[2][2] == weeks[3]
    assert pd.isna(got[1][2])  # still held when the backtest ends
    assert set(periods["symbol"]) == {"AAA", "BBB"}


def _daily(moves_by_date: dict[str, float]) -> pd.DataFrame:
    dates = pd.bdate_range("2024-01-01", "2024-06-28")
    return pd.DataFrame(
        {"date": dates, "move": [moves_by_date.get(f"{d:%Y-%m-%d}", 0.0) for d in dates]}
    )


def _period(symbol: str, buy: str, sell: str | None, share: float = 0.2) -> dict:
    weeks = pd.date_range(buy, periods=3, freq="W-FRI")
    return {
        "symbol": symbol,
        "buy": pd.Timestamp(buy),
        "sell": pd.Timestamp(sell) if sell else pd.NaT,
        "peak_share": share,
        "share_by_week": pd.Series(share, index=weeks),
    }


def test_lc_outcomes_separates_trapped_from_escaped() -> None:
    lock = {"2024-03-11": -0.10, "2024-03-12": -0.10, "2024-03-13": -0.10}
    by_symbol = {"TRAP": _daily(lock), "SAFE": _daily(lock)}
    periods = pd.DataFrame(
        [
            _period("TRAP", "2024-02-02", "2024-04-05"),  # held when the lock began
            _period("SAFE", "2024-01-05", "2024-02-23"),  # sold ~2.5 weeks before
        ]
    )
    out = ce.lc_outcomes(by_symbol, periods, pd.Timestamp("2024-06-28"))

    assert [t["symbol"] for t in out["trapped"]] == ["TRAP"]
    trapped = out["trapped"][0]
    assert trapped["exit"] == "sold_after" and trapped["days"] == 3
    assert trapped["realised_move_pct"] < -27  # three -10% closes compounded
    assert trapped["portfolio_impact_pct"] < 0

    assert [e["symbol"] for e in out["escaped"]] == ["SAFE"]
    escaped = out["escaped"][0]
    assert escaped["days_before"] == 17 and escaped["avoided_impact_pct"] < 0


def test_lc_outcomes_flags_a_sale_in_the_middle_of_the_lock_and_open_positions() -> None:
    lock = {"2024-03-11": -0.10, "2024-03-12": -0.10, "2024-03-13": -0.10}
    by_symbol = {"MID": _daily(lock), "OPEN": _daily(lock)}
    periods = pd.DataFrame(
        [
            _period("MID", "2024-02-02", "2024-03-12"),
            _period("OPEN", "2024-02-02", None),
        ]
    )
    out = ce.lc_outcomes(by_symbol, periods, pd.Timestamp("2024-06-28"))
    kinds = {t["symbol"]: t["exit"] for t in out["trapped"]}
    assert kinds == {"MID": "sold_during", "OPEN": "still_held"}
    assert next(t for t in out["trapped"] if t["symbol"] == "OPEN")["exit_date"] is None


def test_a_single_bad_day_is_not_a_lock() -> None:
    by_symbol = {"X": _daily({"2024-03-11": -0.10})}
    periods = pd.DataFrame([_period("X", "2024-02-02", "2024-04-05")])
    out = ce.lc_outcomes(by_symbol, periods, pd.Timestamp("2024-06-28"))
    assert out == {"trapped": [], "escaped": []}
