"""The weekly Friday job end to end, on generated prices with every network source faked."""

import contextlib
import json
from datetime import datetime

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import local_store, notify, runs_store, store, weekly
from momentum_backtesting.fetch import load_universe
from momentum_backtesting.notify import IST, Notification
from momentum_backtesting.sources import weekly as to_weekly

FRIDAY = pd.Timestamp("2026-09-25")
PREVIEW_AT = datetime(2026, 9, 25, 14, 40, tzinfo=IST)
FINAL_AT = datetime(2026, 9, 25, 16, 45, tzinfo=IST)


def _truth(last_day: pd.Timestamp = FRIDAY) -> tuple[dict, dict]:
    """Full daily history per instrument (signal) and per ETF, up to last_day."""
    days = pd.bdate_range("2016-01-01", last_day)
    rng = np.random.default_rng(11)
    signal, etf = {}, {}
    for inst in load_universe():
        drift = 0.0002 if inst.include != "defensive" else 0.00025
        vol = 0.012 if inst.include != "defensive" else 0.0002
        close = 100 * np.cumprod(1 + rng.normal(drift, vol, len(days)))
        frame = pd.DataFrame({"open": close * 0.999, "close": close}, index=days)
        if inst.price_source.startswith(("AMFI:", "INDEXFX:")) or inst.price_source == "SILVER":
            frame = frame[["close"]]
        signal[inst.name] = frame
        if inst.has_etf:
            listed = frame[frame.index >= "2020-01-01"][["close"]] * 0.1
            listed["open"] = listed["close"]
            etf[inst.name] = listed
    return signal, etf


@pytest.fixture
def data_dir(tmp_path):
    """History up to Thursday, as the database would hold before Friday's runs."""
    signal, etf = _truth()
    cutoff = FRIDAY - pd.Timedelta(days=1)
    out = tmp_path / "data"
    (out / "daily").mkdir(parents=True)
    (out / "daily_etf").mkdir()
    weekly_table = {}
    for name, frame in signal.items():
        part = frame[frame.index <= cutoff]
        part.to_csv(out / "daily" / f"{name}.csv", index_label="date")
        weekly_table[name] = to_weekly(part["close"])
    for name, frame in etf.items():
        frame[frame.index <= cutoff].to_csv(out / "daily_etf" / f"{name}.csv", index_label="date")
    table = pd.DataFrame(weekly_table)
    table.index.name = "week_ending"
    table.to_csv(out / "weekly_closes.csv")
    return out


@pytest.fixture
def sources(monkeypatch):
    """Fake every outside source from the same truth; returns a setter for a holiday."""
    state = {"last": FRIDAY}

    def truth():
        return _truth(state["last"])

    by_etf = {f"{i.trade_etf}.NS": i.name for i in load_universe()}
    by_nse = {i.backfill.removeprefix("NIFTYINDICES:"): i.name for i in load_universe()}
    by_source = {i.price_source: i.name for i in load_universe()}

    def yahoo_candles(symbol, start):
        signal, etf = truth()
        name = by_etf.get(symbol)
        if name in etf:
            return etf[name]
        source = "NSE:" + symbol.removesuffix(".NS") + "-EQ"
        return signal[by_source[source]]

    def yahoo_quote(symbol):
        signal, etf = truth()
        name = by_etf[symbol]
        frame = etf.get(name, signal[name])
        return float(frame["close"].iloc[-1]) * 1.001, pd.Timestamp(PREVIEW_AT)

    def niftyindices_candles(name, start, end):
        return truth()[0][by_nse[name]]

    def amfi_nav(code, start, adjust=True):
        return truth()[0][by_source[f"AMFI:{code}"]]["close"]

    def index_in_inr(index_symbol, fx_symbol, start, previous_close):
        key = next(k for k in by_source if k.startswith(f"INDEXFX:{index_symbol}:"))
        return truth()[0][by_source[key]]["close"]

    def silver_daily(start):
        return truth()[0]["Silver"]["close"]

    for name, fn in {
        "yahoo_candles": yahoo_candles,
        "yahoo_quote": yahoo_quote,
        "niftyindices_candles": niftyindices_candles,
        "amfi_nav": amfi_nav,
        "index_in_inr": index_in_inr,
        "silver_daily": silver_daily,
    }.items():
        monkeypatch.setattr(weekly, name, fn)
    return state


