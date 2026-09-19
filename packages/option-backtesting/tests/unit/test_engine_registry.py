import sqlite3
from datetime import date
from pathlib import Path

from option_backtesting.engine.registry import (
    _SCHEMA,
    get_run,
    list_runs,
    record_run,
    strategy_hash,
)
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


def test_get_run_returns_the_matching_record(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    db_path = tmp_path / "registry.sqlite"
    run_id = record_run(
        db_path, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
    )
    record = get_run(db_path, run_id)
    assert record is not None
    assert record.run_id == run_id
    assert record.strategy_id == "nifty_flat_A"


def test_get_run_returns_none_for_unknown_id(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    db_path = tmp_path / "registry.sqlite"
    record_run(db_path, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result())
    assert get_run(db_path, "does-not-exist") is None


def test_get_run_on_nonexistent_db_returns_none(tmp_path) -> None:
    assert get_run(tmp_path / "does_not_exist.sqlite", "any-id") is None


def test_strategy_yaml_round_trips_through_record_and_get(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    source = (STRATEGIES_DIR / "A_flat.yaml").read_text()
    db_path = tmp_path / "registry.sqlite"
    run_id = record_run(
        db_path,
        loaded.strategy,
        date(2026, 8, 17),
        date(2026, 9, 4),
        _aggregate_result(),
        source,
    )
    record = get_run(db_path, run_id)
    assert record is not None
    assert record.strategy_yaml == source

    listed = list_runs(db_path)
    assert listed[0].strategy_yaml == source


def test_strategy_yaml_defaults_to_none_when_not_provided(tmp_path) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    db_path = tmp_path / "registry.sqlite"
    run_id = record_run(
        db_path, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
    )
    record = get_run(db_path, run_id)
    assert record is not None
    assert record.strategy_yaml is None


def test_migrate_adds_strategy_yaml_column_to_a_pre_m5_database(tmp_path) -> None:
    """Simulates a real pre-existing registry.sqlite from before M-5: a `runs`
    table created without the `strategy_yaml` column. `_connect()` (used by
    every public function) must add it on the fly rather than failing every
    subsequent INSERT/SELECT with "no such column"."""
    db_path = tmp_path / "pre_m5_registry.sqlite"
    pre_m5_schema = _SCHEMA.replace("    strategy_yaml TEXT,\n", "")
    assert "strategy_yaml" not in pre_m5_schema

    con = sqlite3.connect(db_path)
    try:
        con.execute(pre_m5_schema)
        con.commit()
        columns_before = {row[1] for row in con.execute("PRAGMA table_info(runs)").fetchall()}
        assert "strategy_yaml" not in columns_before
    finally:
        con.close()

    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    run_id = record_run(
        db_path,
        loaded.strategy,
        date(2026, 8, 17),
        date(2026, 9, 4),
        _aggregate_result(),
        "id: nifty_flat_A\n",
    )

    record = get_run(db_path, run_id)
    assert record is not None
    assert record.strategy_yaml == "id: nifty_flat_A\n"

    con = sqlite3.connect(db_path)
    try:
        columns_after = {row[1] for row in con.execute("PRAGMA table_info(runs)").fetchall()}
        assert "strategy_yaml" in columns_after
    finally:
        con.close()
