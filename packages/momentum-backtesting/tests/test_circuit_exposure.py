"""Tests for categories/circuit_exposure.py -- the pure run detection and holding periods."""

from __future__ import annotations

import pandas as pd
import pytest
from trading_data.db import connect

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


# --- the stock drawer's 52-week circuit locks (BL-049 Phase 3) -----------------------------------


def _lake(root, closes: dict[str, list[tuple[str, float]]], *, series: str = "EQ") -> None:
    """Daily bars written the way the real lake is: each close against the one before it."""
    rows = []
    with connect(root) as con:
        for symbol, points in closes.items():
            instrument_id = con.execute(
                "INSERT INTO instruments (instrument_key, asset_class, exchange, symbol) "
                "VALUES (?, 'stock', 'NSE', ?) RETURNING instrument_id",
                [f"stock:NSE:{symbol}", symbol],
            ).fetchone()[0]
            previous = points[0][1]
            for day, close in points:
                rows.append(
                    {
                        "instrument_id": instrument_id,
                        "date": pd.Timestamp(day),
                        "series": series,
                        "isin": f"INE{symbol}",
                        "open": close,
                        "high": close,
                        "low": close,
                        "close": close,
                        "prevclose": previous,
                        "volume": 1000,
                        "turnover": 1.0e7,
                        "synthetic_close": False,
                    }
                )
                previous = close
    frame = pd.DataFrame(rows)
    for year, part in frame.groupby(frame["date"].dt.year):
        path = root / "lake" / "bars_1d" / "asset=stock" / f"year={year}" / "data.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        part.to_parquet(path, index=False)


def _walk(start: str, moves: list[float], price: float = 100.0) -> list[tuple[str, float]]:
    days = pd.bdate_range(start, periods=len(moves))
    out = []
    for day, move in zip(days, moves, strict=True):
        price *= 1 + move
        out.append((f"{day:%Y-%m-%d}", round(price, 2)))
    return out


@pytest.fixture
def lake(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    quiet = [0.001] * 60
    # AAA: ordinary, then a 4-day lower-circuit lock at 5%, ordinary, a 2-day UC (not a lock),
    # a 3-day upper-circuit lock at 10%, and it ends on the stock's last session (ongoing).
    aaa = [*quiet, -0.05, -0.0499, -0.05, -0.0501, *quiet[:10], 0.05, 0.05, *quiet[:10]]
    aaa += [0.10, 0.099, 0.10]
    # BBB: a 3-day lock that began a week before the window opens and runs into it.
    bbb = [*quiet[:40], -0.2, -0.2, -0.2, -0.2, *quiet[:20]]
    # CCC: nothing but ordinary days.
    ccc = [0.02, -0.03, 0.04] * 30
    _lake(
        tmp_path,
        {
            "AAA": _walk("2024-01-01", aaa),
            "BBB": _walk("2024-01-01", bbb),
            "CCC": _walk("2024-01-01", ccc),
        },
    )
    return tmp_path


def test_a_lock_is_three_or_more_sessions_on_one_band_edge(lake) -> None:
    out = ce.stock_circuit_locks("AAA", pd.Timestamp("2024-06-28"), root=lake)
    assert out["min_days"] == 3 and out["weeks"] == 52 and out["symbol"] == "AAA"
    assert [(lk["direction"], lk["days"], lk["band_pct"]) for lk in out["locks"]] == [
        ("UC", 3, 10),
        ("LC", 4, 5),
    ]  # newest first; the 2-day upper circuit is an ordinary run, not a lock
    assert out["total"] == 2
    lc = out["locks"][1]
    assert lc["move_pct"] == pytest.approx(-18.5, abs=0.2)
    assert lc["start"] < lc["end"]


def test_a_lock_that_reaches_the_last_session_is_ongoing(lake) -> None:
    out = ce.stock_circuit_locks("AAA", pd.Timestamp("2024-06-28"), root=lake)
    assert [lk["ongoing"] for lk in out["locks"]] == [True, False]
    # asked as of a day before the lock ends nothing changes about the older one
    earlier = ce.stock_circuit_locks("AAA", pd.Timestamp("2024-04-30"), root=lake)
    assert [lk["direction"] for lk in earlier["locks"]] == ["LC"]


def test_only_the_window_counts_but_a_lock_reaching_into_it_keeps_its_true_start(lake) -> None:
    window = ce.stock_circuit_locks("BBB", pd.Timestamp("2024-04-19"), weeks=1, root=lake)
    # BBB's four -20% sessions end 2024-02-27 or so: nothing a week back from April...
    assert window["locks"] == [] and window["total"] == 0
    # ...but a window that opens inside the lock still reports all four sessions.
    sessions = pd.bdate_range("2024-01-01", periods=70)
    first, last = sessions[40], sessions[43]
    mid = ce.stock_circuit_locks("BBB", sessions[47], weeks=1, root=lake)  # opens on session 42
    assert mid["locks"][0]["days"] == 4
    assert mid["locks"][0]["start"] == f"{first:%Y-%m-%d}"
    assert mid["locks"][0]["end"] == f"{last:%Y-%m-%d}"


def test_a_stock_with_only_ordinary_days_has_no_locks_and_counts_its_sessions(lake) -> None:
    out = ce.stock_circuit_locks("CCC", pd.Timestamp("2024-05-31"), root=lake)
    assert out["locks"] == [] and out["total"] == 0 and out["sessions"] > 50


def test_an_unknown_symbol_or_a_window_with_no_bars_is_empty_not_an_error(lake) -> None:
    out = ce.stock_circuit_locks("NOPE", pd.Timestamp("2024-05-31"), root=lake)
    assert out["locks"] == [] and out["sessions"] == 0
    out = ce.stock_circuit_locks("AAA", pd.Timestamp("2019-05-31"), root=lake)
    assert out["locks"] == [] and out["sessions"] == 0


def test_other_series_are_ignored(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    _lake(tmp_path, {"ZZZ": _walk("2024-01-01", [0.05, 0.05, 0.05, 0.05])}, series="BE")
    out = ce.stock_circuit_locks("ZZZ", pd.Timestamp("2024-02-01"), root=tmp_path)
    assert out["locks"] == [] and out["sessions"] == 0


def test_only_the_newest_locks_are_listed_but_all_are_counted(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    block = [0.05, 0.05, 0.05, 0.01]
    moves = [0.001, *(block * (ce.DRAWER_MAX_LOCKS + 3))]
    _lake(tmp_path, {"AAA": _walk("2024-01-01", moves)})
    out = ce.stock_circuit_locks("AAA", pd.Timestamp("2024-12-31"), root=tmp_path)
    assert out["total"] == ce.DRAWER_MAX_LOCKS + 3
    assert len(out["locks"]) == ce.DRAWER_MAX_LOCKS
    starts = [lk["start"] for lk in out["locks"]]
    assert starts == sorted(starts, reverse=True)
