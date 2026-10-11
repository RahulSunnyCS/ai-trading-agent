"""Angel One as Momentum's backup price source (BL-079 Phase 4). Every call is faked: nothing
here logs in, downloads the scrip master or touches the network (conftest blocks the real
transport for the whole suite)."""

import json
from datetime import date, datetime

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import angelone, fetch, fyers, weekly
from momentum_backtesting.angelone import (
    AngelAuthError,
    AngelCredentials,
    AngelError,
    AngelSource,
    AngelUnmapped,
    Session,
    SymbolMap,
)
from momentum_backtesting.fetch import Instrument
from momentum_backtesting.notify import IST


def _m(token, symbol, name, seg="NSE", kind=""):
    return {"token": token, "symbol": symbol, "name": name, "exch_seg": seg, "instrumenttype": kind}


MASTER = [
    _m("99926000", "Nifty 50", "NIFTY", "NSE", "AMXIDX"),
    _m("99926009", "Nifty Bank", "BANKNIFTY", "NSE", "AMXIDX"),
    _m("99926008", "Nifty IT", "NIFTY IT", "NSE", "AMXIDX"),
    _m("99926013", "Nifty Next 50", "NIFTYNXT50", "NSE", "AMXIDX"),
    _m("99926060", "NIFTY MIDCAP 150", "NIFTY MIDCAP 150", "NSE", "AMXIDX"),
    _m("99919000", "SENSEX", "SENSEX", "BSE", "AMXIDX"),
    _m("10576", "NIFTYBEES-EQ", "NIFTYBEES", "NSE", ""),
    _m("11439", "BANKBEES-EQ", "BANKBEES", "NSE", ""),
    _m("3045", "SBIN-EQ", "SBIN", "NSE", ""),
    _m("2031", "M&M-EQ", "M&M", "NSE", ""),
    # a derivative and a BSE equity: not Momentum's, never mapped
    _m("55555", "NIFTY27OCT2625000CE", "NIFTY", "NFO", "OPTIDX"),
    _m("500112", "SBIN", "SBIN", "BSE", ""),
]

CREDS = AngelCredentials("A1234567", "api-key-xyz", "4321", "JBSWY3DPEHPK3PXP")


def _row(day: str, close: float, open_: float | None = None) -> list:
    return [
        f"{day}T00:00:00+05:30",
        open_ if open_ is not None else close - 1,
        close + 1,
        close - 2,
        close,
        1000,
    ]


class FakeAngel:
    """Stands in for the SmartAPI: candles per token, an LTP per token, a call log."""

    def __init__(self, candles=None, ltps=None, fail_with=None):
        self.candles = candles or {}
        self.ltps = ltps or {}
        self.fail_with = fail_with  # a payload returned for every data call
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, path, body, headers):
        self.calls.append((path, body))
        assert headers["Authorization"].startswith("Bearer "), "data calls carry the session"
        assert headers["X-PrivateKey"]
        if self.fail_with is not None:
            return 200, self.fail_with
        if path == angelone.CANDLE_PATH:
            lo, hi = body["fromdate"][:10], body["todate"][:10]
            rows = [r for r in self.candles.get(body["symboltoken"], []) if lo <= r[0][:10] <= hi]
            return 200, {"status": True, "message": "SUCCESS", "data": rows}
        if path == angelone.QUOTE_PATH:
            ((exchange, tokens),) = body["exchangeTokens"].items()
            fetched = [
                {"exchange": exchange, "tradingSymbol": "X", "symbolToken": t, "ltp": self.ltps[t]}
                for t in tokens
                if t in self.ltps
            ]
            return 200, {"status": True, "data": {"fetched": fetched, "unfetched": []}}
        raise AssertionError(path)

    def candle_calls(self):
        return [b for p, b in self.calls if p == angelone.CANDLE_PATH]


def _source(fake=None, **kwargs) -> AngelSource:
    return AngelSource(
        Session("jwt-secret", "api-key-xyz"),
        post=fake,
        pause_s=0,
        master_loader=lambda: MASTER,
        **kwargs,
    )


