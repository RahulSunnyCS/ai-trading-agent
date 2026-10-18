"""Angel One logins under one guard (`angelone/check.py`), its `/legwise/angel/*` routes,
`obt angel test` and the collector's login: the SmartAPI login is always faked — no test sends a
real login."""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import date

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from option_backtesting.angelone import auth, check
from option_backtesting.api.app import create_app
from option_backtesting.cli import angel_app

API_KEY = "apikey-secret-XYZ4321"
PIN = "4321"  # also inside the key: the key must still be fully redacted
TOTP_SEED = "JBSWY3DPEHPK3PXP"
CLIENT = "R123456"
JWT = "jwt-token-secret-abc"
ENV = {
    "ANGELONE_API_KEY": API_KEY,
    "ANGELONE_CLIENT_CODE": CLIENT,
    "ANGELONE_MPIN": PIN,
    "ANGELONE_TOTP_SECRET": TOTP_SEED,
}
SECRETS = (API_KEY, PIN, TOTP_SEED, CLIENT, JWT, "XYZ")


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
    """A fake `auth.login`: counts calls, remembers the PIN it was given, optionally takes
    `takes` seconds of the fake clock, returns a session or raises what it was given."""

    def __init__(self, error: Exception | None = None, clock: Clock | None = None, takes=0.0):
        self.error, self.clock, self.takes = error, clock, takes
        self.calls = 0
        self.pins: list[str] = []

    def __call__(self, creds):
        self.calls += 1
        self.pins.append(creds.pin)
        if self.clock is not None:
            self.clock.t += self.takes
        if self.error is not None:
            raise self.error
        return auth.Session(jwt=JWT, api_key=creds.api_key)


def refused() -> auth.AngelCredentialsError:
    return auth.AngelCredentialsError("Angel One login failed: AB1050 Invalid totp")


def assert_no_secret(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text, f"secret {secret!r} leaked"


@pytest.fixture(autouse=True)
def no_repo_dotenv(tmp_path, monkeypatch):
    """Never read the real repo .env: tests write their own when they need one."""
    monkeypatch.setattr(check, "DOTENV_PATH", tmp_path / "missing.env")
    monkeypatch.setattr(auth, "load_dotenv", lambda: None)


@pytest.fixture
def root(tmp_path):
    return tmp_path / "data"


def run(root, clock, login, source="manual", wait=False, env=ENV):
    return check.run_check(
        source, wait=wait, root=root, env=env, login=login, now=clock.now, sleep=clock.sleep
    )


def stored(root) -> dict:
    return json.loads((root / "angelone" / "last_check.json").read_text())


# --- one check -------------------------------------------------------------------------------


def test_a_login_that_works_is_recorded_with_the_client_masked_and_no_secret(root, capsys):
    clock, login = Clock(), Login()
    result = run(root, clock, login)
    assert result.ok and result.reason == "ok" and result.attempted
    assert result.client == "R1•••56" and result.source == "manual"
    assert login.calls == 1
    text = (root / "angelone" / "last_check.json").read_text()
    assert json.loads(text)["last"]["ok"] is True
    assert_no_secret(text)
    assert_no_secret(json.dumps(result.as_dict()))
    out = capsys.readouterr()
    assert_no_secret(out.out + out.err)
    assert check.running(root) == (False, None)


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (auth.AngelCredentialsError(f"login failed: AB1050 for {CLIENT} totp {PIN}"), "rejected"),
        (auth.AngelNetworkError("Angel One could not be reached: network: timed out"), "network"),
        (auth.AngelUnavailableError("Angel One is unavailable (HTTP 503): down"), "unavailable"),
        (ValueError(f"bad seed {TOTP_SEED} key {API_KEY} for {CLIENT} pin {PIN}"), "error"),
    ],
)
def test_each_failure_is_classified_and_scrubbed(root, error, reason):
    result = run(root, Clock(), Login(error))
    assert not result.ok and result.reason == reason and result.attempted
    assert_no_secret(result.message)
    assert_no_secret((root / "angelone" / "last_check.json").read_text())


def test_the_key_is_fully_redacted_even_when_the_pin_occurs_inside_it():
    creds = auth.AngelCredentials(CLIENT, API_KEY, PIN, TOTP_SEED)
    text = auth.redact(f"key {API_KEY} pin {PIN} client {CLIENT}", creds)
    assert text == "key <redacted> pin <redacted> client R1•••56"