def test_final_run_ranks_on_todays_closes_and_says_what_to_do(data_dir, sources):
    result = weekly.run_weekly("final", data_dir, now=FINAL_AT)
    assert result.signal is not None and result.signal["week"] == "2026-09-25"
    text = notify.render(result.notification, FINAL_AT)
    assert "Momentum FINAL — week of 25 Sep 2026" in text
    assert "Model portfolio · top 5" in text
    assert "estimated from ETF" in text  # indices with no official source here were estimated
    assert "preview" not in text.lower()  # no stored preview to compare with
    stored = pd.read_csv(data_dir / "daily" / "Nifty 50.csv", index_col=0, parse_dates=True)
    assert stored.index[-1] == FRIDAY


def test_a_final_run_saves_the_favourites_display_name_alongside_the_signal(data_dir, sources):
    """B6: a reader of momentum_signals shouldn't have to decode the engine's config label
    to know which favourite produced a saved signal."""
    from momentum_backtesting.db_read import open_catalog

    weekly.run_weekly(
        "final", data_dir, now=FINAL_AT, catalog=open_catalog, display_name="ETF Core"
    )
    label = weekly.load_live_config().config.label
    with open_catalog() as conn:
        saved = local_store.load_signal(conn, "2026-09-25", "final", label)
    assert saved["display_name"] == "ETF Core"


def test_a_weekly_run_never_holds_the_catalog_while_it_refreshes_or_computes(
    data_dir, sources, monkeypatch
):
    """The run refreshes prices over the network and backtests every favourite (minutes); the
    catalog may be open only around each store, or `obt daily` / `tdata` time out on its lock."""
    from momentum_backtesting.db_read import open_catalog

    open_now = []

    @contextlib.contextmanager
    def tracked():
        with open_catalog() as conn:
            open_now.append(conn)
            try:
                yield conn
            finally:
                open_now.remove(conn)

    seen = []
    real_refresh, real_compute = weekly.refresh, weekly.compute_signal

    def refresh(*args, **kwargs):
        seen.append(("refresh", len(open_now)))
        return real_refresh(*args, **kwargs)

    def compute_signal(*args, **kwargs):
        seen.append(("compute", len(open_now)))
        return real_compute(*args, **kwargs)

    monkeypatch.setattr(weekly, "refresh", refresh)
    monkeypatch.setattr(weekly, "compute_signal", compute_signal)
    outcomes = weekly.run_favorite_strategies("final", data_dir, now=FINAL_AT, catalog=tracked)

    assert outcomes[0]["result"].signal is not None
    assert seen == [("refresh", 0), ("compute", 0)]


def test_preview_uses_live_prices_but_never_stores_them(data_dir, sources):
    before = {p.name: p.read_bytes() for p in (data_dir / "daily").glob("*.csv")}
    result = weekly.run_weekly("preview", data_dir, now=PREVIEW_AT)
    assert result.signal["week"] == "2026-09-25"
    text = notify.render(result.notification, PREVIEW_AT)
    assert "PREVIEW" in text and "live prices" in text
    for path in (data_dir / "daily").glob("*.csv"):
        frame = pd.read_csv(path, index_col=0, parse_dates=True)
        assert FRIDAY not in frame.index, f"{path.name} kept a preview price"
    assert set(before) == {p.name for p in (data_dir / "daily").glob("*.csv")}


def test_a_late_preview_warns_there_is_no_time_left(data_dir, sources):
    late = datetime(2026, 9, 25, 15, 20, tzinfo=IST)
    result = weekly.run_weekly("preview", data_dir, now=late)
    assert "too late to trade" in notify.render(result.notification, late)


def test_friday_holiday_uses_thursdays_close_and_keeps_friday_week_label(data_dir, sources):
    sources["last"] = FRIDAY - pd.Timedelta(days=1)  # Friday market holiday
    result = weekly.run_weekly("final", data_dir, now=FINAL_AT)
    assert result.signal is not None
    # `sources.weekly()` intentionally labels the last session of this week as Friday.
    assert result.signal["week"] == "2026-09-25"
    assert "Official close: Thu 24 Sep" in result.notification.body


def test_last_nse_session_walks_back_across_consecutive_holidays():
    wednesday = (FRIDAY - pd.Timedelta(days=2)).date()
    health = weekly.Health(FRIDAY.date(), last_day={"A": wednesday})
    assert weekly.last_nse_session(health, ["A"], FRIDAY.date()) == wednesday


