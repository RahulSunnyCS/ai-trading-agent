"""Angel One connection check (`angelone/check.py`), its `/legwise/angel/*` routes and
`obt angel test`: the SmartAPI login is always faked — no test sends a real login."""

from __future__ import annotations

import json
import threading
from datetime import date

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from option_backtesting.angelone import auth, check
from option_backtesting.api.app import create_app
from option_backtesting.cli import angel_app

API_KEY = "apikey-secret-XYZ"
PIN = "4321"
TOTP_SEED = "JBSWY3DPEHPK3PXP"
CLIENT = "R123456"
JWT = "jwt-token-secret-abc"
ENV = {
    "ANGELONE_API_KEY": API_KEY,
    "ANGELONE_CLIENT_CODE": CLIENT,
    "ANGELONE_MPIN": PIN,
    "ANGELONE_TOTP_SECRET": TOTP_SEED,
}
SECRETS = (API_KEY, PIN, TOTP_SEED, CLIENT, JWT)


class Clock:
    def __init__(self, t: float = 1_760_000_000.0) -> None:
        self.t = t
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


class Login:
    """A fake `auth.login`: counts calls, returns a session or raises what it was given."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls = 0

    def __call__(self, creds):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return auth.Session(jwt=JWT, api_key=creds.api_key)


def assert_no_secret(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text, f"secret {secret!r} leaked"


@pytest.fixture
def root(tmp_path):
    return tmp_path


def run(root, clock, login, source="manual", wait=False, env=ENV):
    return check.run_check(
        source, wait=wait, root=root, env=env, login=login, now=clock.now, sleep=clock.sleep
    )


# --- the check -----------------------------------------------------------------------------


def test_a_login_that_works_is_recorded_with_the_client_masked_and_no_secret(root, capsys):
    clock, login = Clock(), Login()
    result = run(root, clock, login)
    assert result.ok and result.reason == "ok" and result.attempted
    assert result.client == "R1•••56" and result.source == "manual"
    assert login.calls == 1
    stored = (root / "angelone" / "last_check.json").read_text()
    assert json.loads(stored)["last"]["ok"] is True
    assert_no_secret(stored)
    assert_no_secret(json.dumps(result.as_dict()))
    out = capsys.readouterr()
    assert_no_secret(out.out + out.err)
    assert not (root / "angelone" / "running.json").exists()


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (auth.AngelCredentialsError(f"login failed: AB1050 for {CLIENT} totp {PIN}"), "rejected"),
        (auth.AngelNetworkError("Angel One could not be reached: network: timed out"), "network"),
        (auth.AngelUnavailableError("Angel One is unavailable (HTTP 503): down"), "unavailable"),
        (ValueError(f"bad seed {TOTP_SEED} for {CLIENT} pin {PIN}"), "error"),
    ],
)
def test_each_failure_is_classified_and_scrubbed(root, error, reason):
    clock = Clock()
    result = run(root, clock, Login(error))
    assert not result.ok and result.reason == reason and result.attempted
    assert_no_secret(result.message)
    assert_no_secret((root / "angelone" / "last_check.json").read_text())


def test_the_real_login_path_scrubs_the_pin_from_angel_ones_message(root):
    def post(path, body, headers):
        return 200, {"status": False, "errorcode": "AB1050", "message": f"Invalid totp {PIN}"}

    result = run(root, Clock(), lambda creds: auth.login(creds, post=post, now=lambda: 10))
    assert result.reason == "rejected" and "AB1050" in result.message
    assert_no_secret(result.message)


def test_missing_credentials_send_no_login_and_start_no_cool_down(root):
    clock, login = Clock(), Login()
    env = {k: v for k, v in ENV.items() if k != "ANGELONE_MPIN"}
    result = run(root, clock, login, env=env)
    assert result.reason == "not_configured" and not result.attempted
    assert "ANGELONE_MPIN" in result.message and login.calls == 0
    again = run(root, clock, login)  # no cool-down: nothing was sent
    assert again.ok and login.calls == 1


def test_a_manual_check_in_the_cool_down_is_refused_without_a_login(root):
    clock, login = Clock(), Login()
    run(root, clock, login)
    clock.t += 20
    with pytest.raises(check.CheckRefused) as refused:
        run(root, clock, login)
    assert refused.value.kind == "cooldown" and refused.value.retry_after_s == 40
    assert login.calls == 1
    clock.t += 41
    assert run(root, clock, login).ok and login.calls == 2


def test_a_failed_login_starts_the_cool_down_too(root):
    clock = Clock()
    run(root, clock, Login(auth.AngelCredentialsError("Angel One login failed: AB1050")))
    with pytest.raises(check.CheckRefused, match="Try again in 60 s"):
        run(root, clock, Login())


def test_a_scheduled_check_waits_out_a_manual_cool_down_instead_of_failing(root):
    clock, login = Clock(), Login()
    run(root, clock, login)
    clock.t += 15
    result = run(root, clock, login, source="scheduled", wait=True)
    assert result.ok and result.source == "scheduled" and login.calls == 2
    assert clock.slept == [45]


def test_a_check_in_flight_refuses_a_second_one(root):
    started, release = threading.Event(), threading.Event()
    clock = Clock()

    def slow(creds):
        started.set()
        release.wait(5)
        return auth.Session(jwt=JWT, api_key=creds.api_key)

    worker = threading.Thread(target=run, args=(root, clock, slow))
    worker.start()
    try:
        assert started.wait(5)
        assert check.status(root, ENV, now=clock.now)["running"] is True
        second = Login()
        with pytest.raises(check.CheckRefused) as refused:
            run(root, clock, second)
        assert refused.value.kind == "running" and second.calls == 0
    finally:
        release.set()
        worker.join(5)
    assert check.status(root, ENV, now=clock.now)["running"] is False


def test_a_scheduled_check_does_not_repeat_a_recent_rejection(root):
    clock = Clock()
    run(root, clock, Login(auth.AngelCredentialsError("Angel One login failed: AB1050")))
    clock.t += 5 * 60  # the job's retry, after the cool-down
    retry = Login()
    with pytest.raises(check.CheckRefused) as refused:
        run(root, clock, retry, source="scheduled", wait=True)
    assert refused.value.kind == "rejected_recently" and retry.calls == 0
    # a manual test is still allowed (the owner fixed the credentials)
    assert run(root, clock, retry).ok and retry.calls == 1


def test_a_scheduled_check_retries_after_a_network_failure(root):
    clock = Clock()
    run(root, clock, Login(auth.AngelNetworkError("Angel One could not be reached")), "scheduled")
    clock.t += 5 * 60
    retry = Login()
    assert run(root, clock, retry, source="scheduled", wait=True).ok and retry.calls == 1


def test_mask_client():
    assert check.mask_client("R123456") == "R1•••56"
    assert check.mask_client("AB12") == "A•••"
    assert check.mask_client("") is None


# --- status ----------------------------------------------------------------------------------


def test_status_names_the_settings_never_their_values(root):
    clock = Clock()
    env = {**ENV, "ANGELONE_PUBLIC_IP": ""}
    got = check.status(root, env, now=clock.now)
    assert got["configured"] is True and got["client"] == "R1•••56"
    names = {c["name"]: c for c in got["credentials"]}
    assert set(names) == {*auth.REQUIRED, "ANGELONE_PUBLIC_IP"}
    assert names["ANGELONE_PUBLIC_IP"] == {
        "name": "ANGELONE_PUBLIC_IP",
        "set": False,
        "required": False,
    }
    assert got["last_check"] is None and got["retry_after_s"] == 0
    assert_no_secret(json.dumps(got))

    run(root, clock, Login())
    clock.t += 10
    got = check.status(root, env, now=clock.now)
    assert got["last_check"]["ok"] is True and got["retry_after_s"] == 50
    assert_no_secret(json.dumps(got))


def test_status_when_not_configured(root):
    got = check.status(root, {"ANGELONE_API_KEY": API_KEY})
    assert got["configured"] is False and got["client"] is None
    assert [c["name"] for c in got["credentials"] if not c["set"]] == [
        "ANGELONE_CLIENT_CODE",
        "ANGELONE_MPIN",
        "ANGELONE_TOTP_SECRET",
        "ANGELONE_PUBLIC_IP",
    ]


def test_status_reports_the_last_angel_one_collection(root):
    from trading_data import ingest
    from trading_data.db import connect

    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, "angelone", "bars_1m", date(2026, 10, 16), "ALL")
        ingest.finish_run(con, run_id, requests=3, rows_written=10, errors=0, details={})
        ingest.start_run(con, "fyers", "bars_1m", date(2026, 10, 17), "ALL")
    got = check.status(root, ENV)["last_collection"]
    assert got["trading_day"] == "2026-10-16" and got["status"] == "ok"
    assert got["started_at"].endswith("+05:30")


# --- routes ----------------------------------------------------------------------------------


@pytest.fixture
def api(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(auth, "load_dotenv", lambda: None)
    for key in (*auth.REQUIRED, "ANGELONE_PUBLIC_IP"):
        monkeypatch.delenv(key, raising=False)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    return TestClient(create_app())


def test_post_test_runs_one_login_then_refuses_during_the_cool_down(api, monkeypatch):
    login = Login()
    monkeypatch.setattr(auth, "login", login)
    first = api.post("/legwise/angel/test")
    assert first.status_code == 200 and first.json()["result"]["ok"] is True
    assert_no_secret(first.text)
    second = api.post("/legwise/angel/test")
    assert second.status_code == 429 and "Try again in" in second.json()["error"]
    assert int(second.headers["Retry-After"]) > 0 and login.calls == 1

    status = api.get("/legwise/angel/status")
    assert status.status_code == 200
    body = status.json()
    assert body["last_check"]["source"] == "manual" and body["retry_after_s"] > 0
    assert_no_secret(status.text)


def test_post_test_reports_a_failed_login_as_a_result_not_an_error(api, monkeypatch):
    monkeypatch.setattr(auth, "login", Login(auth.AngelNetworkError("could not be reached")))
    got = api.post("/legwise/angel/test")
    assert got.status_code == 200
    assert got.json()["result"] | {"checked_at": None, "duration_ms": 0} == {
        "checked_at": None,
        "source": "manual",
        "ok": False,
        "reason": "network",
        "message": "could not be reached",
        "client": "R1•••56",
        "duration_ms": 0,
        "attempted": True,
    }


def test_post_test_while_one_is_running_is_409(api, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise check.CheckRefused("running", "An Angel One connection test is already running.")

    monkeypatch.setattr(check, "run_check", refuse)
    got = api.post("/legwise/angel/test")
    assert got.status_code == 409 and "already running" in got.json()["error"]


# --- CLI -------------------------------------------------------------------------------------


def test_cli_exit_codes(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(auth, "load_dotenv", lambda: None)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)

    monkeypatch.setattr(auth, "login", Login())
    ok = CliRunner().invoke(angel_app, ["test", "--scheduled"])
    assert ok.exit_code == 0 and "ok as R1•••56" in ok.output
    assert_no_secret(ok.output)
    assert json.loads((root / "angelone" / "last_check.json").read_text())["last"]["source"] == (
        "scheduled"
    )

    refused = CliRunner().invoke(angel_app, ["test"])  # manual, inside the cool-down
    assert refused.exit_code == 3 and "not attempted" in refused.output

    stored = json.loads((root / "angelone" / "last_check.json").read_text())
    stored["last_attempt_at"] = "2000-01-01T00:00:00+05:30"
    (root / "angelone" / "last_check.json").write_text(json.dumps(stored))
    monkeypatch.setattr(auth, "login", Login(auth.AngelCredentialsError("login failed: AB1050")))
    failed = CliRunner().invoke(angel_app, ["test"])
    assert failed.exit_code == 1 and "failed (rejected)" in failed.output
    assert_no_secret(failed.output)