def test_the_client_code_is_masked_before_the_message_is_cut():
    creds = auth.AngelCredentials(CLIENT, API_KEY, PIN, TOTP_SEED)
    text = auth._scrub("x" * 155 + CLIENT, creds)
    assert len(text) == 160 and "R1234" not in text


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


def test_mask_client():
    assert check.mask_client("R123456") == "R1•••56"
    assert check.mask_client("AB12") == "A•••"
    assert check.mask_client("") is None


# --- the .env file is re-read ------------------------------------------------------------------


def test_the_env_file_wins_for_the_angel_keys_only(tmp_path, monkeypatch):
    dotenv = tmp_path / "repo.env"
    dotenv.write_text(
        'export ANGELONE_MPIN="9999"  # fixed\nANGELONE_PUBLIC_IP=1.2.3.4\nOTHER_KEY=file\n'
    )
    monkeypatch.setattr(check, "DOTENV_PATH", dotenv)
    monkeypatch.setenv("ANGELONE_MPIN", PIN)  # what the process loaded at start
    monkeypatch.setenv("OTHER_KEY", "process")
    env = check.current_env()
    assert env["ANGELONE_MPIN"] == "9999" and env["ANGELONE_PUBLIC_IP"] == "1.2.3.4"
    assert env["OTHER_KEY"] == "process"
    assert os.environ["ANGELONE_MPIN"] == PIN  # the process environment is not changed


def test_an_edited_pin_is_used_without_a_restart_and_the_status_is_current(
    root, tmp_path, monkeypatch
):
    dotenv = tmp_path / "repo.env"
    monkeypatch.setattr(check, "DOTENV_PATH", dotenv)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    dotenv.write_text("".join(f"{k}={v}\n" for k, v in ENV.items() if k != "ANGELONE_MPIN"))
    dotenv.write_text(dotenv.read_text() + "ANGELONE_MPIN=\n")  # emptied in the file
    assert check.status(root)["configured"] is False

    dotenv.write_text(dotenv.read_text().replace("ANGELONE_MPIN=\n", "ANGELONE_MPIN=8765\n"))
    clock, login = Clock(), Login()
    check.run_check("manual", root=root, login=login, now=clock.now, sleep=clock.sleep)
    assert login.pins == ["8765"]
    assert check.status(root, now=clock.now)["configured"] is True


# --- the guard ---------------------------------------------------------------------------------


def test_a_manual_check_in_the_cool_down_is_refused_without_a_login(root):
    clock, login = Clock(), Login()
    run(root, clock, login)
    clock.t += 20
    with pytest.raises(check.CheckRefused) as refusal:
        run(root, clock, login)
    assert refusal.value.kind == "cooldown" and refusal.value.retry_after_s == 40
    assert login.calls == 1
    clock.t += 41
    assert run(root, clock, login).ok and login.calls == 2


def test_the_cool_down_runs_from_the_end_of_the_attempt(root):
    clock = Clock()
    run(root, clock, Login(clock=clock, takes=50))  # answered 50 s after it started
    clock.t += 20
    with pytest.raises(check.CheckRefused) as refusal:
        run(root, clock, Login())
    assert refusal.value.retry_after_s == 40


def test_the_cool_down_is_never_longer_than_a_minute(root):
    clock = Clock()
    run(root, clock, Login())
    clock.t -= 3600  # the clock moved back an hour
    got = check.status(root, ENV, now=clock.now)
    assert got["retry_after_s"] == 60
    result = run(root, clock, Login(), source="scheduled", wait=True)
    assert result.ok and clock.slept == [60]


def test_a_scheduled_check_waits_out_a_manual_cool_down_instead_of_failing(root):
    clock, login = Clock(), Login()
    run(root, clock, login)
    clock.t += 15
    result = run(root, clock, login, source="scheduled", wait=True)
    assert result.ok and result.source == "scheduled" and login.calls == 2
    assert clock.slept == [45]


