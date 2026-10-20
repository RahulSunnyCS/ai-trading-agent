"""
Angel One logins under one guard: the connection check (ONE SmartAPI login, nothing fetched, the
session dropped) and the collector's own login.

Callers, by `source`:
- "manual": the dashboard's Test connection (`POST /legwise/angel/test`, which starts the check
  in a background thread once `begin` has the lock, and `obt angel test`);
- "scheduled": the 08:00 job `angel-login-check` (`obt angel test --scheduled`);
- "collector": `obt angel fetch` and the `obt daily` fallback (`evening.collect_detailed`), through
  `session()`, which holds the lock for the whole collection so no test logs in under it;
- "margin": `obt angel funds` (BL-143, the 09:05 margin check), through `session(source="margin")`:
  one login, one read of the account's funds (`getRMS`), the session dropped.

The guard, shared by all of them:
- one at a time, across processes: an exclusive `flock` on `TRADING_DATA_ROOT/angelone/check.lock`.
  "Running" is a non-blocking probe of that lock (the kernel drops it if a process dies), and
  `running.json` only says who holds it;
- a cool-down of COOLDOWN_S from the END of any login attempt (SmartAPI rate-limits logins and
  each wrong attempt counts toward a lockout). A manual test is refused during it; the scheduled
  check and the collector wait it out;
- a login Angel One refused is not sent again for REJECT_HOLD_S with the same settings: every
  source is held, unless the `.env`'s ANGELONE_* values changed since the refusal (compared by a
  digest of the values, never the values themselves).

Settings are re-read from the repo `.env` file on every check and status call, the file winning
for the ANGELONE_* keys only, so an edited PIN or TOTP seed is used without restarting obt-api or
the scheduler (both load `.env` once, with setdefault).

The last result goes to `TRADING_DATA_ROOT/angelone/last_check.json` (time, ok, reason class,
scrubbed message, masked client code, source). Never a token, PIN, TOTP code or API key.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import sys
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import IO
from zoneinfo import ZoneInfo

from ..fyers.auth import REPO_ROOT
from ..fyers.daily import data_dir
from . import auth

IST = ZoneInfo("Asia/Kolkata")

#: Seconds after the end of a login attempt before another may be sent.
COOLDOWN_S = 60
#: A login Angel One refused is not sent again this soon with the same settings (seconds).
REJECT_HOLD_S = 15 * 60
#: How long the scheduled check and the collector wait for the lock (a test with network
#: retries takes at most ~100 s).
LOCK_WAIT_S = 180
#: A manual test waits this long for the lock, so a status probe holding it for a moment never
#: refuses it.
MANUAL_LOCK_WAIT_S = 1.0
OPTIONAL = ("ANGELONE_PUBLIC_IP",)
KEYS = (*auth.REQUIRED, *OPTIONAL)
SOURCES = ("manual", "scheduled", "collector", "margin")
#: ok, not_configured (no login sent), rejected (Angel One refused the login), network (not
#: reached), unavailable (HTTP 5xx), error (anything else, e.g. a TOTP seed that is not base32).
REASONS = ("ok", "not_configured", "rejected", "network", "unavailable", "error")
#: The repo .env the ANGELONE_* settings are re-read from (tests point it elsewhere).
DOTENV_PATH = REPO_ROOT / ".env"

Clock = Callable[[], float]
Sleep = Callable[[float], None]
Login = Callable[[auth.AngelCredentials], auth.Session]


@dataclass(frozen=True)
class CheckResult:
    checked_at: str  # ISO 8601, IST: when the attempt started
    source: str  # manual | scheduled | collector
    ok: bool
    reason: str  # one of REASONS
    message: str  # scrubbed; never a secret
    client: str | None  # masked client code
    duration_ms: int
    attempted: bool  # a login request was sent (starts the cool-down)

    def as_dict(self) -> dict:
        return asdict(self)


class CheckRefused(Exception):
    """No login was sent. `kind`: running | cooldown | held."""

    def __init__(self, kind: str, message: str, retry_after_s: int = 0) -> None:
        super().__init__(message)
        self.kind = kind
        self.retry_after_s = retry_after_s


def state_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "angelone"


mask_client = auth.mask_client


# --- settings -------------------------------------------------------------------------------


def _dotenv_keys(path: Path) -> dict[str, str]:
    """The ANGELONE_* keys in the .env file (the same parsing rules as `fyers.auth.load_dotenv`)."""
    try:
        text = path.read_text()
    except OSError:
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        if key in KEYS:
            out[key] = value.split(" #", 1)[0].strip().strip('"').strip("'")
    return out


def current_env() -> dict[str, str]:
    """This process's environment with the ANGELONE_* keys from the `.env` file laid over it
    (the file wins for those keys only), read now."""
    env = dict(os.environ)
    env.update(_dotenv_keys(DOTENV_PATH))
    return env


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return current_env() if env is None else env


def fingerprint(env: Mapping[str, str]) -> str:
    """A digest of the ANGELONE_* values, to tell whether they changed. Not reversible in
    practice (the key and TOTP seed are in it); never shown."""
    joined = "\0".join(env.get(k, "").strip() for k in KEYS)
    return hashlib.sha256(joined.encode()).hexdigest()[:16]


def credentials(env: Mapping[str, str]) -> list[dict]:
    """Which settings are present: names and a yes/no only, never a value."""
    return [
        {"name": name, "set": bool(env.get(name, "").strip()), "required": name in auth.REQUIRED}
        for name in KEYS
    ]


# --- the state file -------------------------------------------------------------------------


def _read_state(root: Path) -> dict:
    path = state_dir(root) / "last_check.json"
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_state(root: Path, state: dict) -> None:
    folder = state_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".last_check.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh, indent=2)
        os.replace(tmp, folder / "last_check.json")
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _epoch(iso: object) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(str(iso)).timestamp()
    except ValueError:
        return None


def _iso(epoch: float, timespec: str = "seconds") -> str:
    return datetime.fromtimestamp(epoch, IST).isoformat(timespec=timespec)


def _cooldown_exact(state: dict, now: float) -> float:
    at = _epoch(state.get("last_attempt_at"))
    if at is None:
        return 0.0
    return min(float(COOLDOWN_S), max(0.0, COOLDOWN_S - (now - at)))


def cooldown_left(state: dict, now: float) -> int:
    """Whole seconds until another login may be sent: 0 to COOLDOWN_S (a clock moved back
    never makes it longer)."""
    left = _cooldown_exact(state, now)
    return min(COOLDOWN_S, int(left + 0.999))


def _hold(state: dict, env: Mapping[str, str], now: float) -> tuple[float, str] | None:
    """(until, message) while a refused login must not be repeated with the same settings."""
    last = state.get("last") or {}
    at = _epoch(last.get("checked_at"))
    if last.get("reason") != "rejected" or at is None:
        return None
    if state.get("rejected_fingerprint") != fingerprint(env):
        return None  # the settings changed since the refusal
    until = at + REJECT_HOLD_S
    if now >= until:
        return None
    return until, (
        f"Angel One refused the login at {_iso(at)[11:16]} IST. Each wrong attempt counts toward "
        f"a lockout, so it is not tried again with the same settings until {_iso(until)[11:16]}. "
        "Fix the ANGELONE_* settings in .env to test sooner."
    )


def refusal_hold(
    root: Path | None = None, env: Mapping[str, str] | None = None, now: Clock = time.time
) -> str | None:
    """The hold message while a refused login must not be repeated with the current settings,
    else None. For a caller that logs in outside the lock (the 09:16 VIX fallback): it never
    waits, it only skips."""
    return (_hold(_read_state(root or data_dir()), _env(env), now()) or (None, None))[1]


# --- the lock -------------------------------------------------------------------------------


def _marker(root: Path) -> Path:
    return state_dir(root) / "running.json"


def _holder(root: Path) -> str | None:
    try:
        return str(json.loads(_marker(root).read_text()).get("source")) or None
    except (OSError, ValueError, AttributeError):
        return None


def _busy_message(root: Path) -> str:
    if _holder(root) == "collector":
        return "Angel One data is being collected right now. Test when the collection finishes."
    return "An Angel One connection test is already running. Try again when it finishes."


def _acquire(root: Path, wait_s: float, now: Clock, sleep: Sleep) -> IO:
    folder = state_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    fh = open(folder / "check.lock", "a+")  # noqa: SIM115 - released by _release
    deadline = now() + wait_s
    while True:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fh
        except BlockingIOError:
            if now() >= deadline:
                fh.close()
                raise CheckRefused("running", _busy_message(root)) from None
            sleep(0.05 if wait_s <= MANUAL_LOCK_WAIT_S else 1.0)


def _release(root: Path, fh: IO) -> None:
    with contextlib.suppress(OSError):
        _marker(root).unlink()
    with contextlib.suppress(OSError):
        fcntl.flock(fh, fcntl.LOCK_UN)
    fh.close()


def running(root: Path) -> tuple[bool, str | None]:
    """(held, by whom) from a non-blocking probe of the lock: a crashed holder's lock is gone."""
    path = state_dir(root) / "check.lock"
    if not path.exists():
        return False, None
    with open(path, "a+") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True, _holder(root)
        fcntl.flock(fh, fcntl.LOCK_UN)
    return False, None