# --- login ---------------------------------------------------------------------------------------


def test_totp_matches_the_rfc_6238_vector():
    # RFC 6238 appendix B, SHA-1, T=59 s: 94287082 -> the 6-digit code is its last six digits.
    assert angelone.totp_now("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", at=59) == "287082"


def test_login_sends_the_pin_as_the_password_and_returns_a_session():
    seen = {}

    def post(path, body, headers):
        seen.update(path=path, body=body, headers=headers)
        return 200, {"status": True, "data": {"jwtToken": "jwt-1"}}

    session = angelone.login(CREDS, post, now=lambda: 1000.0 * 30 + 5)
    assert session.jwt == "jwt-1"
    assert seen["path"] == angelone.LOGIN_PATH
    assert seen["body"]["clientcode"] == "A1234567" and seen["body"]["password"] == "4321"
    assert len(seen["body"]["totp"]) == 6
    assert seen["headers"]["X-PrivateKey"] == "api-key-xyz"
    assert "Authorization" not in seen["headers"]


def test_a_rejected_login_raises_without_leaking_a_secret_and_is_not_retried():
    calls = []

    def post(path, body, headers):
        calls.append(path)
        return 200, {
            "status": False,
            "message": "Invalid pin 4321 for api-key-xyz",
            "errorcode": "AB1050",
        }

    with pytest.raises(AngelError) as caught:
        angelone.login(CREDS, post, now=lambda: 1000.0 * 30 + 5)
    assert "4321" not in str(caught.value) and "api-key-xyz" not in str(caught.value)
    assert len(calls) == 1


def test_load_credentials_needs_all_four_values():
    env = {
        "ANGELONE_API_KEY": "k",
        "ANGELONE_CLIENT_CODE": "c",
        "ANGELONE_MPIN": "1234",
        "ANGELONE_TOTP_SECRET": "JBSWY3DP",
    }
    assert angelone.load_credentials(env).client_code == "c"
    assert angelone.load_credentials({**env, "ANGELONE_MPIN": " "}) is None
    assert angelone.load_credentials({}) is None
    assert "1234" not in repr(angelone.load_credentials(env))


# --- symbols -------------------------------------------------------------------------------------


def test_fyers_tickers_map_to_angel_instruments():
    mapping = SymbolMap(angelone.compact_master(MASTER))
    nifty = mapping.lookup("NSE:NIFTY50-INDEX")
    assert (nifty.exchange, nifty.token, nifty.kind) == ("NSE", "99926000", "index")
    assert mapping.lookup("NSE:NIFTYBANK-INDEX").token == "99926009"
    assert mapping.lookup("NSE:NIFTYIT-INDEX").token == "99926008"
    # the master's name column carries "NIFTYNXT50"; its symbol column "Nifty Next 50"
    assert mapping.lookup("NSE:NIFTYNXT50-INDEX").token == "99926013"
    assert mapping.lookup("NSE:NIFTYMIDCAP150-INDEX").token == "99926060"
    assert mapping.lookup("BSE:SENSEX-INDEX").exchange == "BSE"
    assert mapping.lookup("NSE:NIFTYBEES-EQ").token == "10576"
    assert mapping.lookup("NSE:M&M-EQ").token == "2031"


def test_what_angel_one_does_not_list_is_unmapped():
    mapping = SymbolMap(angelone.compact_master(MASTER))
    for symbol in (
        "NSE:NIFTYCAPITALMKT-INDEX",  # not in Angel One's master
        "NSE:NIFTYINDDEFENCE-INDEX",
        "NSE:NOSUCH-EQ",
        "BSE:SBIN-A",  # BSE equities are not mapped
        "MCX:GOLD-FUT",
        "NIFTY50-INDEX",  # no exchange prefix
    ):
        assert mapping.lookup(symbol) is None, symbol


