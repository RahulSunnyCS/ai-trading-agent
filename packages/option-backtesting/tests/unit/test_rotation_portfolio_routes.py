"""BL-095 Phase 2: `/legwise/rotation/portfolio/{day,days}` over a synthetic store.

The log (picks, lots, stored gross) is the real `daylog` over a store built through
`pick.record`; the minute paths are crafted, because the synthetic store has no lake bars to
replay. What is checked: the settings are parsed as typed, the stop is applied to the log's own
baskets, a day that cannot be replayed is a clean error, and nothing is written.
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.legwise.market import N_MINUTES
from option_backtesting.rotation import daylog, history
from option_backtesting.rotation import portfolio as pf

from . import rotation_synth as syn


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    root = tmp_path_factory.mktemp("rot_pf")
    return root, syn.forward_scenario(root, history=100)


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
    pf.clear_cache()
    return root, sc


def crafted_path(gross: float, dive_at: int = 60, dive: float = -4000.0) -> tuple[float, ...]:
    """One lot: dives to `dive` by `dive_at`, then recovers linearly to `gross` by the close."""
    out = [0.0] * N_MINUTES
    for m in range(N_MINUTES):
        if m <= dive_at:
            out[m] = dive * m / dive_at
        else:
            out[m] = dive + (gross - dive) * (m - dive_at) / (N_MINUTES - 1 - dive_at)
    return tuple(out)


@pytest.fixture
def paths(monkeypatch):
    """Every pick replays to the same crafted path: -4,000 an hour in, back to its stored gross."""
    calls: list[tuple] = []

    def fake(root, day, name, loaded=None):
        calls.append((day, name))
        row = daylog._Results(root).row(name, day)
        gross = 0.0 if row is None else float(row["gross"])
        return crafted_path(gross)

    monkeypatch.setattr(pf, "one_lot_path", fake)
    return calls


def _fingerprint(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.name.startswith(".")
    }


def _a_scored_day(world) -> str:
    _, sc = world
    return next(d.isoformat() for d in sc["forward"] if sc["events"][d] == "on_time")


def test_day_with_no_stop_matches_the_logs_own_gross(world, paths):
    day = _a_scored_day(world)
    r = TestClient(create_app()).get(f"/legwise/rotation/portfolio/day?day={day}&list=A")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["setting"] == {"amount": None, "trail": None}
    assert body["book"]["stop_minute"] is None
    assert body["book"]["gross_with"] == body["book"]["gross_without"]
    assert body["book"]["matches_log"] is True
    assert len(body["combined"]) == N_MINUTES == len(body["stopped"]) == len(body["level"])
    assert len(body["picks"]) >= 3 and all(len(p["path"]) == N_MINUTES for p in body["picks"])


def test_stop_cuts_the_day_and_freezes_the_basket(world, paths):
    day = _a_scored_day(world)
    c = TestClient(create_app())
    base = c.get(f"/legwise/rotation/portfolio/day?day={day}&list=A").json()
    r = c.get(f"/legwise/rotation/portfolio/day?day={day}&list=A&stop=10000")
    assert r.status_code == 200, r.text
    body = r.json()
    lots = body["book"]["lots"]
    # 6 lots each diving 4,000 an hour in: combined reaches -10,000 before the hour
    assert body["book"]["stop_minute"] is not None and body["book"]["stop_minute"] < 60
    assert body["book"]["fired_by"] == "stop"
    assert body["book"]["gross_with"] <= -10000
    assert body["book"]["gross_with"] > -4000 * lots
    assert body["book"]["gross_without"] == base["book"]["gross_without"]
    assert body["setting"]["amount"] == 10000.0
    m = body["book"]["stop_minute"]
    assert all(v == body["stopped"][m] for v in body["stopped"][m:])
    assert body["level"][m] == -10000.0


@pytest.mark.parametrize("stop", ["", "0", "-5"])
def test_empty_zero_and_negative_stop_are_no_stop(world, paths, stop):
    day = _a_scored_day(world)
    r = TestClient(create_app()).get(
        f"/legwise/rotation/portfolio/day?day={day}&list=A&stop={stop}"
    )
    assert r.status_code == 200
    assert r.json()["book"]["stop_minute"] is None and r.json()["setting"]["amount"] is None


def test_trailing_is_parsed_and_echoed(world, paths):
    day = _a_scored_day(world)
    r = TestClient(create_app()).get(
        f"/legwise/rotation/portfolio/day?day={day}&list=A&stop=10000&trail=sl:1000,500"
    )
    assert r.status_code == 200
    assert r.json()["setting"] == {"amount": 10000.0, "trail": "sl:1000,500"}


@pytest.mark.parametrize(
    "query",
    ["stop=abc", "stop=nan", "trail=nope:1,2", "trail=sl:500,1000", "trail=lock:1", "list=Z"],
)
def test_bad_settings_are_422_and_never_ignored(world, paths, query):
    day = _a_scored_day(world)
    r = TestClient(create_app()).get(f"/legwise/rotation/portfolio/day?day={day}&{query}")
    assert r.status_code == 422, r.text
    assert "error" in r.json()


def test_unknown_and_unscored_days_are_clean_errors(world, paths):
    c = TestClient(create_app())
    assert c.get("/legwise/rotation/portfolio/day?day=2020-01-01&list=A").status_code == 404
    assert c.get("/legwise/rotation/portfolio/day?day=nope&list=A").status_code == 422
    assert c.get("/legwise/rotation/portfolio/day?list=A").status_code == 422
    _, sc = world
    waiting = next(d.isoformat() for d in sc["forward"] if sc["events"][d] == "waiting")
    r = c.get(f"/legwise/rotation/portfolio/day?day={waiting}&list=A")
    assert r.status_code == 409 and "waiting" in r.json()["error"]


def test_a_day_that_cannot_be_replayed_is_a_404_not_a_partial_book(world, monkeypatch):
    def broken(root, day, name, loaded=None):
        raise pf.PortfolioStopError(f"no collected NIFTY data for {day}")

    monkeypatch.setattr(pf, "one_lot_path", broken)
    r = TestClient(create_app()).get(
        f"/legwise/rotation/portfolio/day?day={_a_scored_day(world)}&list=A&stop=10000"
    )
    assert r.status_code == 404 and "no collected" in r.json()["error"]


def test_days_lists_every_scored_list_day_with_totals(world, paths):
    c = TestClient(create_app())
    off = c.get(
        "/legwise/rotation/portfolio/days?source=reconstructed&from=2026-09-21&to=2026-09-30"
    )
    assert off.status_code == 200, off.text
    on = c.get(
        "/legwise/rotation/portfolio/days?source=reconstructed&from=2026-09-21&to=2026-09-30"
        "&stop=10000"
    ).json()
    off = off.json()
    assert off["rows"] and len(on["rows"]) == len(off["rows"])
    for row in off["rows"]:
        for block in row["lists"].values():
            assert block["gross_with"] == block["gross_without"] and block["matches_log"]
    fired = sum(t["fired"] for t in on["totals"].values())
    assert fired > 0
    assert all(t["fired"] == 0 for t in off["totals"].values())
    assert set(on["totals"]) <= {"A", "B", "C", "REF"}


def test_days_validates_window_and_source(world, paths):
    c = TestClient(create_app())
    assert c.get("/legwise/rotation/portfolio/days?source=nope").status_code == 422
    assert (
        c.get("/legwise/rotation/portfolio/days?from=2026-10-02&to=2026-10-01").status_code == 422
    )
    assert c.get("/legwise/rotation/portfolio/days?from=junk").status_code == 422


def test_nothing_is_written(world, paths):
    root, _ = world
    before = _fingerprint(root)
    c = TestClient(create_app())
    c.get(f"/legwise/rotation/portfolio/day?day={_a_scored_day(world)}&list=A&stop=10000")
    c.get("/legwise/rotation/portfolio/days?source=reconstructed&stop=10000&trail=sl:1000,500")
    assert _fingerprint(root) == before
