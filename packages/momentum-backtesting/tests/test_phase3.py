"""BL-010 Phase 3: the point-in-time universe and the category-shuffle placebo."""

from __future__ import annotations

import csv
from collections import Counter

from test_audit_replay import small_market  # noqa: F401 - the fixture

from momentum_backtesting import category_shuffle
from momentum_backtesting.categories import liquidity
from momentum_backtesting.categories.broad import STOCK_GROUPS_FILENAME
from momentum_backtesting.config import PACKAGE_ROOT

CURATED = PACKAGE_ROOT / "src" / "momentum_backtesting" / "categories" / "curated"


def test_turnover_rank_uses_only_the_year_before(small_market):  # noqa: F811
    members = liquidity.turnover_rank_members_by_year(top=2, root=small_market)
    # The fixture trades through 2021, so 2022 is the only year that can be ranked: it needs
    # sixty sessions in the second half of the year before.
    assert set(members) == {2022}
    assert len(members[2022]) == 2
    everyone = liquidity.turnover_rank_members_by_year(top=10, root=small_market)
    assert everyone[2022] == {"AAA", "BBB", "CCC", "DDD"}


def _groups(path) -> list[tuple[str, str]]:
    with path.open(newline="") as handle:
        return [
            (f"{r['parent_group']} :: {r['subgroup']}", r["symbol"]) for r in csv.DictReader(handle)
        ]


def test_shuffled_groups_keep_every_size_and_only_move_the_stocks(tmp_path):
    source = CURATED / STOCK_GROUPS_FILENAME
    target = tmp_path / STOCK_GROUPS_FILENAME
    category_shuffle.shuffled_groups(source, target, seed=3)
    real, dealt = _groups(source), _groups(target)
    assert Counter(c for c, _ in real) == Counter(c for c, _ in dealt)  # category sizes
    assert Counter(s for _, s in real) == Counter(s for _, s in dealt)  # tags per stock
    assert len(set(dealt)) == len(dealt)  # no stock twice in one category
    moved = sum(a != b for a, b in zip(real, dealt, strict=True))
    assert moved > 0.9 * len(real)

    again = tmp_path / "again.csv"
    category_shuffle.shuffled_groups(source, again, seed=3)
    assert again.read_text() == target.read_text()  # a seed names one dealing


def test_shuffle_summary_reads_the_real_run_against_the_dealt_ones(tmp_path):
    out = tmp_path / "shuffle.jsonl"
    rows = [{"label": "x", "id": "1", "seed": -1, "cagr": 0.30, "mdd": -0.2}]
    rows += [
        {"label": "x", "id": "1", "seed": i, "cagr": 0.10 + i / 100, "mdd": -0.2} for i in range(20)
    ]
    import json

    out.write_text("\n".join(json.dumps(r) for r in rows))
    row = category_shuffle.summary(out)["x"]
    assert row["real"] == 0.30 and row["shuffles"] == 20
    assert round(row["shuffled_max"], 6) == 0.29
    assert row["beaten_by"] == 0 and row["beats_p95"]


# --- Phase 4: probability of backtest overfitting ----------------------------------------------


def test_pbo_is_a_coin_flip_on_noise_and_near_zero_when_one_config_is_really_better():
    import numpy as np

    from momentum_backtesting import method

    rng = np.random.default_rng(11)
    noise = rng.normal(0.0, 0.03, size=(480, 200))
    result = method.pbo(noise)
    assert result["splits"] == 12870 and result["configs"] == 200
    assert 0.35 < result["pbo"] < 0.65  # the in-sample winner is no better than chance later

    skilled = noise.copy()
    skilled[:, 7] += 0.01  # one config with a real edge every week
    result = method.pbo(skilled)
    assert result["pbo"] < 0.02 and result["picked_oos_negative"] < 0.02
    assert result["picked_oos_median"] > 0


def test_excess_log_returns_are_measured_against_the_benchmark():
    import numpy as np
    import pandas as pd

    from momentum_backtesting import method

    weeks = pd.date_range("2021-01-01", periods=5, freq="W-FRI")
    curves = pd.DataFrame({"a": [1.0, 1.1, 1.21, 1.331, 1.4641], "b": [1.0] * 5}, index=weeks)
    bench = pd.Series([100.0, 110.0, 121.0, 133.1, 146.41], index=weeks)
    excess = method.excess_log_returns(curves, bench)
    assert np.allclose(excess["a"], 0.0)  # grew exactly with the benchmark
    assert np.allclose(excess["b"], -np.log(1.1))
