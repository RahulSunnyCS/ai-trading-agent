"""BL-219: the GOLDM Dir forward paper test — the frozen rule equals BL-218's grid cell, the expiry
window, the calendar extension, scoring into a hash-chained journal, and the 18:00 spread
snapshot. No network: the Fyers client and the MCX master are faked."""

import importlib.util
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.lake import BAR_SCHEMA, OPT_SCHEMA

from option_backtesting import mcx_forward as mf
from option_backtesting.fyers.symbols import Contract
from option_backtesting.legwise.market import mcx_calendar_path
from option_backtesting.rotation import journal

IST = timezone(timedelta(hours=5, minutes=30))
DAY = date(2026, 11, 24)
EXPIRY = date(2026, 11, 27)
FUT = "MCX:GOLDM26DECFUT"

_GRID = Path(__file__).resolve().parents[2] / "research" / "bl218" / "grid.py"


def _grid():
    spec = importlib.util.spec_from_file_location("bl218_grid_fwd", _GRID)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bl218_grid_fwd"] = module
    spec.loader.exec_module(module)
    return module


def test_the_frozen_rule_equals_the_bl218_grid_cell_and_its_sha():
    grid = _grid()
    cell = next(c for c in grid.cells("dir") if c.id == mf.CELL_ID)
    for season in ("summer", "winter"):
        assert mf.strategy(season) == grid.build(cell, mf.ROOT, season)
    assert mf.GRID_SHA == grid.grid_sha() == "88bc794621b0ee32"


def _weekdays(a: date, b: date) -> list[date]:
    out, d = [], a
    while d <= b:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def test_the_window_is_the_last_five_sessions_ending_on_expiry():
    # before any of it has happened: the five weekdays to come
    assert mf.window(EXPIRY, [], date(2026, 11, 20)) == _weekdays(date(2026, 11, 23), EXPIRY)
    # with the sessions collected up to the 24th
    collected = _weekdays(date(2026, 11, 16), date(2026, 11, 24))
    assert mf.window(EXPIRY, collected, DAY) == _weekdays(date(2026, 11, 23), EXPIRY)
    # a holiday on the 25th (no bars, not a session): the real window starts a day earlier, and
    # the days scored before it was known (23, 24) stay inside it
    held = [d for d in _weekdays(date(2026, 11, 16), EXPIRY) if d != date(2026, 11, 25)]
    real = mf.window(EXPIRY, held, EXPIRY)
    assert real == [date(2026, 11, 20), date(2026, 11, 23), date(2026, 11, 24)] + [
        date(2026, 11, 26),
        EXPIRY,
    ]
    assert {date(2026, 11, 23), DAY} <= set(real)


def test_in_expected_window_counts_weekdays_to_expiry():
    assert mf.in_expected_window(date(2026, 11, 23), EXPIRY)
    assert mf.in_expected_window(EXPIRY, EXPIRY)
    assert not mf.in_expected_window(date(2026, 11, 20), EXPIRY)
    assert not mf.in_expected_window(date(2026, 11, 30), EXPIRY)
    assert not mf.in_expected_window(date(2026, 10, 28), date(2026, 10, 29))  # before the start


def test_extend_calendar_adds_listed_expiries_with_their_settling_future(tmp_path, monkeypatch):
    def contract(symbol, expiry, option_type, strike=None):
        return Contract(symbol, "GOLDM", expiry, strike, option_type, 0)

    contracts = [
        contract("MCX:GOLDM26DECFUT", date(2026, 12, 4), "FUT"),
        contract("MCX:GOLDM27JANFUT", date(2027, 1, 5), "FUT"),
        contract("MCX:GOLDM26NOV140000CE", EXPIRY, "CE", 140000.0),
        contract("MCX:GOLDM26DEC140000CE", date(2026, 12, 29), "CE", 140000.0),
    ]
    monkeypatch.setattr(mf, "parse_master", lambda text, names: contracts)
    out = mf.extend_calendar(tmp_path, DAY, master_text="x")
    assert out["added"] == ["2026-11-27", "2026-12-29"]
    cal = json.loads(mcx_calendar_path(tmp_path, "GOLDM").read_text())
    assert cal["options"] == {"2026-11-27": FUT, "2026-12-29": "MCX:GOLDM27JANFUT"}
    assert cal["futures"][FUT] == "2026-12-04"
    assert mf.extend_calendar(tmp_path, DAY, master_text="x")["added"] == []  # idempotent