def test_a_name_two_indices_share_is_dropped_not_guessed():
    rows = [
        _m("1", "Nifty X", "NIFTYX", "NSE", "AMXIDX"),
        _m("2", "NIFTY-X", "OTHER", "NSE", "AMXIDX"),
    ]
    assert SymbolMap(rows).lookup("NSE:NIFTYX-INDEX") is None


def test_the_master_is_compacted_and_cached_for_a_day(tmp_path):
    path = tmp_path / "master.json"
    downloads = []

    def fetch_master():
        downloads.append(1)
        return MASTER

    first = angelone.load_master(path, fetch_master)
    assert len(downloads) == 1
    assert all(r["exch_seg"] in ("NSE", "BSE") for r in first)
    assert not any(r["symbol"].startswith("NIFTY27OCT") for r in first)
    assert angelone.load_master(path, fetch_master) == first and len(downloads) == 1  # cached
    stale = angelone.load_master(path, fetch_master, max_age_s=-1)  # too old: downloaded again
    assert len(downloads) == 2 and stale == first


# --- candles and quotes --------------------------------------------------------------------------


def test_daily_candles_come_back_in_the_fyers_shape():
    fake = FakeAngel(
        {
            "99926000": [
                _row("2026-10-07", 25000, 24900),
                _row("2026-10-08", 25100),
                _row("2026-10-09", 25200),
            ]
        }
    )
    frame = _source(fake).daily_candles("NSE:NIFTY50-INDEX", date(2026, 10, 1), date(2026, 10, 9))
    assert list(frame.columns) == ["open", "close"]
    assert isinstance(frame.index, pd.DatetimeIndex)
    assert list(frame.index) == [
        pd.Timestamp("2026-10-07"),
        pd.Timestamp("2026-10-08"),
        pd.Timestamp("2026-10-09"),
    ]
    assert frame["close"].tolist() == [25000.0, 25100.0, 25200.0]
    assert frame.loc["2026-10-07", "open"] == 24900.0
    call = fake.candle_calls()[0]
    assert call == {
        "exchange": "NSE",
        "symboltoken": "99926000",
        "interval": "ONE_DAY",
        "fromdate": "2026-10-01 00:00",
        "todate": "2026-10-09 15:30",
    }


def test_a_long_history_is_fetched_in_chunks():
    rows = [_row(f"{d:%Y-%m-%d}", 100.0) for d in pd.bdate_range("2016-01-01", "2026-10-09")]
    fake = FakeAngel({"99926000": rows})
    frame = _source(fake).daily_candles("NSE:NIFTY50-INDEX", date(2016, 1, 1), date(2026, 10, 9))
    assert len(fake.candle_calls()) == 4  # 3,935 days at 1,000 a call
    assert len(frame) == len(rows) and frame.index.is_monotonic_increasing


def test_ohlcv_keeps_the_whole_bar():
    fake = FakeAngel({"3045": [_row("2026-10-09", 800.0, 790.0)]})
    frame = _source(fake).daily_ohlcv("NSE:SBIN-EQ", date(2026, 10, 9), date(2026, 10, 9))
    assert list(frame.columns) == ["open", "high", "low", "close", "volume"]
    assert frame.iloc[0].tolist() == [790.0, 801.0, 798.0, 800.0, 1000.0]


def test_an_empty_answer_is_an_empty_frame():
    frame = _source(FakeAngel({})).daily_candles(
        "NSE:NIFTY50-INDEX", date(2026, 10, 3), date(2026, 10, 4)
    )
    assert frame.empty and list(frame.columns) == ["open", "close"]


def test_an_unmapped_symbol_raises_unmapped_without_a_request():
    fake = FakeAngel()
    source = _source(fake)
    with pytest.raises(AngelUnmapped):
        source.daily_candles("NSE:NIFTYCAPITALMKT-INDEX", date(2026, 10, 1), date(2026, 10, 9))
    assert fake.calls == []
    assert source.can_serve("NSE:NIFTYBEES-EQ") and not source.can_serve(
        "NSE:NIFTYCAPITALMKT-INDEX"
    )


