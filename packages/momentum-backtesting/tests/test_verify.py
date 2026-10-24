"""`mbt verify history` (BL-001 Phase 4, re-scoped): old history that changes is named."""

from __future__ import annotations

import json
from datetime import date

import pyarrow as pa
import pytest
from trading_data import lake
from trading_data.db import connect

from momentum_backtesting import db_migrate, verify
from momentum_backtesting.stocks import fyers_topup

TODAY = date(2026, 10, 24)  # a Saturday: the default anchor is Friday 2026-10-09


def _prices(root, rows):
    with connect(root) as con:
        con.executemany(
            "INSERT INTO momentum_prices (instrument, kind, date, open, close) VALUES (?,?,?,?,?)",
            rows,
        )


def _row(instrument, day, close, kind="weekly"):
    return (instrument, kind, day, close, close)


@pytest.fixture
def root(tmp_path):
    _prices(
        tmp_path,
        [
            _row("NIFTY", date(2025, 1, 3), 100.0),
            _row("NIFTY", date(2026, 10, 9), 110.0),
            _row("GOLD", date(2025, 1, 3), 50.0),
        ],
    )
    return tmp_path


def _state(tmp_path):
    return tmp_path / "state"


def test_the_default_anchor_is_the_friday_two_weeks_back():
    assert verify.default_anchor(TODAY) == date(2026, 10, 9)
    assert verify.default_anchor(date(2026, 10, 23)) == date(2026, 10, 9)  # a Friday
    assert verify.default_anchor(date(2026, 10, 26)) == date(2026, 10, 9)  # the Monday after


def test_first_run_records_a_baseline_and_a_second_run_is_clean(root, tmp_path):
    first = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    assert first.status == "new_baseline"
    second = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    assert second.status == "ok" and second.diff.clean


def test_a_new_week_after_the_anchor_does_not_trip_it(root, tmp_path):
    verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    _prices(
        root, [_row("NIFTY", date(2026, 10, 16), 120.0), _row("NIFTY", date(2026, 10, 23), 1.0)]
    )
    assert verify.run(_state(tmp_path), TODAY, root=root, bars=False).status == "ok"


def test_a_restated_old_close_is_named_with_its_year(root, tmp_path):
    verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    with connect(root) as con:
        con.execute(
            "UPDATE momentum_prices SET close = 101.0 WHERE instrument = 'NIFTY' AND date = ?",
            [date(2025, 1, 3)],
        )
    outcome = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    assert outcome.status == "changed"
    assert [(c.label, c.first_year) for c in outcome.diff.changed] == [("price:NIFTY|weekly", 2025)]
    title, body = verify.summary(outcome)
    assert "price:NIFTY|weekly" in body and "from 2025" in body


def test_an_edit_that_keeps_the_row_count_still_shows(root, tmp_path):
    verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    with connect(root) as con:
        con.execute("UPDATE momentum_prices SET open = 1.0 WHERE instrument = 'GOLD'")
    out = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    change = out.diff.changed[0]
    assert change.rows_before == change.rows_after == 1


def test_lost_history_is_reported_as_removed(root, tmp_path):
    verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    with connect(root) as con:
        con.execute("DELETE FROM momentum_prices WHERE instrument = 'GOLD'")
    out = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    assert out.status == "changed" and out.diff.removed == ["price:GOLD|weekly"]


def test_new_history_alone_is_information_not_a_change(root, tmp_path):
    verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    _prices(root, [_row("SILVER", date(2025, 1, 3), 7.0)])
    out = verify.run(_state(tmp_path), TODAY, root=root, bars=False)
    assert out.status == "ok" and out.diff.added == ["price:SILVER|weekly"]


def test_a_change_stays_until_accepted_with_a_reason(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, TODAY, root=root, bars=False)
    with connect(root) as con:
        con.execute("UPDATE momentum_prices SET close = 1.0 WHERE instrument = 'GOLD'")
    assert verify.run(state, TODAY, root=root, bars=False).status == "changed"
    assert verify.run(state, TODAY, root=root, bars=False).status == "changed"  # not auto-accepted
    with pytest.raises(ValueError, match="--reason"):
        verify.run(state, TODAY, root=root, accept=True, bars=False)
    assert verify.run(state, TODAY, root=root, accept=True, reason="vendor fix", bars=False)
    assert verify.run(state, TODAY, root=root, bars=False).status == "ok"
    log = [json.loads(x) for x in (state / verify.LOG_FILE).read_text().splitlines()]
    assert [e["event"] for e in log] == ["new_baseline", "accepted"]
    assert log[1]["reason"] == "vendor fix"


def test_a_clean_check_far_behind_moves_the_anchor_forward(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, date(2026, 8, 1), root=root, bars=False)  # anchor 2026-07-17
    assert verify.load_baseline(state)["anchor"] == "2026-07-17"
    out = verify.run(state, TODAY, root=root, bars=False)
    assert out.status == "ok" and out.advanced_to == date(2026, 10, 9)
    assert verify.load_baseline(state)["anchor"] == "2026-10-09"
    assert [json.loads(x)["event"] for x in (state / verify.LOG_FILE).read_text().splitlines()] == [
        "new_baseline",
        "advanced",
    ]


