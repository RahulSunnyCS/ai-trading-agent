"""Since your start: a followed favourite's return and worst fall, lots put in as yours were."""

from __future__ import annotations

import pandas as pd
import pytest

from momentum_backtesting import since_start

WEEKS = pd.date_range("2026-10-23", "2026-11-20", freq="W-FRI")


def _summary(start: str, step: float = 0.01) -> dict:
    index = [d for d in WEEKS if d >= pd.Timestamp(start)]
    return {
        "dates": [d.date().isoformat() for d in index],
        "strategy": [1.0 + step * i for i in range(len(index))],
    }


def _member(every: int, offset: int, mid: str) -> dict:
    return {
        "id": mid,
        "config": {"dataset": "broad", "rebalance_every": every, "rebalance_offset": offset},
    }


def test_stats_are_the_return_and_the_worst_fall_from_a_running_peak():
    curve = pd.Series([1.0, 1.2, 0.9, 1.1], index=WEEKS[:4])
    out = since_start.stats(curve)
    assert out["return"] == pytest.approx(0.1)
    assert out["max_drawdown"] == pytest.approx(0.9 / 1.2 - 1)
    assert out["weeks"] == 3 and out["as_of"] == "2026-11-13"


def test_each_lot_runs_from_its_own_friday_on_the_sleeve_that_trades_it():
    ran = []

    def run(dataset, config):
        ran.append((dataset, config["rebalance_offset"], config["start"]))
        return _summary(config["start"])

    members = [_member(4, 0, "a"), _member(4, 1, "b"), _member(4, 2, "c"), _member(2, 1, "d")]
    record = {"id": "g", "name": "G", "config": {}}
    out = since_start.favourite_stats(record, members, "2026-10-23", run)
    assert ran == [
        ("broad", 0, "2026-10-23"),
        ("broad", 1, "2026-10-30"),
        ("broad", 2, "2026-11-06"),
        ("broad", 1, "2026-11-13"),
    ]
    assert out["start"] == "2026-10-23" and out["return"] > 0 and out["weeks"] == 4
    assert out["max_drawdown"] == 0.0  # every lot only rose


def test_a_new_lot_adds_money_not_return():
    def run(_dataset, config):
        # lot 1 doubles then falls back; lot 2 (put in a week later) is flat
        if config["start"] == "2026-10-23":
            return {
                "dates": [d.date().isoformat() for d in WEEKS],
                "strategy": [1.0, 2.0, 2.0, 2.0, 2.0],
            }
        return _summary(config["start"], step=0.0)

    members = [_member(4, 0, "a"), _member(4, 1, "b")]
    out = since_start.favourite_stats(
        {"id": "g", "name": "G", "config": {}}, members, "2026-10-23", run
    )
    assert out["max_drawdown"] > -0.5  # the flat lot's deposit is not a fall from the peak
    assert out["return"] > 0


def test_a_lot_the_engine_cannot_show_yet_is_cash_not_an_error():
    def run(_dataset, config):
        if config["start"] >= "2026-11-13":
            raise ValueError("not enough history to run from the chosen start date")
        return _summary(config["start"])

    members = [_member(4, 0, "a"), _member(4, 1, "b"), _member(4, 2, "c"), _member(2, 1, "d")]
    out = since_start.favourite_stats(
        {"id": "g", "name": "G", "config": {}}, members, "2026-10-23", run
    )
    assert "error" not in out and out["weeks"] == 4


def test_a_failure_is_reported_never_turned_into_a_figure():
    def run(_dataset, _config):
        raise RuntimeError("boom")

    out = since_start.favourite_stats(
        {"id": "g", "name": "G", "config": {}}, [_member(4, 0, "a")], "2026-10-23", run
    )
    assert "error" in out and "boom" in out["error"] and "return" not in out


def test_a_friday_no_sleeve_trades_on_is_an_error_not_a_guess():
    members = [_member(4, 1, "a")]  # nothing trades on 2026-10-23 (offset 0)
    out = since_start.favourite_stats(
        {"id": "g", "name": "G", "config": {}},
        members,
        "2026-10-23",
        lambda *_: _summary("2026-10-23"),
    )
    assert "no sleeve" in out["error"]


def test_only_paper_and_invested_favourites_are_measured_and_keyed_by_id():
    favourites = [
        {"id": "g1", "name": "One", "status": "invested", "config": {}},
        {"id": "g2", "name": "Two", "status": "watching", "config": {}},
        {"id": "m1", "name": "member", "status": "paper", "member_of": "g1", "config": {}},
    ]
    groups = [{"id": "g1", "members": [_member(4, 0, "a")]}]
    out = since_start.compute(
        favourites, groups, "2026-10-23", lambda _d, c: _summary(c["start"], 0.02)
    )
    assert list(out["items"]) == ["g1"] and out["items"]["g1"]["return"] > 0


def test_the_stored_file_round_trips_and_a_missing_one_is_none(tmp_path):
    assert since_start.load(tmp_path) is None
    since_start.save({"paper_start": "2026-10-23", "items": {}}, tmp_path)
    assert since_start.load(tmp_path)["paper_start"] == "2026-10-23"