def test_favorite_strategies_share_one_refresh_and_only_etf_is_eligible(monkeypatch, tmp_path):
    snapshot = weekly.WeeklySnapshot(weekly.Health(FRIDAY.date()), [], FRIDAY.date(), FRIDAY.date())
    favorites = [
        {"id": "one", "name": "ETF A", "config": {"dataset": "etf"}, "active": True},
        {"id": "two", "name": "ETF B", "config": {"dataset": "etf"}, "active": False},
        {"id": "three", "name": "Stocks", "config": {"dataset": "stock"}, "active": False},
    ]
    seen_snapshots = []
    seen_display_names = []

    monkeypatch.setattr(runs_store, "list_favorites", lambda _conn: favorites)
    monkeypatch.setattr(weekly, "refresh_weekly_snapshot", lambda *args: snapshot)

    def fake_run_weekly(*args, **kwargs):
        seen_snapshots.append(kwargs["snapshot"])
        seen_display_names.append(kwargs.get("display_name"))
        return weekly.RunResult(Notification("test", "info", "ok", "body"), {"week": "2026-09-25"})

    monkeypatch.setattr(weekly, "run_weekly", fake_run_weekly)
    outcomes = weekly.run_favorite_strategies(
        "final", tmp_path, now=FINAL_AT, catalog=lambda: contextlib.nullcontext(object())
    )

    assert [outcome["name"] for outcome in outcomes] == ["ETF A", "ETF B", "Stocks"]
    assert seen_snapshots == [snapshot, snapshot]
    # B6: the favourite's display name is threaded through so a saved signal's payload can
    # carry it, instead of only the engine's config-derived label.
    assert seen_display_names == ["ETF A", "ETF B"]
    assert outcomes[2]["result"] is None
    assert outcomes[2]["blocked"] == "Weekly ingest is not yet available for this dataset."


def test_saved_dashboard_config_translates_tax_and_drops_its_saved_end_date():
    off = weekly.settings_from_saved_config(
        {"dataset": "etf", "tax": False, "slab_rate": 0.3, "end": "2026-10-02", "top_n": 5}
    )
    assert off.config.tax is None  # a raw False here used to read as "tax on" and block the run
    assert off.config.end is None  # the live signal always runs to the latest week
    on = weekly.settings_from_saved_config({"tax": True, "slab_rate": 0.2})
    assert on.config.tax is not None and on.config.tax.slab_rate == pytest.approx(0.2)


def test_a_tax_aware_saved_favourite_still_computes_a_signal(data_dir):
    settings = weekly.settings_from_saved_config({"tax": True, "slab_rate": 0.3})
    assert weekly.compute_signal(data_dir, settings)["rows"]


def test_stale_data_sends_an_alert_instead_of_a_signal(data_dir, sources, monkeypatch):
    def broken(symbol, start):
        raise OSError("blocked")

    monkeypatch.setattr(weekly, "yahoo_candles", broken)
    real = weekly.niftyindices_candles
    monkeypatch.setattr(
        weekly,
        "niftyindices_candles",
        lambda n, s, e: real(n, s, e) if "MIDCAP" in n else broken(n, s),
    )
    result = weekly.run_weekly("final", data_dir, now=FINAL_AT)
    assert result.signal is None
    assert result.notification.severity == "error"
    assert "too stale" in result.notification.title


def test_final_reports_what_changed_since_the_preview():
    preview = {"rows": [{"asset": "A", "action": "BUY"}, {"asset": "B", "action": "HOLD"}]}
    final = {"rows": [{"asset": "A", "action": "WAIT"}, {"asset": "B", "action": "HOLD"}]}
    assert weekly.changes(preview, final) == ["A: BUY -> WAIT"]
    assert weekly.changes(None, final) == []


def test_buying_above_nav_is_flagged():
    settings = weekly.load_live_config()
    signal = {
        "week": "2026-09-25",
        "config": {"top_n": 5, "exit_rank": 10, "track": "index", "lookbacks": [1]},
        "rows": [
            {
                "asset": "Nasdaq 100",
                "etf": "MON100",
                "rank": 1,
                "previous_rank": 7,
                "action": "BUY",
                "held": False,
                "premium": 0.035,
            },
            {
                "asset": "Nifty IT",
                "etf": "ITBEES",
                "rank": 2,
                "previous_rank": 2,
                "action": "BUY",
                "held": False,
                "premium": 0.004,
            },
            {
                "asset": "Nifty Bank",
                "etf": "BANKBEES",
                "rank": 12,
                "previous_rank": 4,
                "action": "SELL",
                "held": True,
                "premium": None,
            },
        ],
    }
    health = weekly.Health(FRIDAY.date(), fyers="no token")
    note = weekly.format_message(signal, "final", health, settings, FINAL_AT, None, [])
    text = notify.render(note, FINAL_AT)
    assert "MON100) — rank 1 · premium +3.5% ⚠️ buying above NAV" in text
    assert "ITBEES) — rank 2 · premium +0.4%" in text and text.count("⚠️ buying") == 1
    assert text.index("SELL") < text.index("BUY / TOP UP")
    assert "↑ Nasdaq 100 7 → 1" in text and "Same as the preview." in text
    assert note.severity == "action_required"


