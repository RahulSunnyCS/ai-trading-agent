"""BL-024: the forward-signal journal is append-only, idempotent on reruns, and tamper-evident,
and every weekly run records into it without ever losing the signal itself."""

from datetime import datetime

import pandas as pd
import pytest
from trading_data.db import connect

from momentum_backtesting import api, forward_journal, fyers, notify, reference_benchmarks, weekly
from momentum_backtesting.notify import IST, Notification
from momentum_backtesting.stocks.ui_data import NIFTY200_MOMENTUM30_TRI


def _entry(week="2026-10-09", run_kind="final", config_id="fav-1", weights=None, **signal_extra):
    weights = weights if weights is not None else {"Nifty IT": 0.5, "Gold": 0.5}
    return forward_journal.Entry(
        week=week,
        run_kind=run_kind,
        source="favourite",
        config_id=config_id,
        config_name="ETF Weekly Core",
        dataset="etf",
        settings={"top_n": 2, "lookbacks": [4, 13]},
        holdings_before=weights,
        signal={"week": week, "rows": [{"asset": "Nifty IT", "action": "BUY"}], **signal_extra},
        data_fingerprint="weekly_closes:sha256:abc",
        code_commit="deadbeef",
    )


def test_entries_chain_from_genesis_and_verify_clean():
    with connect() as con:
        first = forward_journal.record(con, _entry(config_id="a"))
        second = forward_journal.record(con, _entry(config_id="b"))
        rows = forward_journal.entries(con)
        assert (first, second) == (1, 2)
        assert rows[0]["prev_hash"] == forward_journal.GENESIS
        assert rows[1]["prev_hash"] == rows[0]["row_hash"]
        assert forward_journal.verify(con) == []
        assert forward_journal.head(con) == (2, rows[1]["row_hash"])


def test_a_rerun_with_the_same_signal_records_nothing():
    with connect() as con:
        assert forward_journal.record(con, _entry()) == 1
        assert forward_journal.record(con, _entry()) is None
        assert len(forward_journal.entries(con)) == 1


def test_a_changed_signal_is_a_new_row_that_supersedes_the_old_one():
    with connect() as con:
        forward_journal.record(con, _entry())
        forward_journal.record(con, _entry(weights={"Gold": 1.0}))
        old, new = forward_journal.entries(con)
        assert old["holdings_before"] == '{"Gold":0.5,"Nifty IT":0.5}'  # the original is untouched
        assert new["supersedes"] == old["entry_id"]
        assert forward_journal.verify(con) == []


def test_the_same_config_in_another_week_or_run_is_not_a_correction():
    with connect() as con:
        forward_journal.record(con, _entry(week="2026-10-09"))
        forward_journal.record(con, _entry(week="2026-10-16"))
        forward_journal.record(con, _entry(week="2026-10-16", run_kind="preview"))
        assert [r["supersedes"] for r in forward_journal.entries(con)] == [None, None, None]


def test_an_edited_row_is_detected():
    """The database cannot refuse an UPDATE (DuckDB has no triggers); the chain must expose it."""
    with connect() as con:
        forward_journal.record(con, _entry(config_id="a"))
        forward_journal.record(con, _entry(config_id="b"))
        con.execute(
            "UPDATE momentum_forward_journal SET holdings_before = '{\"Gold\":1.0}' "
            "WHERE entry_id = 1"
        )
        assert forward_journal.verify(con) == ["entry 1: its contents were changed after recording"]


def test_an_edit_that_also_rewrites_the_hash_breaks_the_next_link():
    with connect() as con:
        forward_journal.record(con, _entry(config_id="a"))
        forward_journal.record(con, _entry(config_id="b"))
        row = forward_journal.entries(con)[0]
        row["holdings_before"] = '{"Gold":1.0}'
        forged = forward_journal._row_hash(row)
        con.execute(
            "UPDATE momentum_forward_journal SET holdings_before = ?, row_hash = ? "
            "WHERE entry_id = 1",
            [row["holdings_before"], forged],
        )
        assert forward_journal.verify(con) == ["entry 2: does not follow the entry before it"]


def test_a_removed_row_is_detected():
    with connect() as con:
        for config_id in ("a", "b", "c"):
            forward_journal.record(con, _entry(config_id=config_id))
        con.execute("DELETE FROM momentum_forward_journal WHERE entry_id = 2")
        problems = forward_journal.verify(con)
        assert "entry 2 is missing (next stored entry is 3)" in problems
        assert "entry 3: does not follow the entry before it" in problems


def test_nan_and_numpy_values_are_stored_as_valid_json():
    import numpy as np

    with connect() as con:
        forward_journal.record(con, _entry(score=float("nan"), rank=np.int64(3)))
        (row,) = forward_journal.entries(con)
        assert '"score":null' in row["signal"] and '"rank":3' in row["signal"]
        assert forward_journal.verify(con) == []


# --- the weekly run ------------------------------------------------------------------------------


def _signal(week="2026-10-09", weights=None):
    return {
        "week": week,
        "label": "lbl",
        "rows": [{"asset": "Nifty IT", "action": "BUY", "rank": 1}],
        "weights": weights or {"Nifty IT": 1.0},
        "config": {"top_n": 1},
    }


def _outcome(id_, name, dataset, active, signal):
    result = None
    if signal is not None:
        result = weekly.RunResult(Notification("momentum-weekly", "info", name, "signal"), signal)
    return {
        "id": id_,
        "name": name,
        "dataset": dataset,
        "active": active,
        "result": result,
        "blocked": None if signal else "blocked",
    }


