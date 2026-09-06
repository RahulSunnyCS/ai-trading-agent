from datetime import date
from pathlib import Path

from option_backtesting.engine.registry import list_runs, record_run, strategy_hash
from option_backtesting.engine.result import AggregateResult
from option_backtesting.strategy.loader import load_strategy

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


def _aggregate_result() -> AggregateResult:
    return AggregateResult(
        net_inr=1000.0,
        gross_inr=1200.0,
        win_days=3,
        worst_day=-200.0,
        sum_peak_loss=-500.0,
        worst_intraday_mtm=-300.0,
        lot_days=10.0,
        inr_per_lot_day=100.0,
        dte_buckets={0: 500.0, 1: 500.0},
        sessions=[],
    )


def test_record_and_list_a_run(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    db_path = tmp_path / "registry.sqlite"
    run_id = record_run(
        db_path, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
    )

    runs = list_runs(db_path)
    assert len(runs) == 1
    assert runs[0].run_id == run_id
    assert runs[0].strategy_id == "nifty_flat_A"
    assert runs[0].net_inr == 1000.0
    assert runs[0].win_days == 3


def test_list_runs_on_nonexistent_db_returns_empty(tmp_path) -> None:
    assert list_runs(tmp_path / "does_not_exist.sqlite") == []


def test_multiple_runs_ordered_most_recent_first(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    db_path = tmp_path / "registry.sqlite"
    first_id = record_run(
        db_path, loaded.strategy, date(2026, 8, 17), date(2026, 8, 20), _aggregate_result()
    )
    second_id = record_run(
        db_path, loaded.strategy, date(2026, 8, 21), date(2026, 9, 4), _aggregate_result()
    )
    runs = list_runs(db_path)
    assert [r.run_id for r in runs] in ([second_id, first_id], [first_id, second_id])
    assert len(runs) == 2


def test_strategy_hash_changes_when_strategy_changes(tmp_path) -> None:
    a = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    b = load_strategy(STRATEGIES_DIR / "B_pyramid.yaml").strategy
    assert strategy_hash(a) != strategy_hash(b)


def test_strategy_hash_is_stable_for_the_same_strategy() -> None:
    a1 = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    a2 = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    assert strategy_hash(a1) == strategy_hash(a2)