def _bars(rows, schema, extra):
    cols = {k: [] for k in schema.names}
    for (minute, price), ex in zip(rows, extra, strict=True):
        cols["ts"].append(
            int(datetime(2026, 11, 24, minute // 60, minute % 60, tzinfo=IST).timestamp())
        )
        for k in ("open", "high", "low", "close"):
            cols[k].append(price)
        cols["volume"].append(1.0)
        cols["oi"].append(None)
        for k, v in ex.items():
            cols[k].append(v)
    cols["ts"] = pa.array(cols["ts"], pa.int64()).cast(lake.TS_TYPE)
    return pa.table(cols, schema=schema)


@pytest.fixture
def root(tmp_path):
    """One GOLDM session (24 Nov 2026, expiry 27 Nov): the future at 140,000 all evening, and
    every strike 139,500..140,500 CE+PE flat at 1,000 (so no stop fires)."""
    rows, extra = [], []
    for i, (strike, side) in enumerate(
        (k, s) for k in (139000.0, 139500.0, 140000.0, 140500.0, 141000.0) for s in ("CE", "PE")
    ):
        for minute in range(17 * 60, 23 * 60 + 30):
            rows.append((minute, 1000.0))
            extra.append(
                {
                    "instrument_id": 10 + i,
                    "expiry": EXPIRY,
                    "strike": strike,
                    "option_type": side,
                    "vendor_symbol": f"MCX:GOLDM26NOV{int(strike)}{side}",
                }
            )
    lake.write_parquet(
        _bars(rows, OPT_SCHEMA, extra), lake.bars_1m_path(tmp_path, "option", "GOLDM", DAY)
    )
    f_rows = [(m, 140000.0) for m in range(9 * 60, 23 * 60 + 30)]
    lake.write_parquet(
        _bars(f_rows, BAR_SCHEMA, [{"instrument_id": 1, "vendor_symbol": FUT}] * len(f_rows)),
        lake.bars_1m_path(tmp_path, "future", "GOLDM", DAY),
    )
    path = mcx_calendar_path(tmp_path, "GOLDM")
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"options": {"2026-11-27": FUT}, "futures": {FUT: "2026-12-04"}}))
    return tmp_path


class NoClient:
    def minute_candles(self, symbol, day):  # the day's future bars are already in the lake
        raise AssertionError("no request expected")


def test_scoring_a_session_journals_it_once_and_the_chain_verifies(root):
    assert mf.sessions_to_score(root, DAY) == [(DAY, EXPIRY)]
    entry = mf.score_session(
        root, NoClient(), DAY, EXPIRY, now=datetime(2026, 11, 25, 1, 40, tzinfo=IST)
    )
    assert entry["day"] == "2026-11-24" and entry["expiry"] == "2026-11-27"
    assert entry["k"] == 3 and entry["season"] == "summer" and entry["rule"] == mf.CELL_ID
    assert entry["grid_sha"] == mf.GRID_SHA and entry["recorded_at"].endswith("+05:30")
    # ITM1 off a 140,000 future with a 500 step: CE 139,500, PE 140,500, 1 lot = 10 a point
    assert [(t["contract"], t["side"], t["in"], t["qty"]) for t in entry["trades"]] == [
        ("139500CE", "sell", "18:00", 10),
        ("140500PE", "sell", "18:00", 10),
    ]
    assert entry["trades"][0]["in_price"] == 990.0  # 1% adverse slippage on a sold fill
    assert entry["trades"][0]["out"] == "23:15" and entry["net"] == round(
        entry["gross"] - entry["charges"], 2
    )
    assert entry["net_0pct"] > entry["net_0.5pct"] > entry["net"]
    assert journal.verify(mf.journal_path(root)) == []
    assert mf.sessions_to_score(root, DAY) == []
    with pytest.raises(journal.AlreadyRecorded):
        mf.score_session(root, NoClient(), DAY, EXPIRY)
    totals = mf.summary(root)
    assert totals["sessions"] == 1 and totals["expiries"] == 1 and not totals["pass_rule_met"]
    line = mf.telegram_line(entry, totals)
    assert "Gold Dir paper, Tue 24 Nov (expiry −3)" in line and "139500CE" in line


