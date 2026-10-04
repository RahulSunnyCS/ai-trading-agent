"""Bias-check helpers (the pure parts; the full check runs against real market data)."""

import numpy as np
import pandas as pd

from momentum_backtesting import bias


def test_shuffled_ranks_is_a_permutation_per_week_and_keeps_missing_names_missing():
    idx = pd.date_range("2024-01-05", periods=4, freq="7D")
    ranks = pd.DataFrame(
        {"A": [1, 2, np.nan, 1], "B": [2, 1, 1, 2], "C": [3, np.nan, 2, 3], "D": [4, 3, 3, 4]},
        index=idx,
        dtype=float,
    )
    out = bias.shuffled_ranks(ranks, seed=1)
    assert (out.isna() == ranks.isna()).all().all()
    for week in idx:
        n = ranks.loc[week].notna().sum()
        assert sorted(out.loc[week].dropna()) == list(range(1, n + 1))
    again = bias.shuffled_ranks(ranks, seed=1)
    assert out.equals(again) and not out.equals(bias.shuffled_ranks(ranks, seed=2))


def test_profit_by_stock_sums_split_segments_into_one_company():
    class R:
        trades = pd.DataFrame(
            {
                "action": ["BUY", "SELL", "SELL", "SELL"],
                "asset": ["AAA", "AAA", "AAA#2", "BBB"],
                "value": [0.1, 0.15, 0.12, 0.08],
                "entry_value": [np.nan, 0.10, 0.10, 0.10],
            }
        )

    class Outcome:
        result = R

    class K:
        column_to_base_symbol = {"AAA": "AAA", "AAA#2": "AAA", "BBB": "BBB"}

    pnl = bias.profit_by_stock(Outcome, K)
    assert round(pnl["AAA"], 6) == 0.07 and round(pnl["BBB"], 6) == -0.02
    assert list(pnl.index) == ["AAA", "BBB"]


def test_block_mask_covers_every_segment_of_the_named_companies():
    idx = pd.date_range("2024-01-05", periods=3, freq="7D")

    class K:
        prices = pd.DataFrame(1.0, index=idx, columns=["AAA", "AAA#2", "BBB", "GOLD"])
        column_to_base_symbol = {"AAA": "AAA", "AAA#2": "AAA", "BBB": "BBB"}

    mask = bias.block_mask(K, ["AAA"])
    assert mask[["AAA", "AAA#2"]].all().all() and not mask[["BBB", "GOLD"]].any().any()


def test_pick_configs_returns_distinct_ids_and_respects_the_turnover_filter():
    n = 60
    rng = np.random.default_rng(0)
    df = pd.DataFrame(
        {
            "id": [f"r{i}" for i in range(n)],
            "error": [None] * n,
            "cagr": np.linspace(0.05, 0.40, n),
            "mdd": -np.linspace(0.40, 0.10, n),
            "calmar": rng.random(n) + 0.5,
            "turnover_x": np.where(np.arange(n) == n - 1, 9.0, 1.0),  # the best run trades too much
            "buys_per_yr": 50.0,
        }
    )
    picks = bias.pick_configs(df)
    assert len(set(picks.values())) == len(picks)
    assert f"r{n - 1}" not in picks.values()
    assert {"top_cagr", "median_typical"} <= set(picks)
