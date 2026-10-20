"""BL-143: the Angel One funds read (`angelone/funds.py`) and its guarded login source. Every
call is faked: no test sends a real login or request."""

from __future__ import annotations

import pytest

from option_backtesting.angelone import auth, check, funds

ENV = {
    "ANGELONE_API_KEY": "apikey-secret-XYZ4321",
    "ANGELONE_CLIENT_CODE": "R123456",
    "ANGELONE_MPIN": "4321",
    "ANGELONE_TOTP_SECRET": "JBSWY3DPEHPK3PXP",
}


def test_parse_rms_reads_net_and_cash():
    out = funds.parse_rms(
        {
            "status": True,
            "data": {"net": "512345.50", "availablecash": "600000", "utiliseddebits": "87654.5"},
        }
    )
    assert out.net == 512345.5
    assert out.available_cash == 600000.0
    assert out.utilised == 87654.5


def test_parse_rms_refuses_a_failed_answer_and_a_missing_net():
    with pytest.raises(auth.AngelCredentialsError, match="AG8001"):
        funds.parse_rms({"status": False, "errorcode": "AG8001", "message": "Invalid Token"})
    with pytest.raises(auth.AngelCredentialsError, match="net"):
        funds.parse_rms({"status": True, "data": {"availablecash": "1"}})


def test_read_funds_sends_the_session_token_and_never_posts():
    seen = {}

    def fake_get(path, headers):
        seen["path"], seen["auth"] = path, headers.get("Authorization")
        return 200, {"status": True, "data": {"net": "1000"}}

    sess = auth.Session(jwt="jwt-1", api_key="k", public_ip="0.0.0.0")
    assert funds.read_funds(sess, get=fake_get).net == 1000.0
    assert seen == {"path": funds.RMS_PATH, "auth": "Bearer jwt-1"}


def test_read_funds_unreached_is_an_error():
    sess = auth.Session(jwt="j", api_key="k")
    with pytest.raises(auth.AngelCredentialsError, match="not reached"):
        funds.read_funds(sess, get=lambda p, h: (0, {"status": False, "message": "network"}))


def test_margin_source_goes_through_the_guard(tmp_path):
    calls = []

    def login(creds):
        calls.append(creds.client_code)
        return auth.Session(jwt="j", api_key=creds.api_key)

    with check.session(source="margin", root=tmp_path, env=ENV, login=login) as sess:
        assert sess.jwt == "j"
    assert calls == ["R123456"]
    state = check._read_state(tmp_path)
    assert state["last"]["source"] == "margin"
    # the cool-down applies to the next login from any source
    assert check.cooldown_left(state, check._epoch(state["last_attempt_at"]) or 0) > 0