# --- one attempt ----------------------------------------------------------------------------


def _clean(text: str, creds: auth.AngelCredentials) -> str:
    """Secrets out and the client code masked, then cut to length (`auth._scrub`)."""
    return auth._scrub(text, creds)


def _attempt(
    source: str, env: Mapping[str, str], login: Login, now: Clock
) -> tuple[CheckResult, auth.Session | None, Exception | None]:
    started = now()

    def done(ok, reason, message, client, attempted, session=None, error=None):
        result = CheckResult(
            checked_at=_iso(started),
            source=source,
            ok=ok,
            reason=reason,
            message=message,
            client=client,
            duration_ms=max(0, int((now() - started) * 1000)),
            attempted=attempted,
        )
        return result, session, error

    try:
        creds = auth.load_credentials(env)
    except auth.AngelCredentialsError as error:
        return done(False, "not_configured", str(error), None, False, error=error)
    client = mask_client(creds.client_code)
    try:
        session = login(creds)
    except auth.AngelUnavailableError as error:
        return done(False, "unavailable", _clean(str(error), creds), client, True, None, error)
    except auth.AngelNetworkError as error:
        return done(False, "network", _clean(str(error), creds), client, True, None, error)
    except auth.AngelCredentialsError as error:
        return done(False, "rejected", _clean(str(error), creds), client, True, None, error)
    except Exception as error:  # noqa: BLE001 - reported as a failed check
        detail = _clean(f"{type(error).__name__}: {error}", creds)
        message = f"The login could not be completed: {detail}"
        return done(False, "error", message, client, True, None, error)
    return done(True, "ok", "Logged in to Angel One SmartAPI.", client, True, session)


