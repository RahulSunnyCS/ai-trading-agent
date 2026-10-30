"""Paper figures after 0.5% slippage on every fill (owner, 2026-10-30): the stored results' copy
(`slip_store`), read per request by the Rotation pages (`store.slipped`, the API's `slippage`
parameter) and by the evening message (`slippage.apply`). The ranking never reads it."""

from __future__ import annotations

import csv
from datetime import date

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import slippage_middleware as mw
from option_backtesting.api.app import create_app
from option_backtesting.rotation import (
    deliver,
    journal,
    month,
    result,
    slip_store,
    slippage,
    store,
    tomorrow,
)

CORE = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]
T1 = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]
DAY = date(2026, 11, 3)
#: what slippage takes off one lot of each pick in these tests
COST = {"N_ditm1_0917": -40.0, "N_wide_1117": -25.5, "N_p100_1202": -10.0}


@pytest.fixture(autouse=True)
def half_a_percent(monkeypatch):
    monkeypatch.setattr(slippage, "SLIPPAGE_PCT", 0.5)
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")


@pytest.fixture
def sims(monkeypatch):
    """`slip_store.fill` without bars or strategy files: a pick's slippage is `COST`."""
    seen = []
    monkeypatch.setattr(slip_store, "_spec_and_underlying", lambda name: (name, "NIFTY"))
    monkeypatch.setattr(
        "option_backtesting.legwise.market.load_day", lambda root, u, d: seen.append(d) or d
    )

    def row(stored, spec, day_data, pct):
        cost = COST.get(spec, -5.0)
        return {
            **stored,
            "net": float(stored["net"]) + cost,
            "gross": float(stored["gross"]) + cost,
        }

    monkeypatch.setattr(slip_store, "slipped_row", row)
    return seen


def _day(root, day, values, core=CORE, track=None):
    journal.append(
        store.journal_path(root, track),
        {
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "before_first_entry": True,
            "dte": {"NIFTY": "2", "SENSEX": "4"},
            "dte_basis": "weekdays",
            "lists": {"C": {"core": core, "buy": []}},
        },
    )
    for name, value in zip(core, values, strict=True):
        store.append_result(
            name, {"day": day.isoformat(), "net": value, "gross": value, "worst_mtm": -1}, root
        )


# -- the store -----------------------------------------------------------------------------------


def test_the_copy_holds_each_day_after_slippage_and_is_read_only_when_asked(tmp_path, sims):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    out = slip_store.fill(root, log=lambda m: None)
    assert (out["written"], out["files"], out["skipped"]) == (3, 3, [])
    assert sims == [DAY]  # one load of the day for all its files
    assert store.read_net("N_wide_1117", root) == {DAY: -100.0}  # as stored by default
    with store.slipped(0.5):
        assert store.read_net("N_wide_1117", root) == {DAY: -125.5}
        assert store.reading_slip() == 0.5
        with store.slipped(0.0):  # what the ranking does
            assert store.read_net("N_wide_1117", root) == {DAY: -100.0}
    assert slip_store.fill(root, log=lambda m: None)["written"] == 0  # never rewritten


def test_a_day_that_cannot_be_copied_is_named_never_zero(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])

    def gone(*a):
        raise FileNotFoundError("no Fyers data")

    monkeypatch.setattr(slip_store, "_spec_and_underlying", gone)
    out = slip_store.fill(root, log=lambda m: None)
    assert out["written"] == 0 and len(out["skipped"]) == 3
    with store.slipped(0.5):
        assert store.read_net("N_wide_1117", root) == {}  # missing, not the unslipped figure


def test_only_the_offered_slippages_can_be_read():
    with pytest.raises(ValueError), store.slipped(1.0):
        pass


def test_a_write_under_the_context_still_goes_to_the_stored_results(tmp_path, sims):
    root = tmp_path / "TradingData"
    with store.slipped(0.5):
        assert store.append_result("N_wide_1117", {"day": "2026-11-02", "net": 5}, root)
    assert store.read_net("N_wide_1117", root) == {date(2026, 11, 2): 5.0}


def test_the_ranking_reads_the_stored_figures_under_the_context(tmp_path, sims, monkeypatch):
    from option_backtesting.rotation import pick

    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    slip_store.fill(root, log=lambda m: None)
    seen = []
    monkeypatch.setattr(store, "load_matrix", lambda *a, **k: seen.append(store.reading_slip()))
    with store.slipped(0.5), pytest.raises(Exception):  # noqa: B017 - stops after the read
        pick.load_history(DAY, root, CORE)
    assert seen == [0.0]


# -- the API parameter ---------------------------------------------------------------------------


def test_which_routes_take_the_parameter():
    assert mw.applies("/legwise/rotation/summary")
    assert mw.applies("/legwise/rotation/portfolio/days")
    assert mw.applies("/legwise/correlation")
    assert not mw.applies("/legwise/rotation/explain")
    assert not mw.applies("/legwise/rotation/ic")
    assert not mw.applies("/legwise/rotation/live")
    assert not mw.applies("/legwise/rotations")
    assert not mw.applies("/legwise/heatmap")
    assert mw.parse(b"") == 0.0
    assert mw.parse(b"slippage=0.5&lots=2") == 0.5
    assert mw.parse(b"slippage=0") == 0.0
    assert isinstance(mw.parse(b"slippage=1"), str)
    assert isinstance(mw.parse(b"slippage=x"), str)


