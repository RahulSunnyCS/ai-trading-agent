"""Angel One provider (BL-079): login, token mapping, candle shaping and a whole day through the
shared collector — against a faked SmartAPI, no network."""

from datetime import date, datetime, timedelta, timezone

import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.angelone import auth
from option_backtesting.angelone.client import CANDLE_PATH, OI_PATH, AngelClient
from option_backtesting.angelone.symbols import build_targets
from option_backtesting.fyers import daily
from option_backtesting.fyers.auth import FyersCredentialsError
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
DAY = date(2026, 10, 9)
EXP = date(2026, 10, 13)
CREDS = auth.AngelCredentials("C123", "apikey-secret", "4321", "JBSWY3DPEHPK3PXP")


def iso(h, m):
    return datetime(2026, 10, 9, h, m, tzinfo=IST).isoformat()


def test_totp_matches_the_rfc6238_vector():
    # RFC 6238 appendix B, SHA-1, T=59 -> 94287082 (8 digits); the last 6 are 287082.
    secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"  # base32 of "12345678901234567890"
    assert auth.totp_now(secret, at=59) == "287082"


def test_login_returns_a_session_and_never_leaks_secrets():
    seen = {}

    def post(path, body, headers):
        seen.update(path=path, body=body, headers=headers)
        return 200, {"status": True, "data": {"jwtToken": "jwt-1"}}

    session = auth.login(CREDS, post=post, now=lambda: 10)
    assert session.jwt == "jwt-1" and seen["path"] == auth.LOGIN_PATH
    assert seen["body"]["clientcode"] == "C123" and seen["body"]["password"] == "4321"
    assert "jwt-1" not in repr(session) and "apikey-secret" not in repr(CREDS)


def test_a_rejected_login_raises_the_shared_credentials_error_with_the_pin_scrubbed():
    def post(path, body, headers):
        return 200, {"status": False, "errorcode": "AB1050", "message": "Invalid totp 4321"}

    with pytest.raises(FyersCredentialsError) as err:
        auth.login(CREDS, post=post, now=lambda: 10)
    assert "AB1050" in str(err.value) and "4321" not in str(err.value)


def test_missing_credentials_name_the_keys_not_the_values():
    with pytest.raises(auth.AngelCredentialsError, match="ANGELONE_MPIN"):
        auth.load_credentials(
            {"ANGELONE_API_KEY": "k", "ANGELONE_CLIENT_CODE": "c", "ANGELONE_TOTP_SECRET": "s"}
        )


MASTER = [
    {
        "token": "99926000",
        "symbol": "Nifty 50",
        "name": "NIFTY",
        "exch_seg": "NSE",
        "instrumenttype": "AMXIDX",
        "expiry": "",
        "strike": "-1.000000",
        "lotsize": "1",
    },
    {
        "token": "99926017",
        "symbol": "India VIX",
        "name": "INDIA VIX",
        "exch_seg": "NSE",
        "instrumenttype": "AMXIDX",
        "expiry": "",
        "strike": "-1.000000",
        "lotsize": "1",
    },
    {
        "token": "99919000",
        "symbol": "SENSEX",
        "name": "SENSEX",
        "exch_seg": "BSE",
        "instrumenttype": "AMXIDX",
        "expiry": "",
        "strike": "-1.000000",
        "lotsize": "1",
    },
    {
        "token": "111",
        "symbol": "NIFTY13OCT2622500CE",
        "name": "NIFTY",
        "exch_seg": "NFO",
        "instrumenttype": "OPTIDX",
        "expiry": "13OCT2026",
        "strike": "2250000.000000",
        "lotsize": "65",
    },
    {
        "token": "112",
        "symbol": "NIFTY13OCT2622500PE",
        "name": "NIFTY",
        "exch_seg": "NFO",
        "instrumenttype": "OPTIDX",
        "expiry": "13OCT2026",
        "strike": "2250000.000000",
        "lotsize": "65",
    },
    {
        "token": "113",
        "symbol": "NIFTY27OCT26FUT",
        "name": "NIFTY",
        "exch_seg": "NFO",
        "instrumenttype": "FUTIDX",
        "expiry": "27OCT2026",
        "strike": "-1.000000",
        "lotsize": "65",
    },
    {
        "token": "221",
        "symbol": "SENSEX15OCT2672400CE",
        "name": "SENSEX",
        "exch_seg": "BFO",
        "instrumenttype": "OPTIDX",
        "expiry": "15OCT2026",
        "strike": "7240000.000000",
        "lotsize": "20",
    },
]
CONTRACTS = [
    Contract("NSE:NIFTY26O1322500CE", "NIFTY", EXP, 22500.0, "CE", 65),
    Contract("NSE:NIFTY26O1322500PE", "NIFTY", EXP, 22500.0, "PE", 65),
    Contract("NSE:NIFTY26OCTFUT", "NIFTY", date(2026, 10, 27), None, "FUT", 65),
    Contract("BSE:SENSEX26O1572400CE", "SENSEX", date(2026, 10, 15), 72400.0, "CE", 20),
    Contract("NSE:NIFTY26O1323000CE", "NIFTY", EXP, 23000.0, "CE", 65),  # not in the master
]
INDEX_SYMBOLS = {
    "NSE:NIFTY50-INDEX": "NIFTY",
    "BSE:SENSEX-INDEX": "SENSEX",
    "NSE:INDIAVIX-INDEX": "INDIAVIX",
}