class Pending:
    """A check that holds the lock and passed the guard; `run()` sends the login and releases
    the lock. `begin` makes one, so a caller can refuse at once and run the login elsewhere
    (the API's background thread)."""

    def __init__(self, root, fh, source, env, state, login, now) -> None:
        self.root, self._fh, self.source, self._env = root, fh, source, env
        self._state, self._login, self._now = state, login, now
        self.started_at = _iso(now())
        self._done = False

    def attempt(self) -> tuple[CheckResult, auth.Session | None, Exception | None]:
        """The login, recorded. Does not release the lock (see `run` / `release`)."""
        result, session, error = _attempt(self.source, self._env, self._login, self._now)
        state = {
            "last": result.as_dict(),
            "last_attempt_at": _iso(self._now(), "milliseconds")
            if result.attempted
            else self._state.get("last_attempt_at"),
        }
        if result.reason == "rejected":
            state["rejected_fingerprint"] = fingerprint(self._env)
        _write_state(self.root, state)
        return result, session, error

    def release(self) -> None:
        if not self._done:
            self._done = True
            _release(self.root, self._fh)

    def run(self) -> CheckResult:
        """The check: the login, recorded, the session dropped, the lock released."""
        try:
            return self.attempt()[0]
        finally:
            self.release()

    def run_quietly(self) -> None:
        """`run` for a background thread: an error writing the state goes to stderr."""
        try:
            self.run()
        except Exception as error:  # noqa: BLE001 - nothing above a thread to raise into
            print(f"Angel One check failed: {type(error).__name__}: {error}", file=sys.stderr)