def test_a_request_reads_at_its_slippage_sync_routes_included(tmp_path):
    app = create_app(cache_dir=tmp_path)

    @app.get("/legwise/rotation/_probe")
    def probe() -> dict:  # a sync route: runs in the thread pool
        return {"slip": store.reading_slip()}

    @app.get("/legwise/rotation/live/_probe")
    def live_probe() -> dict:
        return {"slip": store.reading_slip()}

    client = TestClient(app)
    assert client.get("/legwise/rotation/_probe?slippage=0.5").json() == {"slip": 0.5}
    assert client.get("/legwise/rotation/_probe").json() == {"slip": 0.0}
    assert client.get("/legwise/rotation/live/_probe?slippage=0.5").json() == {"slip": 0.0}
    bad = client.get("/legwise/rotation/_probe?slippage=2")
    assert bad.status_code == 422 and "slippage must be one of" in bad.json()["error"]
    assert store.reading_slip() == 0.0  # nothing leaks out of a request


# -- the evening message -------------------------------------------------------------------------


def test_apply_reads_the_copy_and_fills_a_missing_pick(tmp_path, sims):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    r = slippage.apply(result.calculate(DAY, root), root)  # nothing copied yet: fills it
    assert r.strategies["C"] == [
        ("N_ditm1_0917", 360.0),
        ("N_wide_1117", -125.5),
        ("N_p100_1202", 90.0),
    ]
    assert r.gains["C"] == pytest.approx(324.5) and r.slippage_pct == 0.5
    assert r.entry_hash == result.calculate(DAY, root).entry_hash  # the sent markers are the same
    assert slippage.apply(r, root) is r  # already slipped: never twice
    assert len(sims) == 1  # the second read is the copy
    assert slippage.apply(result.calculate(DAY, root), root) == r
    assert len(sims) == 1


def test_no_slippage_leaves_the_result_alone(tmp_path, sims):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    r = result.calculate(DAY, root)
    assert slippage.apply(r, root, pct=0) is r and sims == []


def test_the_month_counts_the_slipped_figures(tmp_path, sims):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 11, 2), [30.0, 10.0, 10.0])  # +50, but -25.5 after slippage
    _day(root, DAY, [400.0, -100.0, 100.0])
    m = month.paper(DAY, root)
    assert (m.net, m.days, m.won, m.slippage_pct) == (pytest.approx(324.5 - 25.5), 2, 1, 0.5)


def _evening(root, monkeypatch, err=None):
    nxt = tomorrow.NextPicks(date(2026, 11, 4), "Wed", CORE, [], None, None)
    monkeypatch.setattr(tomorrow, "next_session_picks", lambda today, root=None, track=None: nxt)
    monkeypatch.setattr(deliver, "message_boost", lambda: {"adaptive": False, "t1": False})
    monkeypatch.setattr(month, "real", lambda day, root=None: None)
    sent = []

    def send(text, severity="info", chat_id=None):
        sent.append((chat_id, text))
        return True

    code = deliver.send_result(
        DAY,
        root=root,
        send=send,
        echo=lambda m: None,
        err=err or (lambda m: None),
        alert=lambda title, body: None,
    )
    return code, dict(sent)


def test_the_message_says_and_shows_the_slippage(tmp_path, monkeypatch, sims):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    _day(root, DAY, [200.0, 0.0, 0.0], core=T1, track="t1")
    code, sent = _evening(root, monkeypatch)
    assert code == 0
    for text in sent.values():
        assert "1 lot per strategy, after costs and 0.5% slippage" in text
        assert "🎯 Adaptive   +₹324\n" in text
        assert "📅 November so far · paper, 1 lot per strategy, 0.5% slippage" in text


def test_a_day_that_cannot_be_slipped_goes_out_without_it(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])

    def gone(*a):
        raise FileNotFoundError("no Fyers data")

    monkeypatch.setattr(slip_store, "_spec_and_underlying", gone)
    errors = []
    code, sent = _evening(root, monkeypatch, err=errors.append)
    assert code == 0
    assert "1 lot per strategy, after costs\n" in sent[None]
    assert "🎯 Adaptive   +₹400" in sent[None]
    assert "so far" not in sent[None]  # the month is left out, never mixed
    assert any("slippage not applied" in e for e in errors)


def test_the_copy_keeps_the_stored_columns(tmp_path, sims):
    root = tmp_path / "TradingData"
    _day(root, DAY, [400.0, -100.0, 100.0])
    slip_store.fill(root, log=lambda m: None)
    path = store.slip_path(store.result_path("N_wide_1117", root), 0.5)
    with path.open() as f:
        assert next(csv.reader(f)) == store.RESULT_COLUMNS


def test_a_background_replay_reads_at_its_callers_slippage():
    from option_backtesting.rotation import warm

    with store.slipped(0.5):
        assert warm.run_within("probe", store.reading_slip, wait=5) == (True, 0.5)
    assert warm.run_within("probe", store.reading_slip, wait=5) == (True, 0.0)