@pytest.fixture
def weekly_env(monkeypatch):
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    monkeypatch.setattr(notify, "run_url", lambda: None)
    monkeypatch.setattr(
        reference_benchmarks, "load_references", lambda *a, **k: pd.DataFrame(dtype=float)
    )
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)
    return sent


def test_a_final_run_journals_the_signal_and_witnesses_it_in_the_telegram_message(
    weekly_env, monkeypatch
):
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *a, **k: [_outcome("etf-1", "ETF Weekly Core", "etf", True, _signal())],
    )
    result = api._execute_weekly_run(api.WeeklyRunBody(run="final", send=True))

    assert result["journal"]["recorded"] == ["ETF Weekly Core"]
    assert len(weekly_env) == 1
    assert "Forward journal: 1 new entry recorded; chain of 1, head" in weekly_env[0].body
    with connect() as con:
        (row,) = forward_journal.entries(con)
    assert (row["config_id"], row["run_kind"], row["week"]) == ("etf-1", "final", "2026-10-09")
    assert row["holdings_before"] == '{"Nifty IT":1.0}'

    # A rerun on the same data (e.g. the 19:30 job, or a dashboard trigger) adds nothing.
    weekly_env.clear()
    again = api._execute_weekly_run(api.WeeklyRunBody(run="final", send=True))
    assert again["journal"]["recorded"] == []
    assert "Forward journal" not in weekly_env[0].body


def test_blocked_favourites_are_not_journalled(weekly_env, monkeypatch):
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *a, **k: [_outcome("etf-1", "ETF Weekly Core", "etf", True, None)],
    )
    result = api._execute_weekly_run(api.WeeklyRunBody(run="final", send=False))
    assert result["journal"]["recorded"] == []


def test_a_preview_is_journalled_only_on_a_friday(monkeypatch):
    monkeypatch.setattr(forward_journal, "code_commit", lambda: "x")
    outcomes = [_outcome("etf-1", "ETF Weekly Core", "etf", True, _signal())]
    thursday = datetime(2026, 10, 8, 14, 40, tzinfo=IST)
    friday = datetime(2026, 10, 9, 14, 40, tzinfo=IST)
    entries, notes = api._journal_entries("preview", outcomes, {}, thursday, None)
    assert entries == [] and "Thursday" in notes[0]
    entries, _ = api._journal_entries("preview", outcomes, {}, friday, None)
    assert [e.run_kind for e in entries] == ["preview"]


def test_the_benchmark_level_is_journalled_once_its_data_covers_the_week(monkeypatch):
    weeks = pd.to_datetime(["2026-10-02", "2026-10-09"])
    levels = pd.DataFrame({NIFTY200_MOMENTUM30_TRI: [100.0, 101.5]}, index=weeks)
    monkeypatch.setattr(reference_benchmarks, "load_references", lambda *a, **k: levels)
    now = datetime(2026, 10, 9, 19, 30, tzinfo=IST)
    entries, _ = api._journal_entries("final", [], {}, now, pd.Timestamp("2026-10-09"))
    (bench,) = entries
    assert bench.source == "benchmark" and bench.signal["level"] == 101.5
    # At 16:45 the index data still ends last week: no row, just a note.
    stale = levels.iloc[:1]
    monkeypatch.setattr(reference_benchmarks, "load_references", lambda *a, **k: stale)
    entries, notes = api._journal_entries("final", [], {}, now, pd.Timestamp("2026-10-09"))
    assert entries == [] and "no level for this week yet" in notes[0]


def test_a_journal_failure_never_costs_the_signal_and_is_reported(weekly_env, monkeypatch):
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *a, **k: [_outcome("etf-1", "ETF Weekly Core", "etf", True, _signal())],
    )

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(forward_journal, "record", broken)
    result = api._execute_weekly_run(api.WeeklyRunBody(run="final", send=True))
    assert result["journal"]["error"] == "RuntimeError: disk full"
    assert len(weekly_env) == 1 and weekly_env[0].title == "ETF Weekly Core"
    assert "Forward journal FAILED: RuntimeError: disk full" in weekly_env[0].body


def test_the_stock_ingest_rerun_witnesses_new_broad_entries_without_resending_the_etf_signal(
    weekly_env, monkeypatch
):
    class Stock:
        prices = pd.DataFrame({"A": [1.0, 2.0]})

    monkeypatch.setattr(api.DATA, "get_stock", lambda: Stock())
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *a, **k: [
            _outcome("etf-1", "ETF Weekly Core", "etf", True, _signal()),
            _outcome("broad-1", "Candidate", "broad", False, _signal(weights={"INFY": 1.0})),
        ],
    )
    body = api.WeeklyRunBody(run="final", send=True, only_if_active_dataset=["stock", "broad"])
    result = api._execute_weekly_run(body)

    assert result["sent_to_telegram"] is False
    assert [n.title for n in weekly_env] == ["Momentum final: forward journal"]
    assert "2 new entries" in weekly_env[0].body
    with connect() as con:
        broad = [r for r in forward_journal.entries(con) if r["config_id"] == "broad-1"]
    fingerprint = broad[0]["data_fingerprint"]
    assert fingerprint.startswith("weekly_closes:") and ";stock_prices:sha256:" in fingerprint
