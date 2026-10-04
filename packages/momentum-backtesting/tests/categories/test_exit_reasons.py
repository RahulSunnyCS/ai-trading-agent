import numpy as np
import pandas as pd

from momentum_backtesting.categories import exit_reasons, liquidity
from momentum_backtesting.categories.broad import UniverseRanking

WEEKS = list(pd.date_range("2020-01-03", periods=20, freq="7D"))  # spans the 27 Mar quarter-end
SOLD = WEEKS[16]  # the engine's exit week; with signal_delay=1 the decision week is WEEKS[15]
DECISION = WEEKS[15]


def _ranking():
    cols = ["LIQ", "POOL", "CAT", "OLD", "OLD#2"]
    nan = np.nan
    glob = pd.DataFrame(nan, index=WEEKS, columns=[*cols, "Gold"])
    glob.loc[:, "LIQ"] = 30.0
    glob.loc[:, "POOL"] = 400.0
    glob.loc[:, "CAT"] = 60.0
    glob.loc[:, "OLD"] = 75.0
    pool = pd.DataFrame(False, index=WEEKS, columns=cols)
    pool.loc[:, "CAT"] = True
    pool_ranks = pd.DataFrame(nan, index=WEEKS, columns=cols)
    pool_ranks.loc[:, "CAT"] = 55.0
    gate = pd.DataFrame(True, index=WEEKS, columns=cols)
    gate.loc[DECISION, "LIQ"] = False
    combined = pd.DataFrame(nan, index=WEEKS, columns=[*cols, "Gold"])
    combined.loc[:, "Gold"] = 12.0
    events = pd.DataFrame(
        {
            "symbol": ["OLD"],
            "event_date": [WEEKS[5]],
            "drop_pct": [-0.2],
            "turnover_ratio": [1.0],
            "new_column": ["OLD#2"],
        }
    )
    return UniverseRanking(
        prices=glob,
        weeks=WEEKS,
        global_ranks=glob,
        pool_membership=pool,
        stock_pool_ranks=pool_ranks,
        combined_pool_ranks=combined,
        column_to_base_symbol={c: c.split("#")[0] for c in cols},
        events=events,
        stale_columns={},
        missing_symbols=[],
        liquidity_gate=gate,
    )


def _rows():
    sold = SOLD.strftime("%Y-%m-%d")
    return [
        {"asset": a, "exit_week": sold, "exit_rank": None, "reason": "ineligible"}
        for a in ("LIQ", "POOL", "CAT", "OLD", "Gold")
    ] + [{"asset": "CAT", "exit_week": sold, "exit_rank": 12, "reason": "rank 12 > 10"}]


def test_each_blank_exit_gets_a_cause_a_rank_and_a_specific_reason(monkeypatch):
    feature = pd.DataFrame(
        [
            {
                "symbol": "LIQ",
                "wk": DECISION,
                "n60": 60,
                "noneq60": 0,
                "zero60": 0,
                "med60": 1.3,
                "p10_60": 0.9,
                "px": 100.0,
                "maxrun125": 0,
                "bandhits60": 0,
            }
        ]
    )
    monkeypatch.setattr(liquidity, "compute_weekly_features", lambda symbols, root=None: feature)
    rows = _rows()
    exit_reasons.explain_exits(
        rows,
        ranking=_ranking(),
        held_by_week={DECISION: ["Some other category"]},
        group_members={"Sector :: Cats": {"CAT"}},
        signal_delay=1,
        pool_exit_rank=268,
        picks_per_category=2,
        liquidity_cfg=liquidity.LiquidityConfig(min_turnover_cr=2.0),
    )
    by = {r["asset"]: r for r in rows[:5]}
    assert by["LIQ"]["exit_cause"] == "liquidity"
    assert "median daily turnover Rs 1.30 cr below the Rs 2 cr gate" in by["LIQ"]["reason"]
    assert by["LIQ"]["exit_rank"] == 30  # nothing is left blank
    assert by["POOL"]["exit_cause"] == "pool"
    assert "past the pool exit rank 268" in by["POOL"]["reason"]
    assert by["POOL"]["exit_rank"] == 400
    assert by["CAT"]["exit_cause"] == "category"
    assert "Cats" in by["CAT"]["reason"] and by["CAT"]["exit_rank"] == 55
    assert by["OLD"]["exit_cause"] == "series_break"
    assert "20.0% one-day drop" in by["OLD"]["reason"]
    assert by["Gold"]["exit_cause"] == "category" and by["Gold"]["exit_rank"] == 12


def test_rows_that_already_have_a_rank_and_reason_are_left_alone(monkeypatch):
    monkeypatch.setattr(liquidity, "compute_weekly_features", lambda *a, **k: pd.DataFrame())
    rows = _rows()
    exit_reasons.explain_exits(
        rows,
        ranking=_ranking(),
        held_by_week={DECISION: []},
        group_members={},
        signal_delay=1,
        pool_exit_rank=268,
        picks_per_category=2,
        liquidity_cfg=None,
    )
    assert rows[-1]["reason"] == "rank 12 > 10" and rows[-1]["exit_rank"] == 12
    assert "exit_cause" not in rows[-1]
