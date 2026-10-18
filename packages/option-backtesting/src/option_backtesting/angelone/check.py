"""
Angel One connection check: ONE SmartAPI login, nothing fetched, the session dropped at once.

Used by the dashboard's Broker logins card (`POST /legwise/angel/test`, source "manual") and the
08:00 scheduler job `angel-login-check` (`obt angel test --scheduled`, source "scheduled"). Both
go through `run_check`, so they share one guard:

- one check at a time, across processes: an exclusive `flock` on `angelone/check.lock`;
- a cool-down of COOLDOWN_S after any login attempt (SmartAPI rate-limits logins and each wrong
  attempt counts toward a lockout). A manual check is refused during it; a scheduled one waits it
  out (at most COOLDOWN_S), and waits for a check already in flight, so a button press just
  before 08:00 never makes the job fail;
- a scheduled check never repeats a login Angel One refused within REJECT_HOLD_S: the job's retry
  is for a network blip, and a wrong PIN or TOTP sent again only moves the account toward a lock.

The last result goes to `TRADING_DATA_ROOT/angelone/last_check.json` (time, ok, reason class,
scrubbed message, masked client code, source). Never a token, PIN, TOTP code or API key: the
session `auth.login` returns is not stored, and messages come from `auth`, which scrubs them.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..fyers.daily import data_dir
from . import auth

IST = ZoneInfo("Asia/Kolkata")

#: Seconds after a login attempt before another may be sent.
COOLDOWN_S = 60
#: A scheduled check does not repeat a login refused this recently (seconds).
REJECT_HOLD_S = 15 * 60
#: How long a scheduled check waits for one already in flight (a login with network retries
#: takes at most ~100 s).
LOCK_WAIT_S = 180
#: An in-flight marker older than this is a crashed check, not a running one.
RUNNING_STALE_S = 10 * 60
OPTIONAL = ("ANGELONE_PUBLIC_IP",)
SOURCES = ("manual", "scheduled")
#: ok, not_configured (no login sent), rejected (Angel One refused the login), network (not
#: reached), unavailable (HTTP 5xx), error (anything else, e.g. a TOTP seed that is not base32).
REASONS = ("ok", "not_configured", "rejected", "network", "unavailable", "error")

Clock = Callable[[], float]
Sleep = Callable[[float], None]


@dataclass(frozen=True)
class CheckResult:
    checked_at: str  # ISO 8601, IST
    source: str  # manual | scheduled
    ok: bool
    reason: str  # one of REASONS
    message: str  # scrubbed; never a secret
    client: str | None  # masked client code
    duration_ms: int
    attempted: bool  # a login request was sent (starts the cool-down)

    def as_dict(self) -> dict:
        return asdict(self)


class CheckRefused(Exception):
    """No login was sent. `kind`: running | cooldown | rejected_recently."""

    def __init__(self, kind: str, message: str, retry_after_s: int = 0) -> None:
        super().__init__(message)
        self.kind = kind
        self.retry_after_s = retry_after_s


def state_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "angelone"


def mask_client(code: str | None) -> str | None:
    """`R123456` -> `R1•••56`: enough to tell accounts apart, not the whole code."""
    code = (code or "").strip()
    if not code:
        return None
    if len(code) <= 4:
        return code[0] + "•••"
    return f"{code[:2]}•••{code[-2:]}"


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    if env is None:
        auth.load_dotenv()
        return os.environ
    return env


def credentials(env: Mapping[str, str] | None = None) -> list[dict]:
    """Which settings are present: names and a yes/no only, never a value."""
    env = _env(env)
    return [
        {"name": name, "set": bool(env.get(name, "").strip()), "required": name in auth.REQUIRED}
        for name in (*auth.REQUIRED, *OPTIONAL)
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
    try:
        return datetime.fromisoformat(str(iso)).timestamp()
    except ValueError:
        return None


def cooldown_left(state: dict, now: float) -> int:
    """Whole seconds until another login may be sent (0 = now)."""
    at = _epoch(state.get("last_attempt_at")) if state.get("last_attempt_at") else None
    if at is None:
        return 0
    left = COOLDOWN_S - (now - at)
    return max(0, int(left + 0.999))


def _recently_rejected(state: dict, now: float) -> bool:
    last = state.get("last") or {}
    at = _epoch(last.get("checked_at")) if last.get("checked_at") else None
    return last.get("reason") == "rejected" and at is not None and now - at < REJECT_HOLD_S


def _running(root: Path, now: float) -> bool:
    try:
        started = _epoch(json.loads((state_dir(root) / "running.json").read_text())["started_at"])
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return started is not None and now - started < RUNNING_STALE_S


# --- the check ------------------------------------------------------------------------------


@contextlib.contextmanager
def _exclusive(root: Path, wait_s: float, now: Clock, sleep: Sleep) -> Iterator[None]:
    folder = state_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / "check.lock", "a+") as fh:
        deadline = now() + wait_s
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if now() >= deadline:
                    raise CheckRefused(
                        "running",
                        "An Angel One connection test is already running. "
                        "Try again when it finishes.",
                    ) from None
                sleep(1.0)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, IST).isoformat(timespec="seconds")


def _attempt(
    source: str,
    env: Mapping[str, str] | None,
    login: Callable[[auth.AngelCredentials], object],
    now: Clock,
) -> CheckResult:
    started = now()

    def done(ok: bool, reason: str, message: str, client: str | None, attempted: bool):
        return CheckResult(
            checked_at=_iso(started),
            source=source,
            ok=ok,
            reason=reason,
            message=message,
            client=client,
            duration_ms=max(0, int((now() - started) * 1000)),
            attempted=attempted,
        )

    try:
        creds = auth.load_credentials(env)
    except auth.AngelCredentialsError as error:
        return done(False, "not_configured", str(error), None, False)
    client = mask_client(creds.client_code)

    def clean(text: str) -> str:
        # auth already scrubs the PIN, TOTP seed and key; the client code is shown masked.
        scrubbed = auth._scrub(text, creds)
        return scrubbed.replace(creds.client_code, client or "") if creds.client_code else scrubbed

    try:
        session = login(creds)
    except auth.AngelUnavailableError as error:
        return done(False, "unavailable", clean(str(error)), client, True)
    except auth.AngelNetworkError as error:
        return done(False, "network", clean(str(error)), client, True)
    except auth.AngelCredentialsError as error:
        return done(False, "rejected", clean(str(error)), client, True)
    except Exception as error:  # noqa: BLE001 - reported as a failed check, never raised
        detail = clean(f"{type(error).__name__}: {error}")
        return done(False, "error", f"The login could not be completed: {detail}", client, True)
    del session  # the token is never kept
    return done(True, "ok", "Logged in to Angel One SmartAPI.", client, True)


def run_check(
    source: str,
    *,
    wait: bool = False,
    root: Path | None = None,
    env: Mapping[str, str] | None = None,
    login: Callable[[auth.AngelCredentials], object] | None = None,
    now: Clock = time.time,
    sleep: Sleep = time.sleep,
) -> CheckResult:
    """One guarded login. `wait` (the scheduled job) waits for a check in flight and out the
    cool-down instead of being refused. Raises CheckRefused when no login was sent for the
    guard's sake; a failed login is a CheckResult with ok False, recorded like a success."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    root = root or data_dir()
    with _exclusive(root, LOCK_WAIT_S if wait else 0, now, sleep):
        marker = state_dir(root) / "running.json"
        marker.write_text(json.dumps({"started_at": _iso(now()), "source": source}))
        try:
            state = _read_state(root)
            left = cooldown_left(state, now())
            if left > 0:
                if not wait:
                    raise CheckRefused(
                        "cooldown",
                        f"Angel One was tried less than {COOLDOWN_S} s ago. "
                        f"Try again in {left} s (logins are rate-limited).",
                        left,
                    )
                sleep(left)
            if source == "scheduled" and _recently_rejected(state, now()):
                raise CheckRefused(
                    "rejected_recently",
                    "Not retried: Angel One refused the login at "
                    f"{state['last']['checked_at']}. Each wrong attempt counts toward a lockout; "
                    "fix the credentials, then use Test connection on Broker logins "
                    "(or `obt angel test`).",
                )
            result = _attempt(source, env, login or auth.login, now)
            _write_state(
                root,
                {
                    "last": result.as_dict(),
                    "last_attempt_at": result.checked_at
                    if result.attempted
                    else state.get("last_attempt_at"),
                },
            )
        finally:
            with contextlib.suppress(OSError):
                marker.unlink()
    return result


def last_collection(root: Path) -> dict | None:
    """The newest collection run recorded with source `angelone` (each one began with a login
    that worked), or None when there is none or the catalog cannot be read right now."""
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
    creds = credentials(env)
    configured = all(c["set"] for c in creds if c["required"])
    client = mask_client(_env(env).get("ANGELONE_CLIENT_CODE", "")) if configured else None
    out: dict = {
        "configured": configured,
        "credentials": creds,
        "client": client,
        "last_check": None,
        "last_collection": None,
        "running": False,
        "cooldown_s": COOLDOWN_S,
        "retry_after_s": 0,
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
    out["running"] = _running(root, t)
    out["retry_after_s"] = cooldown_left(state, t)
    out["last_collection"] = last_collection(root)
    return out
