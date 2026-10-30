"""Monday-open fills for a stock-based run (BL-036 Phase 2, BL-010 E13)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting import monday_fills
from momentum_backtesting.categories import broad, daily_moves

FRIDAYS = pd.date_range("2024-01-05", periods=4, freq="W-FRI")
# Sessions: every weekday except the Monday after the third Friday (a holiday), and nothing after
# 2024-01-29, so the newest Friday (01-26) has a Monday (01-29) and the one after would not.
SESSIONS = pd.bdate_range("2024-01-01", "2024-01-29").drop(pd.Timestamp("2024-01-22"))


def moves_with(gaps: dict[str, dict[str, float]]) -> daily_moves.DailyMoves:
    columns = list(gaps)
    gap = pd.DataFrame(0.0, index=SESSIONS, columns=columns)
    for col, by_day in gaps.items():
        for day, value in by_day.items():
            gap.loc[pd.Timestamp(day), col] = value
    zeros = pd.DataFrame(0.0, index=SESSIONS, columns=columns)
    return daily_moves.DailyMoves(move=zeros, open_gap=gap, locked=zeros.astype(bool))


@pytest.fixture
def stub(monkeypatch):
    def install(gaps):
        monkeypatch.setattr(
            monday_fills.daily_moves, "daily_moves", lambda *a, **k: moves_with(gaps)
        )

    return install


def test_a_stock_fills_at_the_friday_close_moved_by_the_monday_gap(stub, tmp_path):
    prices = pd.DataFrame({"AAA": [100.0, 110.0, 120.0, 130.0]}, index=FRIDAYS)
    stub({"AAA": {"2024-01-08": 0.02, "2024-01-15": -0.05, "2024-01-23": 0.10}})
    out = monday_fills.build(prices, {"AAA": "AAA"}, data_dir=tmp_path).prices
    assert out["AAA"].iloc[0] == pytest.approx(100.0 * 1.02)  # Monday 01-08
    assert out["AAA"].iloc[1] == pytest.approx(110.0 * 0.95)  # Monday 01-15
    # 01-22 is a holiday: the first session after Friday 01-19 is Tuesday 01-23
    assert out["AAA"].iloc[2] == pytest.approx(120.0 * 1.10)
    assert out["AAA"].iloc[3] == pytest.approx(130.0)  # Monday 01-29 has no gap row: close


def test_the_newest_week_has_no_fill_until_its_monday_exists(stub, tmp_path):
    prices = pd.DataFrame(
        {"AAA": [100.0, 110.0, 120.0, 130.0, 140.0]}, index=[*FRIDAYS, pd.Timestamp("2024-02-02")]
    )
    stub({"AAA": {}})
    out = monday_fills.build(prices, {"AAA": "AAA"}, data_dir=tmp_path).prices
    assert out["AAA"].iloc[:4].notna().all()
    assert pd.isna(out["AAA"].iloc[-1])  # no session after 2024-02-02 in the data


def test_a_column_with_no_daily_file_fills_at_the_signal_close_and_is_listed(stub, tmp_path):
    prices = pd.DataFrame(
        {"AAA": [100.0] * 4, "Cash (liquid fund)": [10.0, 10.1, 10.2, 10.3]}, index=FRIDAYS
    )
    stub({"AAA": {}})
    built = monday_fills.build(prices, {"AAA": "AAA"}, data_dir=tmp_path)
    assert built.at_signal_close == ["Cash (liquid fund)"]
    assert list(built.prices["Cash (liquid fund)"]) == [10.0, 10.1, 10.2, 10.3]


def test_a_column_with_a_daily_file_uses_its_monday_open(stub, tmp_path):
    daily = tmp_path / "daily"
    daily.mkdir()
    days = pd.DatetimeIndex(["2024-01-05", "2024-01-08", "2024-01-12", "2024-01-15"])
    pd.DataFrame(
        {"open": [50.0, 51.0, 52.0, 53.0], "close": [50.5, 51.5, 52.5, 53.5]}, index=days
    ).to_csv(daily / "Gold.csv")
    prices = pd.DataFrame({"AAA": [100.0, 100.0], "Gold": [50.5, 52.5]}, index=FRIDAYS[:2])
    stub({"AAA": {}})
    built = monday_fills.build(prices, {"AAA": "AAA"}, data_dir=tmp_path)
    assert built.prices["Gold"].tolist() == [51.0, 53.0]  # the two Mondays' opens
    assert built.at_signal_close == []


def test_broad_refuses_a_monday_fill_with_a_signal_delay_and_the_ten_am_fill():
    common = dict(
        outer_prices=pd.DataFrame(),
        stocks_data_dir=Path("."),
        categories_data_dir=Path("."),
        curated_dir=Path("."),
    )
    with pytest.raises(ValueError, match="signal delay 0"):
        broad.run_broad_backtest(**common, execution="mon_open", signal_delay=1)
    with pytest.raises(ValueError, match="not available"):
        broad.run_broad_backtest(**common, execution="mon_10am")


@pytest.mark.parametrize("dataset", ["stock", "custom_index"])
def test_stock_and_custom_index_refuse_a_monday_fill_instead_of_ignoring_it(dataset):
    from fastapi import HTTPException

    from momentum_backtesting import api

    body = {"dataset": dataset, "universe": ["x"]}
    api._refuse_monday_fill(api.BacktestRequest.model_validate(body), dataset)  # Friday close: fine
    monday = api.BacktestRequest.model_validate({**body, "execution": "mon_open"})
    with pytest.raises(HTTPException) as caught:
        api._refuse_monday_fill(monday, dataset)
    assert caught.value.status_code == 422 and "not available" in caught.value.detail


def test_a_live_decision_is_made_on_the_friday_close_twin_of_a_monday_request():
    from momentum_backtesting import api

    friday = api.BacktestRequest.model_validate(
        {"dataset": "broad", "universe": ["broad_momentum"]}
    )
    monday = friday.model_copy(update={"execution": "mon_open"})
    assert api._decision_request(friday) is friday
    assert api._decision_request(monday).execution == "fri_close"
    assert monday.execution == "mon_open"  # the request itself is not changed


# --- BL-176: the Monday close ------------------------------------------------------------------


def moves_with_close(moves: dict[str, dict[str, float]]) -> daily_moves.DailyMoves:
    """Like `moves_with`, but the values are the session's close move; the open gap is 0."""
    built = moves_with(moves)
    zeros = built.open_gap * 0.0
    return daily_moves.DailyMoves(move=built.open_gap, open_gap=zeros, locked=built.locked)