def test_a_changed_check_never_advances_the_anchor(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, date(2026, 8, 1), root=root, bars=False)
    with connect(root) as con:
        con.execute("UPDATE momentum_prices SET close = 9.0 WHERE instrument = 'GOLD'")
    assert verify.run(state, TODAY, root=root, bars=False).status == "changed"
    assert verify.load_baseline(state)["anchor"] == "2026-07-17"


def test_a_late_corporate_action_with_an_old_ex_date_is_named(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, TODAY, root=root, bars=False)
    with connect(root) as con:
        con.execute("INSERT INTO companies VALUES ('C1', 'Company one')")
        con.execute(
            "INSERT INTO corporate_actions (company_id, symbol_at_ex, ex_date, kind, factor) "
            "VALUES ('C1', 'AAA', ?, 'split', 2.0)",
            [date(2025, 3, 3)],
        )
    out = verify.run(state, TODAY, root=root, bars=False)
    assert out.status == "ok" and "action:AAA" in out.diff.added  # new label: information
    verify.run(state, TODAY, root=root, accept=True, reason="baseline with the action", bars=False)
    with connect(root) as con:
        con.execute("UPDATE corporate_actions SET factor = 4.0 WHERE symbol_at_ex = 'AAA'")
    out = verify.run(state, TODAY, root=root, bars=False)
    assert [c.label for c in out.diff.changed] == ["action:AAA"]


def _bars(root, day, close, volume=100):
    with connect(root) as con:
        ids = db_migrate.register_stock_instruments(con, ["AAA"])
    row = {
        "instrument_id": ids["AAA"],
        "date": day,
        "series": "EQ",
        "isin": None,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "prevclose": close,
        "volume": volume,
        "turnover": close * volume,
        "synthetic_close": False,
    }
    path = lake.bars_1d_stock_path(root, day.year)
    existing = []
    if path.exists():
        import pyarrow.parquet as pq

        existing = pq.read_table(path).to_pylist()
    rows = [r for r in existing if r["date"] != day] + [row]
    table = pa.Table.from_pylist(rows, schema=fyers_topup._BARS_1D_STOCK_SCHEMA)
    lake.write_parquet(table, path)


def test_a_restated_stock_bar_is_named_by_symbol_and_year(root, tmp_path):
    state = _state(tmp_path)
    _bars(root, date(2025, 6, 2), 10.0)
    _bars(root, date(2026, 10, 9), 12.0)
    verify.run(state, TODAY, root=root)
    assert verify.run(state, TODAY, root=root).status == "ok"
    _bars(root, date(2026, 10, 16), 99.0)  # after the anchor: new week, fine
    assert verify.run(state, TODAY, root=root).status == "ok"
    _bars(root, date(2025, 6, 2), 10.5)  # a past close restated
    out = verify.run(state, TODAY, root=root)
    assert [(c.label, c.first_year) for c in out.diff.changed] == [("bars:AAA", 2025)]


def test_a_baseline_with_another_schema_is_refused_not_replaced(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, TODAY, root=root, bars=False)
    path = verify.baseline_path(state)
    data = json.loads(path.read_text())
    data["schema"] = 99
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="schema"):
        verify.run(state, TODAY, root=root, bars=False)
    assert json.loads(path.read_text())["schema"] == 99  # untouched


def test_a_different_duckdb_version_asks_for_a_rebaseline_instead_of_alarming(root, tmp_path):
    state = _state(tmp_path)
    verify.run(state, TODAY, root=root, bars=False)
    path = verify.baseline_path(state)
    data = json.loads(path.read_text())
    data["duckdb"] = "0.0.1"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="re-baseline"):
        verify.run(state, TODAY, root=root, bars=False)
    assert verify.run(state, TODAY, root=root, accept=True, reason="duckdb upgrade", bars=False)
    assert verify.run(state, TODAY, root=root, bars=False).status == "ok"


def test_the_log_line_is_written_before_the_baseline_moves(root, tmp_path, monkeypatch):
    state = _state(tmp_path)
    verify.run(state, TODAY, root=root, bars=False)
    before = verify.baseline_path(state).read_text()

    def boom(self, *args, **kwargs):  # the log append fails
        raise OSError("disk full")

    real_open = type(state).open
    monkeypatch.setattr(
        type(state),
        "open",
        lambda self, *a, **k: (
            boom(self) if self.name == verify.LOG_FILE else real_open(self, *a, **k)
        ),
    )
    with connect(root) as con:
        con.execute("UPDATE momentum_prices SET close = 1.0 WHERE instrument = 'GOLD'")
    with pytest.raises(OSError):
        verify.run(state, TODAY, root=root, accept=True, reason="x", bars=False)
    assert verify.baseline_path(state).read_text() == before