def begin(
    source: str,
    *,
    wait: bool = False,
    root: Path | None = None,
    env: Mapping[str, str] | None = None,
    login: Login | None = None,
    now: Clock = time.time,
    sleep: Sleep = time.sleep,
) -> Pending:
    """Take the lock and pass the guard, or raise CheckRefused (no login sent). `wait` (the
    scheduled check, the collector) waits for the lock and out the cool-down instead."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    root = root or data_dir()
    env = _env(env)
    fh = _acquire(root, LOCK_WAIT_S if wait else MANUAL_LOCK_WAIT_S, now, sleep)
    try:
        _marker(root).write_text(json.dumps({"started_at": _iso(now()), "source": source}))
        state = _read_state(root)
        left = _cooldown_exact(state, now())
        if left > 0:
            if not wait:
                secs = cooldown_left(state, now())
                raise CheckRefused(
                    "cooldown",
                    f"Angel One was tried less than {COOLDOWN_S} s ago. "
                    f"Try again in {secs} s (logins are rate-limited).",
                    secs,
                )
            sleep(left)
        hold = _hold(state, env, now())
        if hold is not None:
            until, message = hold
            raise CheckRefused("held", message, max(1, int(until - now() + 0.999)))
    except BaseException:
        _release(root, fh)
        raise
    return Pending(root, fh, source, env, state, login or auth.login, now)


def run_check(
    source: str,
    *,
    wait: bool = False,
    root: Path | None = None,
    env: Mapping[str, str] | None = None,
    login: Login | None = None,
    now: Clock = time.time,
    sleep: Sleep = time.sleep,
) -> CheckResult:
    """One guarded check, synchronously. Raises CheckRefused when the guard sent no login; a
    failed login is a CheckResult with ok False, recorded like a success."""
    pending = begin(source, wait=wait, root=root, env=env, login=login, now=now, sleep=sleep)
    return pending.run()


@contextlib.contextmanager
def session(
    *,
    source: str = "collector",
    root: Path | None = None,
    env: Mapping[str, str] | None = None,
    login: Login | None = None,
    now: Clock = time.time,
    sleep: Sleep = time.sleep,
) -> Iterator[auth.Session]:
    """The collector's login (source "collector"), recorded like a check, with the lock held
    until the block ends so no test logs in while the session is in use. Raises the login's own
    error (AngelCredentialsError / AngelNetworkError) as before; a guard refusal is an
    AngelCredentialsError (held) or AngelNetworkError (still busy after LOCK_WAIT_S)."""
    try:
        pending = begin(source, wait=True, root=root, env=env, login=login, now=now, sleep=sleep)
    except CheckRefused as refused:
        if refused.kind == "held":
            raise auth.AngelCredentialsError(str(refused)) from None
        raise auth.AngelNetworkError(str(refused)) from None
    try:
        result, sess, error = pending.attempt()
        if sess is None:
            raise error or auth.AngelCredentialsError(result.message)
        yield sess
    finally:
        pending.release()


# --- status ---------------------------------------------------------------------------------


def last_collection(root: Path) -> dict | None:
    """The newest collection run recorded with source `angelone`, or None when there is none or
    the catalog cannot be read right now."""
    from trading_data.db import catalog_path, connect

    if not catalog_path(root).exists():
        return None
    try:
        with connect(root, read_only=True, lock_wait=2.0, views=()) as con:
            row = con.execute(
                # epoch(): a TIMESTAMPTZ fetched as a datetime needs pytz, not installed here.
                "SELECT trading_day, epoch(started_at), status FROM ingest_runs "
                "WHERE source = 'angelone' ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
    except Exception:  # noqa: BLE001 - the card shows what it can; a busy catalog is not an error
        return None
    if row is None:
        return None
    trading_day, started_epoch, status = row
    return {
        "trading_day": trading_day.isoformat() if trading_day else None,
        "started_at": _iso(started_epoch) if started_epoch is not None else None,
        "status": status,
    }


def status(
    root: Path | None = None, env: Mapping[str, str] | None = None, now: Clock = time.time
) -> dict:
    """What the Broker logins card shows. Never a credential value."""
    env = _env(env)
    creds = credentials(env)
    configured = all(c["set"] for c in creds if c["required"])
    out: dict = {
        "configured": configured,
        "credentials": creds,
        "client": mask_client(env.get("ANGELONE_CLIENT_CODE", "")) if configured else None,
        "last_check": None,
        "last_collection": None,
        "running": False,
        "running_source": None,
        "cooldown_s": COOLDOWN_S,
        "retry_after_s": 0,
        "cooldown_until": None,
        "hold": None,
        "warning": None,
    }
    try:
        root = root or data_dir()
    except RuntimeError as error:  # the data root's volume is not mounted
        out["warning"] = str(error)
        return out
    state = _read_state(root)
    t = now()
    out["last_check"] = state.get("last") or None
    out["running"], out["running_source"] = running(root)
    left = _cooldown_exact(state, t)
    out["retry_after_s"] = cooldown_left(state, t)
    out["cooldown_until"] = _iso(t + left, "milliseconds") if left > 0 else None
    hold = _hold(state, env, t)
    if hold is not None:
        out["hold"] = {"until": _iso(hold[0]), "message": hold[1]}
    out["last_collection"] = last_collection(root)
    return out