def test_live_config_loads_into_the_engine_config():
    settings = weekly.load_live_config()
    assert settings.config.top_n == 5 and settings.config.lookbacks == (1, 4, 13, 26, 52)
    assert settings.premium_warn == pytest.approx(0.01)


# --- Telegram -----------------------------------------------------------------------------------


def test_messages_are_redacted_and_never_set_parse_mode(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-token-123")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")
    monkeypatch.setenv("MOMENTUM_DATABASE_URL", "postgres://user:pw@neon/db")
    sent = {}

    class Response:
        def read(self):
            return b"{}"

    def fake_urlopen(request, timeout):
        sent["url"] = request.full_url
        sent["body"] = json.loads(request.data)
        return Response()

    monkeypatch.setattr(notify.urllib.request, "urlopen", fake_urlopen)
    notify.send(Notification("t", "error", "boom", "failed at postgres://user:pw@neon/db"))
    assert "parse_mode" not in sent["body"]
    assert sent["body"]["disable_web_page_preview"] is True
    assert "postgres://user:pw@neon/db" not in sent["body"]["text"]
    assert "***REDACTED***" in sent["body"]["text"]


def test_a_telegram_failure_never_raises(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-token-123")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "42")

    def down(request, timeout):
        raise OSError("network down for bot-token-123")

    monkeypatch.setattr(notify.urllib.request, "urlopen", down)
    notify.send(Notification("t", "info", "hello"))


def test_long_messages_are_truncated_to_telegrams_limit():
    text = notify.render(Notification("t", "info", "x", "y" * 5000))
    assert len(text) <= notify.TELEGRAM_LIMIT and text.endswith("(truncated)")


# --- storage ------------------------------------------------------------------------------------


def test_a_data_folder_survives_a_round_trip_through_rows(data_dir, tmp_path):
    (data_dir / "intraday" / "etf").mkdir(parents=True)
    pd.DataFrame({"price": [1.5]}, index=pd.DatetimeIndex(["2026-09-21"], name="date")).to_csv(
        data_dir / "intraday" / "etf" / "Nifty 50.csv"
    )
    rows = list(store.rows_from_dir(data_dir))
    out = tmp_path / "copy"
    store.write_dir(rows, out)
    for rel in (
        "daily/Nifty 50.csv",
        "daily/Cash (liquid fund).csv",
        "daily_etf/Nifty IT.csv",
        "intraday/etf/Nifty 50.csv",
        "weekly_closes.csv",
    ):
        a = pd.read_csv(data_dir / rel, index_col=0, parse_dates=True)
        b = pd.read_csv(out / rel, index_col=0, parse_dates=True)
        pd.testing.assert_frame_equal(
            a[sorted(a.columns)], b[sorted(b.columns)], check_names=False, check_freq=False
        )


def test_local_db_push_pull_and_signals_round_trip(data_dir, tmp_path):
    """The local-database equivalent of the old Postgres integration test above
    (TODO.md 3.11.5 - Neon retired in favour of the shared trading-data catalog)."""
    from trading_data.db import connect

    with connect() as conn:
        first = local_store.push_dir(conn, data_dir)
        local_store.push_dir(conn, data_dir)  # again: no duplicates
        count = conn.execute("SELECT count(*) FROM momentum_prices").fetchone()[0]
        assert count == first
        out = tmp_path / "pulled"
        local_store.pull_dir(conn, out)
        a = pd.read_csv(data_dir / "weekly_closes.csv", index_col=0, parse_dates=True)
        b = pd.read_csv(out / "weekly_closes.csv", index_col=0, parse_dates=True)
        pd.testing.assert_frame_equal(a[sorted(a.columns)], b[sorted(b.columns)], check_freq=False)
        local_store.save_signal(conn, "2026-09-25", "preview", "lbl", {"rows": [1]})
        local_store.save_signal(conn, "2026-09-25", "preview", "lbl", {"rows": [2]})
        assert local_store.load_signal(conn, "2026-09-25", "preview", "lbl") == {"rows": [2]}
        assert local_store.load_signal(conn, "2026-09-25", "final", "lbl") is None


# --- BL-136: the premium gate ------------------------------------------------------------------


def test_live_config_carries_the_premium_gate_and_zero_turns_it_off(tmp_path):
    settings = weekly.load_live_config()
    assert settings.premium_block == pytest.approx(0.02)
    assert settings.premium_block_international == pytest.approx(0.05)
    assert settings.premium_limits(True) == (pytest.approx(0.02), pytest.approx(0.05))
    off = tmp_path / "live.toml"
    off.write_text(
        weekly.LIVE_CONFIG.read_text()
        .replace("premium_block_pct = 2.0", "premium_block_pct = 0")
        .replace("premium_block_international_pct = 5.0", "premium_block_international_pct = 0")
    )
    assert weekly.load_live_config(off).premium_block is None
    assert weekly.load_live_config(off).premium_block_international is None
    # Every ETF favourite shares the one setting, not just the fallback strategy.
    saved = weekly.settings_from_saved_config({"dataset": "etf", "top_n": 3, "exit_rank": 6})
    assert saved.premium_block_international == pytest.approx(0.05)


def test_the_newest_premium_known_at_the_close_decides_and_the_limit_is_per_tax_class():
    week = pd.Timestamp("2026-10-16")
    premiums = pd.DataFrame(
        {
            "Nasdaq 100": [0.10, 0.1689, float("nan")],  # Friday's NAV is not out at 16:45
            "Nifty IT": [0.004, 0.025, 0.03],
            "Gold": [0.001, 0.001, 0.001],
        },
        index=pd.to_datetime(["2026-10-14", "2026-10-15", "2026-10-16"]),
    )
    latest = weekly.latest_premiums(premiums, week)
    assert latest["Nasdaq 100"] == (pytest.approx(0.1689), "2026-10-15")
    # Friday's own NAV is published after the close the signal is decided at: even when a later
    # rerun finds it in the file, the gate reads Thursday's (BL-136 Phase 0's look-ahead rule).
    assert latest["Nifty IT"] == (pytest.approx(0.025), "2026-10-15")
    assert weekly.latest_premiums(premiums, pd.Timestamp("2026-10-15"))["Nifty IT"][1] == (
        "2026-10-14"
    )
    assert "Gold" in weekly.latest_premiums(premiums, pd.Timestamp("2026-10-15"))
    assert weekly.latest_premiums(premiums, pd.Timestamp("2026-10-14")) == {}
    by_name = {i.name: i for i in load_universe()}
    settings = weekly.load_live_config()
    blocked = weekly.premium_blocked(latest, by_name, settings)
    # International names get the 5% line, the rest 2%: IT at 3% is over, Gold is not.
    assert blocked == {"Nasdaq 100": pytest.approx(0.05), "Nifty IT": pytest.approx(0.02)}
    off = weekly.LiveSettings(settings.config, premium_block=None, premium_block_international=None)
    assert weekly.premium_blocked(latest, by_name, off) == {}
    assert weekly.latest_premiums(pd.DataFrame(), week) == {}


def test_a_gated_name_is_never_bought_and_the_row_says_what_the_gate_did(data_dir):
    """The whole live path on the generated history: every ETF-backed name is put far above NAV.
    A fresh top-N name among them is either `SKIP (premium)` (the week would have bought it and
    the next-best name took its slot) or keeps the action it had anyway (WAIT on a week with no
    sale) with the note that it will not be bought while over the limit. Never a BUY, and a held
    name is never touched. The generated history gives a no-sale week, so the refill itself is
    pinned by `analysis.latest_signal`'s own tests, not here."""
    universe = load_universe()
    thursday = FRIDAY - pd.Timedelta(days=1)
    gated = [i.name for i in universe if i.amfi_code]
    table = pd.DataFrame({name: [0.30] for name in gated}, index=[thursday])
    table.index.name = "date"
    table.to_csv(data_dir / "etf_premium.csv")
    settings = weekly.load_live_config()
    signal = weekly.compute_signal(data_dir, settings)
    off = weekly.LiveSettings(settings.config, premium_block=None, premium_block_international=None)
    plain = {r["asset"]: r["action"] for r in weekly.compute_signal(data_dir, off)["rows"]}
    top_n = settings.config.top_n
    fresh_tops = [
        r
        for r in signal["rows"]
        if r["rank"] and r["rank"] <= top_n and not r["held"] and r["asset"] in gated
    ]
    assert fresh_tops, "the generated history should rank a gated name in the top N unheld"
    for row in fresh_tops:
        assert not row["action"].startswith("BUY"), row
        assert row["premium"] == pytest.approx(0.30)
        assert row["premium_date"] == f"{thursday:%Y-%m-%d}"
        assert row["premium_limit"] in (pytest.approx(0.02), pytest.approx(0.05))
        if plain[row["asset"]].startswith("BUY"):
            assert row["action"] == weekly.PREMIUM_SKIP
            assert "the next-best name takes its slot" in row["reason"]
        else:
            assert row["action"] == plain[row["asset"]]  # WAIT, or no action: not a refused buy
            assert "will not be bought while it stays there" in row["reason"]
    for row in signal["rows"]:
        if row["action"].startswith("BUY"):
            assert row["asset"] not in gated, row
        if row["held"]:
            assert row["action"] != weekly.PREMIUM_SKIP
    assert all("premium_date" in r for r in signal["rows"])
    assert not any("reason" in r for r in weekly.compute_signal(data_dir, off)["rows"])


def test_the_limit_is_printed_as_written():
    assert weekly.pct(0.05) == "5%" and weekly.pct(0.025) == "2.5%" and weekly.pct(0.015) == "1.5%"


def test_the_message_lists_a_skipped_name_apart_from_the_buys_and_a_top_up_is_only_flagged():
    settings = weekly.load_live_config()
    signal = {
        "week": "2026-10-16",
        "config": {"top_n": 5, "exit_rank": 10, "track": "etf", "lookbacks": [1]},
        "rows": [
            {
                "asset": "Nasdaq 100",
                "etf": "MON100",
                "rank": 1,
                "previous_rank": 3,
                "action": weekly.PREMIUM_SKIP,
                "held": False,
                "premium": 0.1689,
                "premium_limit": 0.05,
                "reason": "MON100 trades +16.9% above NAV (2026-10-15), over the 5% limit: "
                "not bought, the next-best name takes its slot (BL-136).",
            },
            {
                "asset": "Nifty Metal",
                "etf": "METALIETF",
                "rank": 6,
                "previous_rank": 8,
                "action": "BUY",
                "held": False,
                "premium": 0.002,
            },
            {
                "asset": "Gold",
                "etf": "GOLDBEES",
                "rank": 2,
                "previous_rank": 2,
                "action": "ADD",
                "held": True,
                "premium": 0.03,
            },
        ],
    }
    health = weekly.Health(FRIDAY.date(), fyers="no token")
    note = weekly.format_message(signal, "final", health, settings, FINAL_AT, None, [])
    text = notify.render(note, FINAL_AT)
    assert "NOT BOUGHT · ETF too far above NAV" in text
    assert "MON100) — rank 1 · premium +16.9% · over the 5% limit, next-best name instead" in text
    assert "GOLDBEES) — rank 2 · premium +3.0% ⚠️ buying above NAV" in text
    assert text.index("BUY / TOP UP") < text.index("NOT BOUGHT")
    assert note.severity == "action_required"

    # A week whose only event is the skip has nothing to place: "No trades", informational.
    only_skip = {**signal, "rows": [signal["rows"][0]]}
    note = weekly.format_message(only_skip, "final", health, settings, FINAL_AT, None, [])
    text = notify.render(note, FINAL_AT)
    assert "No trades this week." in text and "NOT BOUGHT" in text
    assert note.severity == "info"

    # On a week with no sale the gated name keeps its WAIT and carries the note instead.
    waiting = {
        **signal,
        "rows": [
            {
                **signal["rows"][0],
                "action": "WAIT",
                "reason": "MON100 trades +16.9% above NAV (2026-10-15), over the 5% limit: it "
                "will not be bought while it stays there (BL-136).",
            }
        ],
    }
    text = notify.render(
        weekly.format_message(waiting, "final", health, settings, FINAL_AT), FINAL_AT
    )
    assert "WAITING FOR A SALE" in text and "NOT BOUGHT" not in text
    assert "premium +16.9% · over the 5% limit, not bought while there" in text
