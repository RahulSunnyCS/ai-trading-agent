import duckdb
import pandas as pd

from momentum_backtesting import stock_actions


def _con():
    con = duckdb.connect(":memory:")
    con.execute(
        "CREATE TABLE stock_action_candidates "
        "(symbol VARCHAR, ex_date DATE, event_kind VARCHAR, status VARCHAR)"
    )
    con.execute(
        "INSERT INTO stock_action_candidates VALUES "
        "('DEMERG', DATE '2022-05-10', 'demerger', 'review'),"
        "('SPLIT', DATE '2022-05-10', 'split', 'confirmed'),"
        "('CRASH', DATE '2022-05-10', NULL, 'crash'),"
        "('RIGHTS', DATE '2022-06-01', 'rights', 'crash')"
    )
    return con


def test_explained_breaks_returns_only_unadjustable_actions_with_a_date_window():
    out = stock_actions.explained_breaks(
        _con(), ["DEMERG", "SPLIT", "CRASH", "RIGHTS"], slack_days=3
    )
    assert ("DEMERG", pd.Timestamp("2022-05-10")) in out
    assert ("DEMERG", pd.Timestamp("2022-05-13")) in out  # +3 days
    assert ("DEMERG", pd.Timestamp("2022-05-14")) not in out  # outside the window
    # Confirmed splits are back-adjusted elsewhere, crashes are genuine falls, and a candidate
    # already classified as a crash stays one even when its kind is a rights issue.
    assert not any(symbol in ("SPLIT", "CRASH", "RIGHTS") for symbol, _ in out)


def test_explained_breaks_with_no_symbols_is_empty():
    assert stock_actions.explained_breaks(_con(), []) == set()