def test_targets_match_by_underlying_expiry_strike_and_side():
    t = build_targets(MASTER, CONTRACTS, INDEX_SYMBOLS)
    assert t["NSE:NIFTY50-INDEX"].token == "99926000" and t["NSE:NIFTY50-INDEX"].kind == "index"
    assert t["NSE:INDIAVIX-INDEX"].token == "99926017"
    assert (t["NSE:NIFTY26O1322500CE"].token, t["NSE:NIFTY26O1322500PE"].token) == ("111", "112")
    assert t["NSE:NIFTY26OCTFUT"].kind == "future"
    assert t["BSE:SENSEX26O1572400CE"].exchange == "BFO" and t["BSE:SENSEX-INDEX"].exchange == "BSE"
    assert "NSE:NIFTY26O1323000CE" not in t  # no match -> absent, reported as unmapped


class FakeSmartApi:
    """getCandleData / getOIData for the tokens below; records every call."""

    def __init__(self, series, oi=None, oi_error=None):
        self.series, self.oi, self.oi_error = series, oi or {}, oi_error
        self.calls = []

    def __call__(self, path, body, headers):
        self.calls.append((path, body["exchange"], body["symboltoken"]))
        token = body["symboltoken"]
        if path == CANDLE_PATH:
            return 200, {"status": True, "data": self.series.get(token, [])}
        if self.oi_error:
            return 200, {
                "status": False,
                "errorcode": self.oi_error,
                "message": "Invalid Bad Request",
            }
        return 200, {
            "status": True,
            "data": [{"time": t, "oi": v} for t, v in self.oi.get(token, [])],
        }


def client_for(fake, contracts=CONTRACTS):
    c = AngelClient(
        auth.Session("jwt", "key"), min_interval_s=0, post=fake, master_loader=lambda: MASTER
    )
    c.bind_contracts(contracts, [daily.UNDERLYINGS["NIFTY"], daily.UNDERLYINGS["SENSEX"]])
    return c


def test_option_bars_are_in_quantity_carried_forward_and_carry_oi():
    # trades at 09:20 and 09:25 only; volume 3 and 2 lots; OI reported at both minutes
    series = {
        "111": [
            [iso(9, 20), 100.0, 101.0, 99.0, 100.5, 3],
            [iso(9, 25), 100.5, 102.0, 100.0, 101.5, 2],
        ]
    }
    oi = {"111": [(iso(9, 20), 1000.0), (iso(9, 25), 1100.0)]}
    c = client_for(FakeSmartApi(series, oi))
    candles = c.minute_candles("NSE:NIFTY26O1322500CE", DAY)
    by_min = {datetime.fromtimestamp(x.epoch, IST).strftime("%H:%M"): x for x in candles}
    assert "09:19" not in by_min  # nothing is invented before the first trade
    assert by_min["09:20"].volume == 3 * 65 and by_min["09:20"].oi == 1000.0
    assert by_min["09:22"].volume == 0 and by_min["09:22"].close == 100.5  # carried forward
    assert by_min["09:22"].oi == 1000.0
    assert by_min["09:25"].volume == 2 * 65 and by_min["09:29"].close == 101.5
    assert max(by_min) == "15:29"
    f = c.flags["NIFTY"]
    assert f["thin_contracts"] == 1 and f["minutes_filled"] > 300


