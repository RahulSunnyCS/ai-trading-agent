"""Rotation lists as correlation series (`list:A` ... `list:REF`, BL-102 Phase 1b).

The daily log is replaced by hand-made rows so the tests check what the series layer does with
it: which days count, which are labelled reconstructed, what `all` leaves out, and the route's
contract (selectors, labels, journal errors)."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import correlation_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import daylog, journal, store
from option_backtesting.rotation import series as rseries


def _weekdays(n: int) -> list[date]:
    out, d = [], date(2025, 1, 6)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _row(day: date, source: str, per_lot: dict[str, float | None], on_time: bool = True) -> dict:
    return {
        "day": day.isoformat(),
        "source": source,
        "recorded": {"on_time": on_time} if source == "recorded" else None,
        "lists": {k: {"per_lot_day": v} for k, v in per_lot.items()},
    }


def _log(rows: list[dict]) -> dict:
    return {"rows": rows}


def test_selector_parsing():
    assert rseries.is_list_selector("list:A")
    assert rseries.is_list_selector("kind:list")
    assert rseries.is_list_selector("slot:0917+list:B")
    assert not rseries.is_list_selector("slot:0917")
    assert not rseries.is_list_selector("N_wide_0917")


def test_series_use_scored_days_and_label_the_reconstructed_ones(monkeypatch, tmp_path):
    days = _weekdays(5)
    rows = [
        _row(days[0], "reconstructed", {"A": 10.0, "B": 1.0, "C": 2.0, "REF": 3.0}),
        _row(days[1], "reconstructed", {"A": -5.0, "B": None, "C": 2.0, "REF": 3.0}),
        _row(days[2], "recorded", {"A": 7.5, "B": 1.0, "C": 2.0, "REF": 3.0}),
        _row(days[3], "recorded", {"A": 99.0, "B": 1.0, "C": 2.0, "REF": 3.0}, on_time=False),
        _row(days[4], "missing", {"A": 42.0}),
    ]
    monkeypatch.setattr(daylog, "build_log", lambda *a, **k: _log(rows))
    got = {a.name: a for a in rseries.lists_available(tmp_path)}

    a = got["list:A"]
    assert a.kind == "list"
    assert a.values == {days[0]: 10.0, days[1]: -5.0, days[2]: 7.5}  # late and missing left out
    assert a.reconstructed == frozenset({days[0], days[1]})
    assert (a.first, a.last, a.n_days) == (days[0], days[2], 3)
    # An unscored day (None) is not a zero: list B has no value for days[1].
    assert days[1] not in got["list:B"].values
    assert set(got) == {"list:A", "list:B", "list:C", "list:REF"}


def test_a_list_with_no_scored_day_is_absent(monkeypatch, tmp_path):
    rows = [_row(_weekdays(1)[0], "recorded", {"A": 1.0, "B": None})]
    monkeypatch.setattr(daylog, "build_log", lambda *a, **k: _log(rows))
    assert [a.name for a in rseries.lists_available(tmp_path)] == ["list:A"]


def test_all_leaves_the_lists_out_but_kind_list_finds_them():
    days = _weekdays(3)
    strat = rseries.Available(
        "N_wide_0917", "variant", days[0], days[-1], 3, values={d: 1.0 for d in days}
    )
    lst = rseries.Available("list:A", "list", days[0], days[-1], 3, values={d: 1.0 for d in days})
    pool = [strat, lst]
    assert [a.name for a in rseries.resolve(["all"], pool)] == ["N_wide_0917"]
    assert [a.name for a in rseries.resolve(["kind:list"], pool)] == ["list:A"]
    assert [a.name for a in rseries.resolve(["list:A", "N_wide_0917"], pool)] == [
        "list:A",
        "N_wide_0917",
    ]
    with pytest.raises(rseries.SelectorError):
        rseries.resolve(["list:Z"], pool)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(correlation_routes, "CACHE_SECONDS", 0.0)
    monkeypatch.setattr(correlation_routes, "LIST_CACHE_SECONDS", 0.0)
    rng = np.random.default_rng(11)
    wide = rng.normal(0, 1000, 80)
    for d, v in zip(_weekdays(80), wide, strict=True):
        store.append_result("N_wide_0917", {"day": d.isoformat(), "net": float(v)}, tmp_path)
        store.append_result("N_p80_0917", {"day": d.isoformat(), "net": float(-v)}, tmp_path)
    rows = []
    for i, (d, v) in enumerate(zip(_weekdays(80), wide, strict=True)):
        a = float(v * 0.9 + rng.normal(0, 100))
        rows.append(_row(d, "reconstructed" if i < 30 else "recorded", {"A": a, "REF": -a}))
    monkeypatch.setattr(daylog, "build_log", lambda *a, **k: _log(rows))
    return TestClient(create_app(tmp_path / "cache"))


def test_available_offers_the_lists_without_reading_history(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("the picker must not build the list series")

    monkeypatch.setattr(daylog, "build_log", boom)
    body = client.get("/legwise/correlation/available").json()
    assert [(x["key"], x["selector"]) for x in body["lists"]] == [
        ("A", "list:A"),
        ("B", "list:B"),
        ("C", "list:C"),
        ("REF", "list:REF"),
    ]
    assert body["lists"][0]["name"] == "Steady"
    assert "list:A" not in [s["name"] for s in body["strategies"]]  # not mixed into strategies


def test_a_list_correlates_with_a_strategy_and_reports_reconstructed_days(client):
    res = client.get("/legwise/correlation", params={"selectors": "list:A,N_wide_0917"})
    assert res.status_code == 200
    body = res.json()
    assert body["names"] == ["list:A", "N_wide_0917"]
    assert body["reconstructed"] == {"list:A": 30}
    i = body["names"].index("N_wide_0917")
    assert body["pearson"][0][i] > 0.9  # list A was built from the strategy

    inverse = client.get("/legwise/correlation", params={"selectors": "list:A,list:REF"}).json()
    assert inverse["pearson"][0][1] < -0.99


def test_a_strategy_only_comparison_has_no_reconstructed_entries(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no list was asked for, so no list series should be built")

    monkeypatch.setattr(daylog, "build_log", boom)
    res = client.get("/legwise/correlation", params={"selectors": "N_wide_0917,N_p80_0917"})
    assert res.status_code == 200
    assert res.json()["reconstructed"] == {}


def test_an_unknown_list_is_a_404_in_the_error_shape(client):
    res = client.get("/legwise/correlation", params={"selectors": "list:Z,N_wide_0917"})
    assert res.status_code == 404
    assert "matches nothing" in res.json()["error"]


def test_a_corrupt_journal_is_a_503_not_a_partial_history(client, monkeypatch):
    def corrupt(*a, **k):
        raise journal.JournalCorrupt("line 3 is not valid JSON")

    monkeypatch.setattr(daylog, "build_log", corrupt)
    res = client.get("/legwise/correlation", params={"selectors": "list:A,N_wide_0917"})
    assert res.status_code == 503
    assert "journal cannot be read" in res.json()["error"]


def test_load_brings_in_the_lists_only_when_asked(monkeypatch, tmp_path):
    days = _weekdays(4)
    for d in days:
        store.append_result("N_wide_0917", {"day": d.isoformat(), "net": 5.0}, tmp_path)
    rows = [_row(d, "recorded", {"A": float(i)}) for i, d in enumerate(days)]
    calls = []

    def fake(*a, **k):
        calls.append(1)
        return _log(rows)

    monkeypatch.setattr(daylog, "build_log", fake)
    assert [s.name for s in rseries.load(["N_wide_0917"], tmp_path)] == ["N_wide_0917"]
    assert calls == []
    got = rseries.load(["list:A", "N_wide_0917"], tmp_path)
    assert [s.name for s in got] == ["list:A", "N_wide_0917"]
    assert calls == [1]


def test_a_basket_can_be_required_to_include_a_list(client):
    res = client.get(
        "/legwise/correlation/pick",
        params={"selectors": "list:A,N_wide_0917,N_p80_0917", "k": 2, "require": "list:A"},
    )
    assert res.status_code == 200, res.text
    assert "list:A" in res.json()["names"]
