"""Selection drift (`rotation/drift.py`, `api/rotation_drift_routes.py`).

Two kinds of test: the real daily log over a synthetic store built through `pick.record` (the
shape and the windows), and crafted log rows (the flag logic, which needs picks we choose). The
module only reads: every file is hashed before and after.
"""

from __future__ import annotations

import hashlib
import shutil
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_drift_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import daylog, drift, history

from . import rotation_synth as syn


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_drift")
    return root, syn.forward_scenario(root, history=140)


@pytest.fixture
def world(built, tmp_path, monkeypatch):
    src, sc = built
    root = tmp_path / "TradingData"
    shutil.copytree(src, root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(daylog, "now_ist", lambda: syn.NOW)
    daylog._recon_cache.clear()
    history.clear()
    rotation_drift_routes._cache.clear()
    return root, sc


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted((root / "rotation").rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


def _dim(out: dict, key: str) -> dict:
    return next(d for d in out["dimensions"] if d["key"] == key)


# --- the real log -----------------------------------------------------------------------------


def test_every_window_counts_three_core_picks_a_day_and_shares_sum_to_one(world):
    root, _ = world
    out = drift.build("A", root)
    for win in ("history", "last63", "last21"):
        n = out["windows"][win]["n_days"]
        assert n > 0
        for d in out["dimensions"]:
            assert sum(d["counts"][win]) == 3 * n, (win, d["key"])
            assert sum(d["shares"][win]) == pytest.approx(1.0, abs=0.01)


def test_the_short_and_long_windows_are_the_latest_sessions(world):
    root, sc = world
    out = drift.build("A", root)
    assert out["windows"]["last21"]["n_days"] == 21 and out["windows"]["last63"]["n_days"] == 63
    assert out["windows"]["last21"]["to"] == out["windows"]["last63"]["to"]
    # the forward days are recorded entries; the late (14 Oct) and missing (15 Oct) are not there
    assert out["windows"]["last21"]["recorded"] >= 3
    assert out["windows"]["last21"]["to"] >= "2026-10-12"
    assert out["rolling_windows"] == out["windows"]["history"]["n_days"] - drift.SHORT + 1


def test_a_band_is_a_pair_of_shares_with_p10_below_p90(world):
    root, _ = world
    out = drift.build("B", root)
    for d in out["dimensions"]:
        for b in d["band"]:
            assert b is not None and 0 <= b["p10"] <= b["p90"] <= 1


def test_a_missing_or_late_day_is_not_a_session(world):
    root, sc = world
    out = drift.build("A", root)
    log = history.daily_log(root, "recent")
    days = {r["day"] for r in log["rows"]}
    assert "2026-10-15" in days  # the missing row is in the log ...
    got = drift._days(log["rows"], "A")
    assert date(2026, 10, 15) not in {d.day for d in got}  # ... and not in the picks
    assert date(2026, 10, 14) not in {d.day for d in got}  # the late entry
    assert out["windows"]["last21"]["n_days"] == 21


def test_an_empty_store_says_there_is_not_enough_to_read(tmp_path, monkeypatch):
    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    daylog._recon_cache.clear()
    history.clear()
    out = drift.build("A", tmp_path)
    assert out["enough"] is False and out["flags"] == 0
    assert out["windows"]["last21"]["n_days"] == 0


# --- the flag logic, on picks we choose -------------------------------------------------------


def _row(day: date, names: list[tuple[str, str, str, str, str]], **block) -> dict:
    """names: (variant, kind, index, family, band)."""
    return {
        "day": day.isoformat(),
        "source": "reconstructed",
        "status": "scored",
        "lists": {
            "A": {
                "overridden": False,
                "buy_qualified": False,
                "shared_start_band": False,
                **block,
                "picks": [
                    {"name": n, "kind": k, "index": i, "family": f, "band": b, "role": "core"}
                    for n, k, i, f, b in names
                ],
            }
        },
    }


NIFTY_WIDE = ("N_wide_0932", "wide", "NIFTY", "wide", "A")
NIFTY_DIR = ("N_dir_1202", "dir", "NIFTY", "dir", "B")
SENSEX_WIDE = ("S_wide_1347", "wide", "SENSEX", "wide", "C")
SENSEX_DIR = ("S_dir_1032", "dir", "SENSEX", "dir", "B")


@pytest.fixture
def crafted(monkeypatch, tmp_path):
    """60 history days of 2 Widesl + 1 Dir that alternate between 2 NIFTY + 1 SENSEX and 1 NIFTY +
    2 SENSEX, then 21 days that are all SENSEX with the same 2 + 1 family mix: the index shares
    must flag, the family shares must not."""
    days = []
    d = date(2026, 1, 5)
    while len(days) < 81:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    rows = []
    for i, day in enumerate(days[:60]):
        dir_pick = NIFTY_DIR if i % 2 else SENSEX_DIR
        rows.append(_row(day, [NIFTY_WIDE, SENSEX_WIDE, dir_pick]))
    for day in days[60:]:
        rows.append(_row(day, [SENSEX_WIDE, SENSEX_WIDE, SENSEX_DIR]))
    history.clear()
    monkeypatch.setattr(history, "daily_log", lambda root, span: {"rows": rows})
    return tmp_path, days


def test_a_share_outside_the_lists_own_band_is_flagged_with_its_direction(crafted):
    root, _ = crafted
    out = drift.build("A", root)
    idx = _dim(out, "index")
    flags = {f["category"]: f for f in idx["flags"]}
    assert flags["SENSEX"]["direction"] == "above" and flags["SENSEX"]["share"] == 1.0
    assert flags["NIFTY"]["direction"] == "below" and flags["NIFTY"]["share"] == 0.0
    assert out["flags"] >= 2


def test_a_share_that_has_always_been_there_is_not_flagged(crafted):
    root, _ = crafted
    out = drift.build("A", root)
    # two Widesl and one Dir every day, in history and in the last 21: nothing to say
    assert _dim(out, "kind")["flags"] == []


def test_the_concentration_rows_are_counted_over_the_last_21(crafted):
    root, _ = crafted
    out = drift.build("A", root)
    c = {r["key"]: r for r in out["concentration"]}
    assert c["distinct"]["last21"] == 2  # S_wide_1347 and S_dir_1032
    assert c["most_picked"]["last21"] == 42 and c["most_picked"]["name"] == "S_wide_1347"
    assert c["distinct"]["flag"] in (None, "below", "above")
    assert c["most_picked"]["flag"] == "above"  # 42 against a history of at most 21


def test_a_list_that_is_too_young_is_not_flagged(monkeypatch, tmp_path):
    history.clear()
    rows = [
        _row(date(2026, 3, 2) + timedelta(days=i), [NIFTY_WIDE, NIFTY_WIDE, NIFTY_DIR])
        for i in range(10)
    ]
    monkeypatch.setattr(history, "daily_log", lambda root, span: {"rows": rows})
    out = drift.build("A", tmp_path)
    assert out["enough"] is False and out["flags"] == 0
    assert all(b is None for d in out["dimensions"] for b in d["band"])


# --- arguments and the route ------------------------------------------------------------------


def test_an_unknown_list_is_refused(world):
    root, _ = world
    with pytest.raises(drift.DriftError) as e:
        drift.build("Z", root)
    assert e.value.status == 422


def test_the_route_answers_validates_and_writes_nothing(world):
    root, _ = world
    before = _fingerprint(root)
    c = TestClient(create_app())
    ok = c.get("/legwise/rotation/drift?list=REF")
    assert ok.status_code == 200 and ok.json()["list"] == "REF"
    bad = c.get("/legwise/rotation/drift?list=Z")
    assert bad.status_code == 422 and "error" in bad.json()
    assert _fingerprint(root) == before


def test_the_buy_add_on_is_not_a_core_pick_and_a_closest_premium_pick_is_premium():
    row = _row(
        date(2026, 3, 2),
        [NIFTY_WIDE, ("N_p80_0932", "wide", "NIFTY", "p80", "A"), NIFTY_DIR],
        buy_qualified=True,
    )
    row["lists"]["A"]["picks"].append(
        {
            "name": "N_buy_1017",
            "kind": "buy",
            "index": "NIFTY",
            "family": "buy",
            "band": "B",
            "role": "buy",
        }
    )
    (day,) = drift._days([row], "A")
    assert len(day.names) == 3 and "N_buy_1017" not in day.names
    assert day.cats["strike"] == ["wide", "premium", "dir"]
    assert day.cats["kind"] == ["wide", "wide", "dir"]
    assert day.buy_qualified is True
    # ditm1 is its own strike method, and a Buy-family name never becomes one
    assert drift._strike({"family": "ditm1"}) == "ditm1"
    assert drift._strike({"family": "buy"}) is None


def test_one_session_predicate_serves_every_card():
    assert history.is_session({"source": "recorded", "status": "scored"})
    assert history.is_session({"source": "reconstructed"})
    assert not history.is_session({"source": "recorded", "status": "late"})
    assert not history.is_session({"source": "missing"})


def test_a_corrupt_journal_is_named_as_the_journal(world):
    root, _ = world
    (root / "rotation" / "journal.jsonl").write_text("{not json\n")
    history.clear()
    rotation_drift_routes._cache.clear()
    r = TestClient(create_app(), raise_server_exceptions=False).get("/legwise/rotation/drift")
    assert r.status_code == 500 and "journal cannot be read" in r.json()["error"]
