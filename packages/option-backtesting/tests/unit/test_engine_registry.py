from datetime import date
from pathlib import Path

from trading_data.db import connect

from option_backtesting.engine.registry import get_run, list_runs, record_run, strategy_hash
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


def test_record_and_list_a_run() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        run_id = record_run(
            con, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
        )
        runs = list_runs(con)
    assert len(runs) == 1
    assert runs[0].run_id == run_id
    assert runs[0].strategy_id == "nifty_flat_A"
    assert runs[0].net_inr == 1000.0
    assert runs[0].win_days == 3


def test_list_runs_on_a_fresh_catalog_returns_empty() -> None:
    with connect() as con:
        assert list_runs(con) == []


def test_multiple_runs_ordered_most_recent_first() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        first_id = record_run(
            con, loaded.strategy, date(2026, 8, 17), date(2026, 8, 20), _aggregate_result()
        )
        second_id = record_run(
            con, loaded.strategy, date(2026, 8, 21), date(2026, 9, 4), _aggregate_result()
        )
        runs = list_runs(con)
    assert [r.run_id for r in runs] in ([second_id, first_id], [first_id, second_id])
    assert len(runs) == 2


def test_strategy_hash_changes_when_strategy_changes() -> None:
    a = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    b = load_strategy(STRATEGIES_DIR / "B_pyramid.yaml").strategy
    assert strategy_hash(a) != strategy_hash(b)


def test_strategy_hash_is_stable_for_the_same_strategy() -> None:
    a1 = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    a2 = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
    assert strategy_hash(a1) == strategy_hash(a2)


def test_get_run_returns_the_matching_record() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        run_id = record_run(
            con, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
        )
        record = get_run(con, run_id)
    assert record is not None
    assert record.run_id == run_id
    assert record.strategy_id == "nifty_flat_A"


def test_get_run_returns_none_for_unknown_id() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        record_run(con, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result())
        assert get_run(con, "does-not-exist") is None


def test_get_run_on_a_fresh_catalog_returns_none() -> None:
    with connect() as con:
        assert get_run(con, "any-id") is None


def test_strategy_yaml_round_trips_through_record_and_get() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    source = (STRATEGIES_DIR / "A_flat.yaml").read_text()
    with connect() as con:
        run_id = record_run(
            con,
            loaded.strategy,
            date(2026, 8, 17),
            date(2026, 9, 4),
            _aggregate_result(),
            source,
        )
        record = get_run(con, run_id)
        assert record is not None
        assert record.strategy_yaml == source

        listed = list_runs(con)
    assert listed[0].strategy_yaml == source


def test_strategy_yaml_defaults_to_none_when_not_provided() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        run_id = record_run(
            con, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result()
        )
        record = get_run(con, run_id)
    assert record is not None
    assert record.strategy_yaml is None


def test_rerunning_the_same_strategy_reuses_the_strategy_version() -> None:
    """A version is `strategy_id:spec_hash` — re-running the exact same validated spec
    (even with different result numbers) must not create a second strategy_versions row,
    mirroring the same behaviour already relied on by legwise/store.py and
    momentum_backtesting/runs_store.py."""
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        first = record_run(
            con, loaded.strategy, date(2026, 8, 17), date(2026, 8, 20), _aggregate_result()
        )
        second = record_run(
            con, loaded.strategy, date(2026, 8, 21), date(2026, 9, 4), _aggregate_result()
        )
        rows = con.execute(
            "SELECT version_id FROM backtest_runs WHERE run_id IN (?, ?)", [first, second]
        ).fetchall()
    assert rows[0][0] == rows[1][0]


def test_strategy_id_is_namespaced_in_the_shared_catalog() -> None:
    """`strategies.strategy_id` is a global primary key shared with legwise
    (`options_legwise`) and momentum (`momentum`) — the DSL engine's own ids must not
    collide with either, hence the `dsl:` prefix (see registry.py's module docstring)."""
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with connect() as con:
        record_run(con, loaded.strategy, date(2026, 8, 17), date(2026, 9, 4), _aggregate_result())
        row = con.execute(
            "SELECT strategy_id, package FROM strategies WHERE package = 'options_dsl'"
        ).fetchone()
    assert row is not None
    assert row[0] == "dsl:nifty_flat_A"
    assert row[1] == "options_dsl"
