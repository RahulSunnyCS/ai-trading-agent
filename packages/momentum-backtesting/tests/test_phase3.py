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