def test_the_10am_price_is_the_close_of_the_0945_candle():
    rows = [
        ["2026-10-08T09:45:00+05:30", 1, 2, 0, 111.0, 5],
        ["2026-10-08T10:00:00+05:30", 1, 2, 0, 999.0, 5],
        ["2026-10-09T09:45:00+05:30", 1, 2, 0, 222.0, 5],
        ["2026-10-09T09:30:00+05:30", 1, 2, 0, 333.0, 5],
    ]
    fake = FakeAngel({"10576": rows})
    series = _source(fake).price_at("NSE:NIFTYBEES-EQ", date(2026, 10, 8), date(2026, 10, 9))
    assert series.tolist() == [111.0, 222.0]
    assert fake.candle_calls()[0]["interval"] == "FIFTEEN_MINUTE"


def test_quotes_map_back_to_fyers_symbols_and_skip_what_is_unmapped():
    fake = FakeAngel(ltps={"99926000": 25123.4, "10576": 281.5})
    prices = _source(fake).quotes(
        ["NSE:NIFTY50-INDEX", "NSE:NIFTYBEES-EQ", "NSE:NIFTYCAPITALMKT-INDEX", "NSE:SBIN-EQ"]
    )
    assert prices == {"NSE:NIFTY50-INDEX": 25123.4, "NSE:NIFTYBEES-EQ": 281.5}
    ((path, body),) = fake.calls
    assert path == angelone.QUOTE_PATH and body["mode"] == "LTP"
    assert sorted(body["exchangeTokens"]["NSE"]) == ["10576", "3045", "99926000"]


def test_quotes_are_sent_fifty_tokens_at_a_time():
    rows = [_m(str(1000 + i), f"S{i}-EQ", f"S{i}") for i in range(120)]
    fake = FakeAngel(ltps={str(1000 + i): 10.0 + i for i in range(120)})
    source = AngelSource(Session("j", "k"), post=fake, pause_s=0, master_loader=lambda: rows)
    prices = source.quotes([f"NSE:S{i}-EQ" for i in range(120)])
    assert len(prices) == 120
    assert [len(b["exchangeTokens"]["NSE"]) for _, b in fake.calls] == [50, 50, 20]


def test_a_rate_limit_answer_is_backed_off_and_retried():
    answers = iter(
        [
            (200, {"status": False, "message": "Access denied because of exceeding access rate"}),
            (200, {"status": True, "data": [_row("2026-10-09", 25200)]}),
        ]
    )
    source = _source(lambda path, body, headers: next(answers), sleep=lambda s: None)
    frame = source.daily_candles("NSE:NIFTY50-INDEX", date(2026, 10, 9), date(2026, 10, 9))
    assert frame["close"].tolist() == [25200.0]


def test_a_rejected_session_stops_the_source_and_is_not_a_fyers_credentials_error():
    source = _source(
        FakeAngel(fail_with={"status": False, "message": "Invalid Token", "errorcode": "AG8001"})
    )
    with pytest.raises(AngelAuthError) as caught:
        source.daily_candles("NSE:NIFTY50-INDEX", date(2026, 10, 9), date(2026, 10, 9))
    assert not isinstance(caught.value, fyers.FyersCredentialsError)
    assert source.dead and not source.can_serve("NSE:NIFTY50-INDEX")


def test_another_refusal_is_a_plain_error_and_leaves_the_source_alive():
    source = _source(
        FakeAngel(fail_with={"status": False, "message": "No data", "errorcode": "AB1004"})
    )
    with pytest.raises(AngelError):
        source.daily_candles("NSE:NIFTY50-INDEX", date(2026, 10, 9), date(2026, 10, 9))
    assert not source.dead


# --- the Fyers hook ------------------------------------------------------------------------------


