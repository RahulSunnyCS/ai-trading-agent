"""The Options Lab favourites store and its `/legwise/favourites` route (BL-102 Phase 1b)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from option_backtesting import favourites
from option_backtesting.api.app import create_app


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def client(root):
    return TestClient(create_app())


def test_missing_file_reads_as_the_default(root):
    got = favourites.read(root)
    assert got.lists == ("A", "B", "C")
    assert got.strategies == ()
    assert got.updated_at is None and got.warning is None
    assert got.as_dict()["is_default"] is True


def test_write_then_read_round_trips_and_stamps_the_time(root):
    saved = favourites.write(["C", "A"], ["nifty_buy_range_breakout", "N_wide_0917"], root)
    assert saved.lists == ("A", "C")  # canonical order, not the order sent
    assert saved.updated_at is not None
    again = favourites.read(root)
    assert again.lists == ("A", "C")
    assert again.strategies == ("nifty_buy_range_breakout", "N_wide_0917")
    assert again.as_dict()["is_default"] is False


def test_duplicates_collapse_keeping_the_first(root):
    saved = favourites.write(["A", "A"], ["x", "y", "x"], root)
    assert saved.lists == ("A",)
    assert saved.strategies == ("x", "y")


def test_an_empty_choice_is_allowed(root):
    saved = favourites.write([], [], root)
    assert saved.lists == () and saved.strategies == ()
    assert favourites.read(root).lists == ()  # saved empty is not the default


@pytest.mark.parametrize(
    ("lists", "strategies"),
    [
        (["Z"], []),
        (["A"], ["has space"]),
        (["A"], ["../escape"]),
        (["A"], [""]),
        (["A"], [3]),
        ("A", []),
        (["A"], "x"),
        (["A"], [f"s{i}" for i in range(101)]),
    ],
)
def test_bad_input_is_refused_and_writes_nothing(root, lists, strategies):
    with pytest.raises(favourites.FavouritesError):
        favourites.write(lists, strategies, root)
    assert not favourites.favourites_path(root).exists()


def test_a_bad_file_reads_as_the_default_with_a_reason(root):
    path = favourites.favourites_path(root)
    path.parent.mkdir(parents=True)
    path.write_text("{not json")
    got = favourites.read(root)
    assert got.lists == ("A", "B", "C") and got.warning is not None
    # A write replaces the bad file.
    favourites.write(["B"], [], root)
    assert favourites.read(root).warning is None


def test_a_file_with_an_unknown_list_is_not_used(root):
    path = favourites.favourites_path(root)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"lists": ["Q"], "strategies": []}))
    assert favourites.read(root).warning is not None


def test_no_temp_files_are_left_behind(root):
    favourites.write(["A"], [], root)
    names = sorted(p.name for p in favourites.favourites_path(root).parent.iterdir())
    assert names == [".favourites.lock", "favourites.json"]


def test_route_get_default_then_put_then_get(client):
    first = client.get("/legwise/favourites").json()
    assert first["lists"] == ["A", "B", "C"] and first["is_default"] is True

    put = client.put(
        "/legwise/favourites", json={"lists": ["A", "REF"], "strategies": ["nifty_widesl_917_otm1"]}
    )
    assert put.status_code == 200
    assert put.json()["lists"] == ["A", "REF"]

    second = client.get("/legwise/favourites").json()
    assert second["strategies"] == ["nifty_widesl_917_otm1"]
    assert second["is_default"] is False


def test_route_refuses_bad_input_in_the_error_shape(client):
    res = client.put("/legwise/favourites", json={"lists": ["Q"], "strategies": []})
    assert res.status_code == 422
    assert "unknown list" in res.json()["error"]
    # Extra keys are rejected by the model (FastAPI's own 422 shape).
    assert (
        client.put(
            "/legwise/favourites", json={"lists": [], "strategies": [], "extra": 1}
        ).status_code
        == 422
    )
    assert client.get("/legwise/favourites").json()["is_default"] is True