def test_a_missing_future_day_is_fetched_once_and_replaces_only_its_own_rows(root):
    path = lake.bars_1m_path(root, "future", "GOLDM", DAY)
    path.unlink()

    class Candle:
        def __init__(self, minute):
            self.epoch = int(
                datetime(2026, 11, 24, minute // 60, minute % 60, tzinfo=IST).timestamp()
            )
            self.open = self.high = self.low = self.close = 140000.0
            self.volume, self.oi = 1.0, 5.0

    class Client:
        calls = 0

        def minute_candles(self, symbol, day):
            Client.calls += 1
            return [Candle(m) for m in range(9 * 60, 23 * 60 + 30)]

    assert mf.ensure_future_day(root, Client(), DAY, EXPIRY) == FUT
    assert mf.ensure_future_day(root, Client(), DAY, EXPIRY) == FUT  # now in the lake
    assert Client.calls == 1
    assert mf.season_of(root, FUT, DAY) == "summer"
    entry = mf.score_session(root, NoClient(), DAY, EXPIRY)
    assert len(entry["trades"]) == 2


def test_spread_snapshot_records_bid_ask_for_the_entry_pair(root, monkeypatch):
    contracts = [
        Contract(f"MCX:GOLDM26NOV{k}{s}", "GOLDM", EXPIRY, float(k), s, 0)
        for k in (139500, 140000, 140500)
        for s in ("CE", "PE")
    ]
    monkeypatch.setattr(mf, "parse_master", lambda text, names: contracts)

    def quotes(client, symbols):
        out = {FUT: {"lp": 140100.0}}
        for s in symbols[1:]:
            out[s] = {"bid": 990.0, "ask": 1010.0, "lp": 1000.0}
        return out

    monkeypatch.setattr(mf, "_quotes", quotes)
    out = mf.spread_snapshot(root, object(), DAY, master_text="x")
    assert out["atm"] == 140000.0 and out["expiry"] == "2026-11-27"
    ce = out["contracts"]["ITM1_CE"]
    assert ce["symbol"] == "MCX:GOLDM26NOV139500CE" and ce["spread_pct_of_mid"] == 2.0
    assert out["contracts"]["ITM1_PE"]["symbol"] == "MCX:GOLDM26NOV140500PE"
    assert (mf.forward_dir(root) / "spread" / "2026-11-24.json").exists()
    assert mf.spread_snapshot(root, object(), date(2026, 11, 18), master_text="x") is None


def test_an_expected_session_without_bars_is_named_for_the_alert(root):
    assert mf.expected_without_data(root, DAY) is None  # it has its bars
    assert mf.expected_without_data(root, date(2026, 11, 25)) == date(2026, 11, 25)
    assert mf.expected_without_data(root, date(2026, 11, 28)) is None  # a Saturday
    assert mf.expected_without_data(root, date(2026, 11, 18)) is None  # not in a window


def test_a_day_whose_bars_stop_before_the_close_is_not_journaled(root):
    path = lake.bars_1m_path(root, "option", "GOLDM", DAY)
    t = pq.read_table(path)
    ts = t.column("ts").cast(pa.timestamp("s", tz="UTC")).cast(pa.int64()).to_pylist()
    cut = int(datetime(2026, 11, 24, 21, 10, tzinfo=IST).timestamp())
    keep = pa.array([x <= cut for x in ts])  # the collector died at 21:10
    lake.write_parquet(t.filter(keep).cast(OPT_SCHEMA), path)
    with pytest.raises(mf.NotComplete, match="options bars stop at 21:10"):
        mf.score_session(root, NoClient(), DAY, EXPIRY)
    assert journal.read(mf.journal_path(root)) == []
    assert mf.sessions_to_score(root, DAY) == [(DAY, EXPIRY)]  # still pending for a later night


def test_a_telegram_line_names_an_open_leg_instead_of_none(root):
    entry = mf.score_session(root, NoClient(), DAY, EXPIRY)
    entry["trades"][0]["out_price"], entry["trades"][0]["reason"] = None, ""
    assert "990.0→open open" in mf.telegram_line(entry, mf.summary(root))


def test_the_spread_strikes_use_the_engines_half_up_rounding(root, monkeypatch):
    contracts = [
        Contract(f"MCX:GOLDM26NOV{k}{s}", "GOLDM", EXPIRY, float(k), s, 0)
        for k in (139500, 140000, 140500)
        for s in ("CE", "PE")
    ]
    monkeypatch.setattr(mf, "parse_master", lambda text, names: contracts)
    seen = []

    def quotes(client, symbols):
        seen.append(symbols)
        return {FUT: {"lp": 140250.0}, **{s: {"bid": 1.0, "ask": 1.0} for s in symbols[1:]}}

    monkeypatch.setattr(mf, "_quotes", quotes)
    out = mf.spread_snapshot(root, object(), DAY, master_text="x")
    # 140,250 / 500 = 280.5: half-up gives ATM 140,500 (Python's round() would give 140,000)
    assert out["atm"] == 140500.0
    assert out["contracts"]["ITM1_CE"]["symbol"] == "MCX:GOLDM26NOV140000CE"
    assert out["contracts"]["ITM1_PE"]["symbol"] is None  # 141,000 is not in this small master


def _cli(monkeypatch, root, **patches):
    from typer.testing import CliRunner

    from option_backtesting import cli

    monkeypatch.setattr("option_backtesting.fyers.daily.data_dir", lambda: root)
    monkeypatch.setattr(cli, "_mcx_client", lambda: object())
    monkeypatch.setattr(cli, "_forward_session", lambda value: DAY)
    for name, value in patches.items():
        monkeypatch.setattr(mf, name, value)
    return CliRunner().invoke(cli.app, ["mcx-forward", "score", "--no-telegram"])


def test_score_survives_a_calendar_download_failure(root, monkeypatch):
    def boom(*a, **k):
        raise OSError("network down")

    result = _cli(monkeypatch, root, extend_calendar=boom, score_session=lambda *a, **k: _stub())
    assert "calendar not extended (network down)" in result.output
    assert result.exit_code == 0 and "Gold Dir paper" in result.output


def _stub():
    return {
        "day": "2026-11-24", "k": 3, "net": 5.0, "gross": 9.0, "charges": 4.0, "trades": [],
    }  # fmt: skip


def test_one_bad_session_does_not_stop_the_others_and_exits_1(root, monkeypatch):
    sessions = [(date(2026, 11, 23), EXPIRY), (DAY, EXPIRY)]
    calls = []

    def score(root_dir, client, day, expiry, **kw):
        calls.append(day)
        if day == date(2026, 11, 23):
            raise FileNotFoundError("no future bars for 2026-11-23")
        return _stub()

    result = _cli(
        monkeypatch,
        root,
        extend_calendar=lambda *a, **k: {"expiries": [], "added": []},
        sessions_to_score=lambda *a, **k: sessions,
        score_session=score,
    )
    assert calls == [date(2026, 11, 23), DAY]  # the second was still scored
    assert "FileNotFoundError: no future bars" in result.output and result.exit_code == 1


def test_a_missing_credentials_error_exits_2(root, monkeypatch):
    from option_backtesting.fyers.auth import FyersCredentialsError

    def refused():
        raise FyersCredentialsError("no token")

    from option_backtesting import cli

    result = _cli(monkeypatch, root)
    monkeypatch.setattr(cli, "_mcx_client", refused)
    from typer.testing import CliRunner

    result = CliRunner().invoke(cli.app, ["mcx-forward", "score", "--no-telegram"])
    assert result.exit_code == 2 and "no token" in result.output


def test_the_no_data_alert_is_said_once(root, monkeypatch):
    sent = []
    monkeypatch.setattr("option_backtesting.notify.send", lambda n, **k: sent.append(n))
    from typer.testing import CliRunner

    from option_backtesting import cli

    monkeypatch.setattr("option_backtesting.fyers.daily.data_dir", lambda: root)
    monkeypatch.setattr(cli, "_mcx_client", lambda: object())
    monkeypatch.setattr(cli, "_forward_session", lambda value: date(2026, 11, 25))
    monkeypatch.setattr(mf, "extend_calendar", lambda *a, **k: {"expiries": [], "added": []})
    mf.score_session(root, NoClient(), DAY, EXPIRY)  # the 24th is done: only the 25th is open
    for _ in range(2):
        CliRunner().invoke(cli.app, ["mcx-forward", "score"])
    assert [n.severity for n in sent] == ["warn"]  # the second night stays quiet
    assert (mf.forward_dir(root) / "alerted" / "2026-11-25").exists()