def test_the_fyers_functions_hand_a_substitute_source_the_call():
    fake = FakeAngel({"99926000": [_row("2026-10-09", 25200)]}, ltps={"99926000": 25300.0})
    source = _source(fake)
    start = end = date(2026, 10, 9)
    assert fyers.daily_candles("NSE:NIFTY50-INDEX", start, end, source)["close"].iloc[0] == 25200.0
    assert fyers.daily_closes("NSE:NIFTY50-INDEX", start, end, source).iloc[0] == 25200.0
    assert fyers.quotes(["NSE:NIFTY50-INDEX"], source) == {"NSE:NIFTY50-INDEX": 25300.0}
    assert fyers.serves(source, "NSE:NIFTY50-INDEX")
    assert not fyers.serves(source, "NSE:NIFTYCAPITALMKT-INDEX")
    assert fyers.price_label(source) == "Angel One"


def test_fyers_credentials_and_none_behave_as_before():
    creds = fyers.Credentials("app", "tok", "env")
    assert fyers.substitute(creds) is None and fyers.substitute(None) is None
    assert fyers.substitute("CREDS") is None  # tests pass strings; only the real flag counts
    assert fyers.serves(creds, "NSE:ANYTHING-EQ") is True
    assert fyers.serves(None, "NSE:ANYTHING-EQ") is False
    assert fyers.price_label(creds) == "Fyers" and fyers.price_label(None) == "Fyers"


# --- choosing the source -------------------------------------------------------------------------

ENV = {
    "ANGELONE_API_KEY": "api-key-xyz",
    "ANGELONE_CLIENT_CODE": "A1234567",
    "ANGELONE_MPIN": "4321",
    "ANGELONE_TOTP_SECRET": "JBSWY3DPEHPK3PXP",
}


@pytest.fixture
def angel_env(monkeypatch):
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)


def _login_counter(monkeypatch, ok=True):
    logins = []

    def post(path, body, headers):
        logins.append(path)
        if ok:
            return 200, {"status": True, "data": {"jwtToken": "jwt-1"}}
        return 200, {"status": False, "message": "wrong pin", "errorcode": "AB1050"}

    monkeypatch.setattr(angelone, "_http_post", post)
    monkeypatch.setattr(angelone, "download_master", lambda: MASTER)
    return logins


def _no_fyers_token(monkeypatch):
    def raise_missing(**_kwargs):
        raise fyers.FyersCredentialsError("No Fyers token: log in")

    monkeypatch.setattr(fyers, "resolve_credentials", raise_missing)


def test_a_valid_fyers_token_wins_and_angel_one_is_never_logged_into(monkeypatch, angel_env):
    logins = _login_counter(monkeypatch)
    creds = fyers.Credentials("app", "tok", "broker_tokens")
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_: creds)
    assert angelone.resolve_prices() is creds
    assert logins == []


def test_no_fyers_token_falls_through_to_angel_one_with_one_login(monkeypatch, angel_env):
    logins = _login_counter(monkeypatch)
    _no_fyers_token(monkeypatch)
    first = angelone.resolve_prices()
    second = angelone.resolve_prices(prefer_dashboard=True)
    assert isinstance(first, AngelSource) and second is first
    assert logins == [angelone.LOGIN_PATH]  # one login for the process
    assert first.why_not_fyers == "no valid token"


def test_a_token_fyers_refuses_also_falls_through(monkeypatch, angel_env):
    logins = _login_counter(monkeypatch)
    creds = fyers.Credentials("app", "stale", "env")
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_: creds)
    monkeypatch.setattr(angelone, "_fyers_token_rejected", lambda c: True)
    source = angelone.resolve_prices()
    assert isinstance(source, AngelSource) and source.why_not_fyers == "token rejected"
    assert len(logins) == 1


def test_a_refused_fyers_token_with_no_angel_one_keeps_the_fyers_credentials(monkeypatch):
    creds = fyers.Credentials("app", "stale", "env")
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_: creds)
    monkeypatch.setattr(angelone, "_fyers_token_rejected", lambda c: True)
    assert angelone.resolve_prices() is creds  # no worse than before this source existed


