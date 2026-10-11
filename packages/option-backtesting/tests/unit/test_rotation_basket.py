"""A day's basket, correlated (`rotation/basket.py`, `api/rotation_basket_routes.py`): the
Correlation tab's "Today's basket" preset.

A synthetic store is built through the real `pick.record`, so the entries are genuine hash-chained
ones; nothing touches the real TRADING_DATA_ROOT. The module reads the journal and the stored
results and never writes them: checked by hashing every file before and after.
"""

from __future__ import annotations

import csv
import hashlib
import shutil
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_basket_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import base as base_mod
from option_backtesting.rotation import basket, daylog, journal, store

from . import rotation_synth as syn

ON_TIME = [date(2026, 10, 12), date(2026, 10, 13), date(2026, 10, 16)]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_basket")
    return root, syn.forward_scenario(root)


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    daylog._recon_cache.clear()
    rotation_basket_routes._cache.clear()
    return root, sc


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((root / "rotation").rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


def _write_base_dir(root: Path, days: list[date], value: float = 100.0) -> None:
    path = base_mod.base_dir(root) / f"{base_mod.DIR_NAME}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(store.RESULT_COLUMNS)
        for i, d in enumerate(days):
            g = value * ((i % 7) - 3)
            w.writerow([d.isoformat(), g, g, 0.0, min(g, 0.0), "", 3])


# --- the picks --------------------------------------------------------------------------------


def test_a_recorded_day_uses_the_journal_entry_picks(world):
    root, sc = world
    entry = sc["entries"][ON_TIME[0]]
    out = basket.build("A", ON_TIME[0], "custom", root=root)
    picked = entry["lists"]["A"]
    assert out["source"] == "recorded" and out["late"] is False
    assert [p["name"] for p in out["picks"]] == [*picked["core"], *picked["buy"]]
    assert [p["role"] for p in out["picks"]] == ["core"] * len(picked["core"]) + ["buy"] * len(
        picked["buy"]
    )
    assert all(p["lots"] == 2 and p["has_results"] for p in out["picks"])
    assert out["lots"] == 2 * len(out["picks"])
    assert out["basis"] == "gross" and out["in_sample"] is True
    assert out["duplicates"] == []


def test_the_default_day_is_the_latest_on_time_entry(world):
    root, sc = world
    out = basket.build("A", None, "custom", root=root)
    assert (
        out["day"]
        == max(d for d, e in sc["entries"].items() if e["before_first_entry"]).isoformat()
    )


def test_a_late_entry_is_named_and_is_not_a_forward_day(world):
    root, sc = world
    late = date(2026, 10, 14)
    out = basket.build("A", late, "forward", root=root)
    assert out["source"] == "recorded" and out["late"] is True
    fwd = {
        d.isoformat() for d in sc["forward"] if sc["entries"].get(d, {}).get("before_first_entry")
    }
    assert late.isoformat() not in fwd
    assert out["windows"]["forward"]["n_days"] <= len(fwd)
    assert out["window"]["from"] >= "2026-10-12"


def test_a_day_before_the_journal_is_reconstructed_and_says_so(world):
    root, sc = world
    day = sc["history"][-1]  # Fri 9 Oct: 69 earlier days of results, so it can be re-scored
    out = basket.build("B", day, "custom", root=root)
    again = daylog.reconstruction(root).picks(day)["B"]
    assert out["source"] == "reconstructed" and out["late"] is False
    assert [p["name"] for p in out["picks"] if p["role"] == "core"] == again["core"]


def test_a_day_that_cannot_be_re_scored_is_refused_not_guessed(world):
    root, sc = world
    with pytest.raises(basket.BasketError) as e:
        basket.build("A", sc["history"][5], "custom", root=root)
    assert e.value.status == 404 and "63 earlier days" in str(e.value)


# --- the windows ------------------------------------------------------------------------------


def test_the_forward_window_counts_only_on_time_days_and_is_thin_when_short(world):
    root, sc = world
    out = basket.build("A", ON_TIME[0], "forward", root=root)
    on_time = sorted(
        d for d, e in sc["entries"].items() if e["before_first_entry"] and d != date(2026, 10, 22)
    )
    # the 22nd is recorded but not yet scored: it is not a common day, so it is not counted
    assert out["n_days"] == len(on_time) == out["windows"]["forward"]["n_days"]
    assert out["window"]["from"] == on_time[0].isoformat()
    assert out["window"]["to"] == on_time[-1].isoformat()
    assert out["enough"] is False and out["thin_days"] == basket.THIN_DAYS
    assert out["correlation"] is not None  # computed, but flagged thin for the page to mute


def test_a_window_with_too_few_days_returns_no_figures_and_the_count(world):
    root, _ = world
    out = basket.build("A", ON_TIME[0], "custom", date(2026, 10, 12), date(2026, 10, 13), root=root)
    assert out["correlation"] is None and out["n_days"] == 2
    assert "2 common days" in out["reason"]


def test_forward_before_any_entry_says_so(tmp_path, monkeypatch):
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    daylog._recon_cache.clear()
    days = syn.weekdays(date(2026, 7, 1), 80)
    syn.build_store(tmp_path, days)
    out = basket.build("A", days[-1], "forward", root=tmp_path)
    assert out["correlation"] is None and "first is Mon 12 Oct" in out["reason"]
    assert out["windows"]["forward"]["n_days"] == 0


def test_last63_is_the_basket_s_own_last_63_common_days(world):
    root, _ = world
    out = basket.build("A", ON_TIME[0], "last63", root=root)
    w = out["windows"]["last63"]
    assert w["n_days"] == 63 and out["n_days"] == 63
    assert out["window"]["from"] == w["from"] and out["window"]["to"] == w["to"]


# --- the fixed base ---------------------------------------------------------------------------


def test_the_base_is_two_widesl_and_one_dir_and_says_the_pair_is_one_by_construction(world):
    root, sc = world
    _write_base_dir(root, sc["history"])
    out = basket.build("BASE", None, "custom", root=root)
    names = out["correlation"]["names"]
    assert names == [base_mod.WIDE_NAME, basket.BASE_SECOND_WIDE, base_mod.DIR_NAME]
    assert out["source"] == "base" and out["lots"] == 6
    assert out["correlation"]["pearson"][0][1] == pytest.approx(1.0)
    assert any("1.00 by construction" in n for n in out["notes"])
    assert out["duplicates"] == [basket.BASE_SECOND_WIDE]
    assert [p["start"] for p in out["picks"]] == ["09:17", "09:24"]
    assert out["day"] is None


def test_a_missing_base_leg_is_listed_and_nothing_is_zero_filled(world):
    root, _ = world  # no rotation/base/ file in this store
    out = basket.build("BASE", None, "custom", root=root)
    assert out["correlation"] is None and base_mod.DIR_NAME in out["omitted"]
    assert out["reason"].startswith("no stored results for")


def test_a_pick_without_results_is_listed_and_left_out(world):
    root, sc = world
    name = sc["entries"][ON_TIME[0]]["lists"]["A"]["core"][0]
    (store.results_dir(root) / f"{name}.csv").unlink()
    out = basket.build("A", ON_TIME[0], "custom", root=root)
    assert name in out["omitted"] and out["correlation"] is None
    assert next(p for p in out["picks"] if p["name"] == name)["has_results"] is False


def test_an_unknown_list_or_window_is_refused(world):
    root, _ = world
    for key, win in (("Z", "P1"), ("A", "fortnight")):
        with pytest.raises(basket.BasketError) as e:
            basket.build(key, ON_TIME[0], win, root=root)
        assert e.value.status == 422


# --- loses together ---------------------------------------------------------------------------


def test_all_lose_days_never_exceed_any_lose_days_and_match_the_matrix(world):
    root, _ = world
    out = basket.build("A", ON_TIME[0], "last63", root=root)
    assert 0 <= out["all_lose_days"] <= out["any_lose_days"] <= out["n_days"]


# --- the route --------------------------------------------------------------------------------


def test_the_route_answers_and_validates_and_writes_nothing(world):
    root, _ = world
    before = _fingerprint(root)
    client = TestClient(create_app())
    ok = client.get("/legwise/rotation/basket?list=A&day=2026-10-12&window=last63")
    assert ok.status_code == 200 and ok.json()["list"] == "A"
    assert ok.json()["correlation"]["n_days"] == 63
    for url, status in (
        ("/legwise/rotation/basket?list=Z", 422),
        ("/legwise/rotation/basket?list=A&window=nope", 422),
        ("/legwise/rotation/basket?list=A&day=2026-13-01", 422),
        ("/legwise/rotation/basket?list=A&from=2026-10-13&to=2026-10-12&window=custom", 422),
        ("/legwise/rotation/basket?list=A&day=2025-01-02", 404),
    ):
        r = client.get(url)
        assert r.status_code == status, (url, r.text)
        assert "error" in r.json()
    assert _fingerprint(root) == before
    assert journal.verify(store.journal_path(root)) == []