def test_index_gap_is_flagged_not_filled():
    rows = [
        [iso(h, m), 22000.0, 22001.0, 21999.0, 22000.5, 0]
        for h in range(9, 16)
        for m in range(60)
        if (9, 15) <= (h, m) <= (15, 29) and not ((15, 15) <= (h, m) <= (15, 28))
    ]
    c = client_for(FakeSmartApi({"99926000": rows}))
    candles = c.minute_candles("NSE:NIFTY50-INDEX", DAY)
    assert len(candles) == len(rows) == 361
    assert c.flags["NIFTY"]["index_missing_minutes"] == 14


def test_sensex_options_have_no_oi_call_and_are_flagged():
    series = {"221": [[iso(9, 30), 500.0, 510.0, 495.0, 505.0, 1]]}
    fake = FakeSmartApi(series, oi_error="AB1012")
    c = client_for(fake)
    candles = c.minute_candles("BSE:SENSEX26O1572400CE", DAY)
    assert candles and candles[0].oi is None
    assert all(call[0] != OI_PATH for call in fake.calls)  # BFO is never asked
    assert c.flags["SENSEX"]["oi_unavailable"] is True


def test_unmapped_contract_is_counted_and_returns_nothing():
    c = client_for(FakeSmartApi({}))
    assert c.minute_candles("NSE:NIFTY26O1323000CE", DAY) == []
    assert c.flags["NIFTY"]["unmapped"] == 1


def test_an_expired_token_stops_the_run():
    def post(path, body, headers):
        return 200, {"status": False, "errorcode": "AG8002", "message": "Token Expired"}

    c = AngelClient(
        auth.Session("jwt", "key"), min_interval_s=0, post=post, master_loader=lambda: MASTER
    )
    c.bind_contracts(CONTRACTS, [daily.UNDERLYINGS["NIFTY"]])
    with pytest.raises(FyersCredentialsError):
        c.minute_candles("NSE:NIFTY50-INDEX", DAY)


def test_a_whole_day_goes_through_the_shared_collector(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "download_master", lambda segment: "")
    monkeypatch.setattr(
        daily, "parse_master", lambda text, names: [c for c in CONTRACTS if c.underlying == "NIFTY"]
    )

    def rows(base):
        return [[iso(9, 15 + i), base, base + 1, base - 1, base + 0.5, 2] for i in range(5)]

    series = {
        "99926000": rows(22500.0),
        "99926017": rows(15.0),
        "113": rows(22520.0),
        "111": rows(120.0),
        "112": rows(110.0),
    }
    oi = {"111": [(iso(9, 15), 900.0)], "112": [(iso(9, 15), 800.0)], "113": [(iso(9, 15), 5000.0)]}
    client = client_for(FakeSmartApi(series, oi))
    root = tmp_path / "data"
    details = daily.collect_day(
        client, DAY, ["NIFTY"], root, premium_floor=30, log=lambda _: None, source="angelone"
    )

    assert details["source"] == "angelone" and details["flags"]["NIFTY"]["thin_contracts"] >= 1
    assert lake.bars_1m_path(root, "index", "NIFTY", DAY).exists()
    assert pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", DAY)).num_rows > 0
    with connect(root, read_only=True) as con:
        [(source, status)] = con.execute("SELECT source, status FROM ingest_runs").fetchall()
    assert source == "angelone" and status in ("ok", "partial")
    assert (root / "raw" / "angelone").exists()