def test_neither_source_raises_the_original_fyers_error(monkeypatch):
    # Angel One is not configured (no ANGELONE_* in the environment)
    for key in ENV:
        monkeypatch.delenv(key, raising=False)
    _no_fyers_token(monkeypatch)
    with pytest.raises(fyers.FyersCredentialsError, match="No Fyers token: log in"):
        angelone.resolve_prices()


def test_a_rejected_login_is_attempted_once_and_then_left_alone(monkeypatch, angel_env):
    logins = _login_counter(monkeypatch, ok=False)
    _no_fyers_token(monkeypatch)
    for _ in range(3):
        with pytest.raises(fyers.FyersCredentialsError):
            angelone.resolve_prices()
    assert len(logins) == 1  # a wrong PIN counts toward a lockout: never hammered


def test_a_session_rejected_mid_run_is_replaced_by_a_new_login_next_time(monkeypatch, angel_env):
    logins = _login_counter(monkeypatch)
    _no_fyers_token(monkeypatch)
    source = angelone.resolve_prices()
    with pytest.raises(AngelAuthError):
        source._check({"status": False, "message": "Token expired", "errorcode": "AG8002"}, "t")
    assert source.dead
    angelone._next_login_at = 0.0  # the one-minute guard between two logins
    again = angelone.resolve_prices()
    assert again is not source and len(logins) == 2


# --- the weekly refresh and live prices ----------------------------------------------------------


def _instrument(name, source, etf_source, trade_etf, backfill="", amfi=""):
    return Instrument(
        "core", "Sector", name, trade_etf, "equity", source, backfill, "", etf_source, amfi, None
    )


UNIVERSE = [
    _instrument("Nifty 50", "NSE:NIFTY50-INDEX", "NSE:NIFTYBEES-EQ", "NIFTYBEES"),
    _instrument("Nifty Bank", "NSE:NIFTYBANK-INDEX", "NSE:BANKBEES-EQ", "BANKBEES"),
    _instrument(
        "Nifty India Defence",
        "NSE:NIFTYINDDEFENCE-INDEX",
        "NSE:MODEFENCE-EQ",
        "MODEFENCE",
        backfill="NIFTYINDICES:NIFTY INDIA DEFENCE",
    ),
    _instrument(
        "Nifty Capital Markets", "NSE:NIFTYCAPITALMKT-INDEX", "NSE:MOCAPITAL-EQ", "MOCAPITAL"
    ),
]

TODAY = date(2026, 10, 9)
DAYS = pd.bdate_range("2026-09-01", "2026-10-09")


def _prices(level: float) -> pd.DataFrame:
    close = level * (1 + 0.001 * np.arange(len(DAYS)))
    return pd.DataFrame({"open": close * 0.999, "close": close}, index=DAYS)


@pytest.fixture
def refresh_world(tmp_path, monkeypatch):
    """A data folder with history to Thursday, an Angel One that serves Nifty 50 / Nifty Bank
    and their ETFs, and fake public sources for everything else."""
    out = tmp_path / "data"
    (out / "daily").mkdir(parents=True)
    (out / "daily_etf").mkdir()
    for inst in UNIVERSE:
        old = _prices(100.0)
        old = old[old.index < "2026-10-09"]
        old.to_csv(out / "daily" / f"{inst.name}.csv", index_label="date")
        (old[["close"]] * 0.1).assign(open=lambda f: f["close"]).to_csv(
            out / "daily_etf" / f"{inst.name}.csv", index_label="date"
        )

    def rows(frame):
        return [
            _row(f"{d:%Y-%m-%d}", float(c), float(o))
            for d, o, c in zip(frame.index, frame["open"], frame["close"], strict=True)
        ]

    fake = FakeAngel(
        candles={
            "99926000": rows(_prices(100.0)),
            "99926009": rows(_prices(200.0)),
            "10576": rows(_prices(10.0)),
            "11439": rows(_prices(20.0)),
        },
        ltps={"99926000": 25555.0, "99926009": 55555.0, "10576": 255.0, "11439": 555.0},
    )
    seen = {"public": []}

    def yahoo_candles(symbol, start):
        seen["public"].append(("yahoo", symbol))
        base = {"MODEFENCE.NS": 10.0, "MOCAPITAL.NS": 10.0}.get(symbol, 10.0)
        return _prices(base)[["open", "close"]]

    def niftyindices_candles(name, start, end):
        seen["public"].append(("niftyindices", name))
        return _prices(100.0)[["close"]]

    monkeypatch.setattr(weekly, "yahoo_candles", yahoo_candles)
    monkeypatch.setattr(weekly, "niftyindices_candles", niftyindices_candles)
    monkeypatch.setattr(weekly, "amfi_nav", lambda *a, **k: pytest.fail("no NAV in this universe"))
    return out, fake, seen


