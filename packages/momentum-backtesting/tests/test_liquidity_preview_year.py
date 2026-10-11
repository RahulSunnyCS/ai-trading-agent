"""The liquidity preview counts the universe the run uses for its newest weeks.

`turnover_rank_members_by_year` keys year Y on July-December of Y-1, so once a symbol has 60
sessions after 1 July it also returns Y+1, built from a part-year. The preview used
`max(members)` and so counted next year's list, which no week of the run has reached.
"""

from __future__ import annotations

from datetime import date

import pandas as pd
import pytest
from test_audit_replay import _sessions
from trading_data.db import connect

from momentum_backtesting import api
from momentum_backtesting.categories import liquidity


@pytest.fixture
def two_year_market(tmp_path, monkeypatch):
    """AAA and BBB trade from January 2020; CCC lists in January 2021. Bars end in October
    2021, so the 2021 list is {AAA, BBB} (their 2020 H2) and a part-year 2022 list also holds
    CCC (its 2021 H2)."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    starts = {"AAA": date(2020, 1, 1), "BBB": date(2020, 1, 1), "CCC": date(2021, 1, 4)}
    with connect(tmp_path) as con:
        ids = {
            symbol: con.execute(
                "INSERT INTO instruments (instrument_key, asset_class, exchange, symbol) "
                "VALUES (?, 'stock', 'NSE', ?) RETURNING instrument_id",
                [f"stock:NSE:{symbol}", symbol],
            ).fetchone()[0]
            for symbol in starts
        }
    rows = []
    for symbol, start in starts.items():
        for day in _sessions(start, date(2021, 10, 29)):
            rows.append(
                {
                    "instrument_id": ids[symbol],
                    "date": day,
                    "series": "EQ",
                    "isin": f"INE{symbol}",
                    "open": 100.0,
                    "high": 101.0,
                    "low": 99.0,
                    "close": 100.0,
                    "prevclose": 100.0,
                    "volume": 100_000,
                    "turnover": 50_000_000.0,
                    "synthetic_close": False,
                }
            )
    frame = pd.DataFrame(rows)
    frame["date"] = pd.to_datetime(frame["date"])
    for year, part in frame.groupby(frame["date"].dt.year):
        path = tmp_path / "lake" / "bars_1d" / "asset=stock" / f"year={year}" / "data.parquet"
        path.parent.mkdir(parents=True)
        part.to_parquet(path, index=False)
    return tmp_path


def test_the_fixture_has_a_part_year_list_for_the_year_after_the_last_bar(two_year_market):
    members = liquidity.turnover_rank_members_by_year(root=two_year_market)
    assert members[2021] == {"AAA", "BBB"}
    assert members[2022] == {"AAA", "BBB", "CCC"}
    assert liquidity.latest_bar_year(two_year_market) == 2021


def test_preview_counts_the_list_the_runs_newest_weeks_use(two_year_market):
    payload = api._liquidity_preview_payload(liquidity.LiquidityConfig(), "turnover_rank")
    assert payload["universe"] == 2  # 2021's list, not the part-year 2022 list of three


def test_member_year_in_force():
    members = {2024: {"A"}, 2025: {"A", "B"}, 2026: {"A", "B", "C"}, 2027: {"D"}}
    assert liquidity.member_year_in_force(members, 2026) == 2026
    assert liquidity.member_year_in_force(members, 2028) == 2027  # newest at or before
    assert liquidity.member_year_in_force({2022: {"A"}}, 2021) == 2022  # nothing earlier
    assert liquidity.member_year_in_force(members, None) == 2027