def test_a_monday_close_fill_moves_the_friday_close_by_the_first_sessions_close(
    monkeypatch, tmp_path
):
    prices = pd.DataFrame({"AAA": [100.0, 110.0, 120.0, 130.0]}, index=FRIDAYS)
    table = moves_with_close({"AAA": {"2024-01-08": 0.03, "2024-01-23": -0.04}})
    monkeypatch.setattr(monday_fills.daily_moves, "daily_moves", lambda *a, **k: table)
    close = monday_fills.build(
        prices, {"AAA": "AAA"}, execution="mon_close", data_dir=tmp_path
    ).prices
    assert close["AAA"].iloc[0] == pytest.approx(100.0 * 1.03)  # Monday 01-08's close
    assert close["AAA"].iloc[1] == pytest.approx(110.0)  # no move that Monday
    assert close["AAA"].iloc[2] == pytest.approx(120.0 * 0.96)  # Tuesday 01-23 after the holiday
    # The open reads the gap table, which is all 0 here: the two fills are built independently.
    opened = monday_fills.build(prices, {"AAA": "AAA"}, data_dir=tmp_path).prices
    assert opened["AAA"].tolist() == prices["AAA"].tolist()


def test_a_column_with_a_daily_file_uses_its_monday_close(stub, tmp_path):
    daily = tmp_path / "daily"
    daily.mkdir()
    days = pd.DatetimeIndex(["2024-01-05", "2024-01-08", "2024-01-12", "2024-01-15"])
    pd.DataFrame(
        {"open": [50.0, 51.0, 52.0, 53.0], "close": [50.5, 51.5, 52.5, 53.5]}, index=days
    ).to_csv(daily / "Gold.csv")
    prices = pd.DataFrame({"AAA": [100.0, 100.0], "Gold": [50.5, 52.5]}, index=FRIDAYS[:2])
    stub({"AAA": {}})
    built = monday_fills.build(prices, {"AAA": "AAA"}, execution="mon_close", data_dir=tmp_path)
    assert built.prices["Gold"].tolist() == [51.5, 53.5]  # the two Mondays' closes


def test_monday_fills_refuse_a_fill_they_cannot_build(tmp_path):
    prices = pd.DataFrame({"AAA": [100.0]}, index=FRIDAYS[:1])
    with pytest.raises(ValueError, match="no Monday fill"):
        monday_fills.build(prices, {"AAA": "AAA"}, execution="fri_close", data_dir=tmp_path)


def test_broad_refuses_a_monday_close_with_a_signal_delay():
    common = dict(
        outer_prices=pd.DataFrame(),
        stocks_data_dir=Path("."),
        categories_data_dir=Path("."),
        curated_dir=Path("."),
    )
    with pytest.raises(ValueError, match="signal delay 0"):
        broad.run_broad_backtest(**common, execution="mon_close", signal_delay=1)


def test_the_api_accepts_a_monday_close_and_decides_it_on_friday():
    from momentum_backtesting import api

    monday = api.BacktestRequest.model_validate(
        {"dataset": "broad", "universe": ["broad_momentum"], "execution": "mon_close"}
    )
    assert api._decision_request(monday).execution == "fri_close"


def test_a_score_folder_holds_one_set_of_ids(tmp_path):
    from momentum_backtesting import method

    results = tmp_path / "results"
    results.mkdir()
    space = Path(__file__).resolve().parents[1] / "search_spaces" / "round8_A_curated.toml"
    dest = tmp_path / "scored"
    method.score_search(space, results, dest, workers=1, ids={"a", "b"}, echo=lambda *_: None)
    method.score_search(space, results, dest, workers=1, ids={"b", "a"}, echo=lambda *_: None)
    with pytest.raises(SystemExit, match="another set of ids"):
        method.score_search(space, results, dest, workers=1, ids={"a"}, echo=lambda *_: None)