def test_the_refresh_prices_what_angel_one_maps_and_the_rest_from_public_sources(refresh_world):
    out, fake, seen = refresh_world
    source = _source(fake, why_not_fyers="no valid token")
    health = weekly.refresh(out, TODAY, source, log=lambda m: None, universe=UNIVERSE, until=TODAY)

    assert health.backup == "Angel One" and health.fyers == "no valid token"
    assert health.sources["Nifty 50"] == "angel one"
    assert health.sources["Nifty Bank"] == "angel one"
    # Angel One does not list these two: the public ladder, exactly as with no broker token
    assert health.sources["Nifty India Defence"] == "niftyindices"
    assert ("niftyindices", "NIFTY INDIA DEFENCE") in seen["public"]
    assert health.sources["Nifty Capital Markets"] == "ETF-implied"
    assert ("yahoo", "MOCAPITAL.NS") in seen["public"] and ("yahoo", "NIFTYBEES.NS") not in seen[
        "public"
    ]
    stored = pd.read_csv(out / "daily" / "Nifty 50.csv", index_col=0, parse_dates=True)
    assert stored.index[-1] == pd.Timestamp(TODAY)
    assert stored["close"].iloc[-1] == pytest.approx(_prices(100.0)["close"].iloc[-1])
    assert not health.failures


def test_the_health_line_says_which_source_supplied_the_closes(refresh_world):
    out, fake, _ = refresh_world
    health = weekly.refresh(
        out, TODAY, _source(fake), log=lambda m: None, universe=UNIVERSE, until=TODAY
    )
    line = weekly._health_line(health, None)
    assert line.startswith("Data · Fyers: no valid token · prices from Angel One (")
    assert "angel one 2" in line and "niftyindices 1" in line and "ETF-implied 1" in line


def test_a_fyers_day_has_the_health_line_it_always_had():
    health = weekly.Health(TODAY, fyers="token from broker_tokens")
    assert weekly._health_line(health, None) == "Data · Fyers: token from broker_tokens"


def test_an_angel_one_failure_on_one_series_falls_back_to_the_public_source(refresh_world):
    out, fake, seen = refresh_world
    # Nifty Bank's data call fails (not a login problem); Defence has a niftyindices name
    source = _source(fake)
    original = source._candles

    def flaky(symbol, *args, **kwargs):
        if symbol == "NSE:NIFTYBANK-INDEX":
            raise AngelError("boom")
        return original(symbol, *args, **kwargs)

    source._candles = flaky
    health = weekly.refresh(out, TODAY, source, log=lambda m: None, universe=UNIVERSE, until=TODAY)
    assert health.sources["Nifty 50"] == "angel one"
    # no backfill name and not an ETF-style source: ETF-implied, as with no broker token
    assert health.sources["Nifty Bank"] == "ETF-implied"
    assert "Nifty Bank" not in health.failures