def test_a_check_in_flight_refuses_a_second_one_and_shows_as_running(root):
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
        got = check.status(root, ENV, now=clock.now)
        assert got["running"] is True and got["running_source"] == "manual"
        second = Login()
        with pytest.raises(check.CheckRefused) as refusal:
            check.run_check("manual", root=root, env=ENV, login=second)  # real clock
        assert refusal.value.kind == "running" and second.calls == 0
        assert "already running" in str(refusal.value)
    finally:
        release.set()
        worker.join(5)
    assert check.status(root, ENV, now=clock.now)["running"] is False


def test_a_crashed_check_leaves_no_running_state(root):
    folder = root / "angelone"
    folder.mkdir(parents=True)
    (folder / "check.lock").touch()
    (folder / "running.json").write_text(json.dumps({"started_at": "x", "source": "manual"}))
    assert check.status(root, ENV)["running"] is False
    assert run(root, Clock(), Login()).ok


def test_a_refused_login_is_held_for_every_source_until_the_settings_change(root):
    clock = Clock()
    run(root, clock, Login(refused()))
    clock.t += 5 * 60  # past the cool-down
    retry = Login()
    for source, wait in (("manual", False), ("scheduled", True)):
        with pytest.raises(check.CheckRefused) as refusal:
            run(root, clock, retry, source=source, wait=wait)
        assert refusal.value.kind == "held" and refusal.value.retry_after_s == 10 * 60
        assert "Fix the ANGELONE_* settings" in str(refusal.value)
    assert retry.calls == 0
    got = check.status(root, ENV, now=clock.now)
    assert got["hold"]["until"] and "not tried again" in got["hold"]["message"]
    assert_no_secret(json.dumps(got))
    assert_no_secret(json.dumps(stored(root)))  # the digest, not the values

    fixed = {**ENV, "ANGELONE_MPIN": "5678"}  # the owner fixed the PIN
    assert check.status(root, fixed, now=clock.now)["hold"] is None
    assert run(root, clock, retry, env=fixed).ok and retry.pins == ["5678"]


def test_the_hold_ends_after_fifteen_minutes(root):
    clock = Clock()
    run(root, clock, Login(refused()))
    clock.t += 15 * 60 + 1
    assert run(root, clock, Login(), source="scheduled", wait=True).ok


def test_a_scheduled_check_retries_after_a_network_failure(root):
    clock = Clock()
    run(root, clock, Login(auth.AngelNetworkError("could not be reached")), "scheduled")
    clock.t += 5 * 60
    retry = Login()
    assert run(root, clock, retry, source="scheduled", wait=True).ok and retry.calls == 1


# --- the collector's login -----------------------------------------------------------------------


def test_the_collector_holds_the_lock_through_its_collection_and_is_recorded(root):
    clock, login = Clock(), Login()
    with check.session(root=root, env=ENV, login=login, now=clock.now, sleep=clock.sleep) as s:
        assert s.jwt == JWT
        got = check.status(root, ENV, now=clock.now)
        assert got["running"] is True and got["running_source"] == "collector"
        with pytest.raises(check.CheckRefused, match="being collected"):
            check.run_check("manual", root=root, env=ENV, login=Login())
    assert stored(root)["last"]["source"] == "collector"
    assert check.status(root, ENV, now=clock.now)["running"] is False
    with pytest.raises(check.CheckRefused) as refusal:  # its login started the cool-down
        run(root, clock, Login())
    assert refusal.value.kind == "cooldown"


def test_the_collector_raises_the_login_error_and_honours_a_hold(root):
    clock = Clock()
    with (
        pytest.raises(auth.AngelCredentialsError),
        check.session(root=root, env=ENV, login=Login(refused()), now=clock.now, sleep=clock.sleep),
    ):
        pass
    clock.t += 120
    login = Login()
    with (
        pytest.raises(auth.AngelCredentialsError, match="not tried again"),
        check.session(root=root, env=ENV, login=login, now=clock.now, sleep=clock.sleep),
    ):
        pass
    assert login.calls == 0