def test_live_prices_come_from_angel_one_quotes_and_say_so(refresh_world):
    out, fake, _ = refresh_world
    now = datetime(2026, 10, 9, 14, 40, tzinfo=IST)
    index_now, etf_now, how = weekly.live_prices(UNIVERSE, out, _source(fake), now)
    assert index_now["Nifty 50"] == 25555.0 and how["Nifty 50"] == "angel one live"
    assert etf_now["Nifty 50"] == 255.0
    assert index_now["Nifty Bank"] == 55555.0
    # Capital Markets has no Angel One quote and no Yahoo ETF quote here: the last close
    assert how["Nifty Capital Markets"] in ("ETF-implied live", "last close")


def test_a_failing_quote_call_does_not_stop_the_preview(refresh_world, monkeypatch):
    out, fake, _ = refresh_world
    monkeypatch.setattr(
        weekly, "yahoo_quote", lambda s: (_ for _ in ()).throw(RuntimeError("no yahoo either"))
    )
    fake.fail_with = {"status": False, "message": "boom", "errorcode": "AB1004"}
    now = datetime(2026, 10, 9, 14, 40, tzinfo=IST)
    _, _, how = weekly.live_prices(UNIVERSE, out, _source(fake), now)
    assert set(how.values()) == {"last close"}


# --- mbt fetch -----------------------------------------------------------------------------------


def test_fetch_runs_from_angel_one_and_uses_public_sources_for_what_it_cannot_map(
    tmp_path, monkeypatch
):
    rows = lambda level: [  # noqa: E731
        _row(f"{d:%Y-%m-%d}", level + i)
        for i, d in enumerate(pd.bdate_range("2016-01-04", "2026-10-09"))
    ]
    fake = FakeAngel({"99926000": rows(100.0), "10576": rows(10.0)})
    source = _source(fake, why_not_fyers="no valid token")
    universe = [UNIVERSE[0], UNIVERSE[2]]
    monkeypatch.setattr(fetch, "load_universe", lambda: universe)
    monkeypatch.setattr(fetch, "DATA_DIR", tmp_path)
    monkeypatch.setattr(angelone, "resolve_prices", lambda **_: source)
    seen = []

    def niftyindices_candles(name, start, end):
        seen.append(name)
        return _prices(100.0)[["close"]]

    monkeypatch.setattr(fetch, "niftyindices_candles", niftyindices_candles)
    logs: list[str] = []
    table, coverage = fetch.fetch_all(use_fyers=True, log=logs.append, etfs=False)

    assert set(table.columns) == {"Nifty 50", "Nifty India Defence"}
    assert any("prices from Angel One" in line for line in logs)
    assert "NIFTY INDIA DEFENCE" in seen
    assert (tmp_path / "daily" / "Nifty 50.csv").exists()
    nifty = pd.read_csv(tmp_path / "daily" / "Nifty 50.csv", index_col=0, parse_dates=True)
    assert nifty.index[0] == pd.Timestamp("2016-01-04")


def test_no_fyers_still_means_public_only(tmp_path, monkeypatch):
    cash = Instrument("defensive", "Debt", "Cash", "LIQUIDBEES", "debt", "AMFI:120304", "", "")
    monkeypatch.setattr(fetch, "load_universe", lambda: [UNIVERSE[0], cash])
    monkeypatch.setattr(fetch, "DATA_DIR", tmp_path)
    monkeypatch.setattr(
        angelone, "resolve_prices", lambda **_: pytest.fail("--no-fyers must not look for a broker")
    )
    nav = pd.Series(100.0 + np.arange(len(DAYS)), index=DAYS, name="close")
    monkeypatch.setattr(fetch, "amfi_nav", lambda code, start, adjust=True: nav)
    table, _ = fetch.fetch_all(use_fyers=False, log=lambda m: None, etfs=False)
    # an NSE: series has no public source in `mbt fetch`: left out, as before
    assert list(table.columns) == ["Cash"]


def test_the_json_shape_the_compact_master_keeps_is_small():
    rows = angelone.compact_master(MASTER)
    assert {tuple(sorted(r)) for r in rows} == {
        ("exch_seg", "instrumenttype", "name", "symbol", "token")
    }
    json.dumps(rows)