def test_the_angel_collection_logs_in_through_the_guard(root, monkeypatch):
    from option_backtesting.fyers import daily
    from option_backtesting.legwise import evening

    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(auth, "login", Login())
    seen = {}

    def fake_collect_day(client, day, underlyings, root_, **kwargs):
        seen["running"] = check.running(root_)
        return {}

    monkeypatch.setattr(daily, "collect_day", fake_collect_day)
    errors, _ = evening.collect_detailed(
        date(2026, 10, 16), ["NIFTY"], source="angelone", log=lambda _m: None
    )
    assert errors == 0 and seen["running"] == (True, "collector")
    assert stored(root)["last"]["source"] == "collector"


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
    assert got["cooldown_until"] is None and got["hold"] is None
    assert_no_secret(json.dumps(got))

    run(root, clock, Login())
    clock.t += 10
    got = check.status(root, env, now=clock.now)
    assert got["last_check"]["ok"] is True and got["retry_after_s"] == 50
    assert got["cooldown_until"].endswith("+05:30")
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
    for key in check.KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    return TestClient(create_app())


def wait_for_result(api) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        body = api.get("/legwise/angel/status").json()
        if body["last_check"] and not body["running"]:
            return body
        time.sleep(0.02)
    raise AssertionError("the background check never finished")


def test_post_test_answers_202_at_once_and_the_status_carries_the_result(api, monkeypatch):
    release = threading.Event()
    login = Login()

    def slow(creds):
        release.wait(5)
        return login(creds)

    monkeypatch.setattr(auth, "login", slow)
    started = api.post("/legwise/angel/test")
    assert started.status_code == 202 and started.json()["status"] == "started"
    busy = api.post("/legwise/angel/test")  # the first still holds the lock
    assert busy.status_code == 409 and "already running" in busy.json()["error"]
    assert api.get("/legwise/angel/status").json()["running"] is True
    release.set()

    body = wait_for_result(api)
    assert body["last_check"]["ok"] is True and body["last_check"]["source"] == "manual"
    assert body["retry_after_s"] > 0 and login.calls == 1
    assert_no_secret(json.dumps(body))

    again = api.post("/legwise/angel/test")
    assert again.status_code == 429 and "Try again in" in again.json()["error"]
    assert int(again.headers["Retry-After"]) > 0 and login.calls == 1


def test_a_failed_login_lands_in_the_status_and_then_holds(api, monkeypatch):
    monkeypatch.setattr(auth, "login", Login(refused()))
    assert api.post("/legwise/angel/test").status_code == 202
    body = wait_for_result(api)
    assert body["last_check"]["reason"] == "rejected" and body["last_check"]["ok"] is False
    assert body["hold"] is not None


def test_a_hold_is_refused_with_429(api, monkeypatch):
    def hold(*_args, **_kwargs):
        raise check.CheckRefused("held", "Angel One refused the login …", 600)

    monkeypatch.setattr(check, "begin", hold)
    got = api.post("/legwise/angel/test")
    assert got.status_code == 429 and got.json()["kind"] == "held"
    assert got.headers["Retry-After"] == "600"


# --- CLI -------------------------------------------------------------------------------------


def test_cli_exit_codes(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)

    monkeypatch.setattr(auth, "login", Login())
    ok = CliRunner().invoke(angel_app, ["test", "--scheduled"])
    assert ok.exit_code == 0 and "ok as R1•••56" in ok.output
    assert_no_secret(ok.output)
    assert stored(root)["last"]["source"] == "scheduled"

    busy = CliRunner().invoke(angel_app, ["test"])  # manual, inside the cool-down
    assert busy.exit_code == 3 and "not attempted" in busy.output

    state = stored(root)
    state["last_attempt_at"] = "2000-01-01T00:00:00+05:30"
    (root / "angelone" / "last_check.json").write_text(json.dumps(state))
    monkeypatch.setattr(auth, "login", Login(refused()))
    failed = CliRunner().invoke(angel_app, ["test"])
    assert failed.exit_code == 1 and "failed (rejected)" in failed.output
    assert_no_secret(failed.output)

    state = stored(root)
    state["last_attempt_at"] = "2000-01-01T00:00:00+05:30"
    (root / "angelone" / "last_check.json").write_text(json.dumps(state))
    held = CliRunner().invoke(angel_app, ["test", "--scheduled"])
    assert held.exit_code == 1 and "not tried again" in held.output


def test_cli_status_masks_the_client_code(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    got = CliRunner().invoke(angel_app, ["status"])
    assert got.exit_code == 0 and "R1•••56" in got.output
    assert_no_secret(got.output)
