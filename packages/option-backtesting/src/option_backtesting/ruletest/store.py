"""Where rule tests keep things, as plain files under TRADING_DATA_ROOT/ruletest/ (not the catalog,
which allows one writer): the specs, the simulation cache, cached features, one result file per
test, and two append-only logs, the **ledger** of every test and the **reveals** of the locked
confirmation period.

    ruletest/specs/<spec_hash>.yaml     the validated spec text, as tested
    ruletest/simcache/<template>.csv    one row per (day, entry, side, slippage) simulated
    ruletest/features/*.npz             cached features (the ATM straddle)
    ruletest/results/<test_id>.json     one test's full result
    ruletest/tests.jsonl                the ledger: one line per test, append-only
    ruletest/reveals.jsonl              the confirmation period opened for a spec, append-only
"""

from __future__ import annotations

import fcntl
import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

IST = timezone(timedelta(hours=5, minutes=30))


class RuleTestError(RuntimeError):
    """A test cannot be run or read; the message is shown as it is."""


class LockedError(RuleTestError):
    """The confirmation period is locked for this spec."""


def ruletest_dir(root: Path) -> Path:
    return root / "ruletest"


def features_dir(root: Path) -> Path:
    return ruletest_dir(root) / "features"


def simcache_dir(root: Path) -> Path:
    return ruletest_dir(root) / "simcache"


def specs_dir(root: Path) -> Path:
    return ruletest_dir(root) / "specs"


def results_dir(root: Path) -> Path:
    return ruletest_dir(root) / "results"


@contextmanager
def _lock(root: Path) -> Iterator[None]:
    directory = ruletest_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / ".store.lock", "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def now() -> datetime:
    return datetime.now(IST)


def _read_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:  # an unreadable line is skipped, never fatal
            continue
    return out


def _append(path: Path, row: dict[str, Any], root: Path) -> None:
    with _lock(root), path.open("a") as handle:
        handle.write(json.dumps(row, sort_keys=True) + "\n")


# --- specs ---------------------------------------------------------------------------------


def save_spec(root: Path, spec_hash: str, text: str) -> None:
    path = specs_dir(root) / f"{spec_hash}.yaml"
    with _lock(root):
        specs_dir(root).mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(text)


def read_spec(root: Path, spec_hash: str) -> str | None:
    path = specs_dir(root) / f"{spec_hash}.yaml"
    return path.read_text() if path.exists() else None


# --- reveals -------------------------------------------------------------------------------


def reveals(root: Path) -> list[dict[str, Any]]:
    return _read_lines(ruletest_dir(root) / "reveals.jsonl")


def is_revealed(root: Path, spec_hash: str) -> bool:
    return any(r.get("spec_hash") == spec_hash for r in reveals(root))


def reveal(root: Path, spec_hash: str, note: str = "") -> dict[str, Any]:
    """Open the confirmation period for one spec, once. A changed spec is a new hash and is locked
    again. The reveal is logged and cannot be undone."""
    row = {"spec_hash": spec_hash, "at": now().isoformat(timespec="seconds"), "note": note}
    if not is_revealed(root, spec_hash):
        _append(ruletest_dir(root) / "reveals.jsonl", row, root)
    return row


# --- ledger --------------------------------------------------------------------------------


def ledger(root: Path) -> list[dict[str, Any]]:
    return _read_lines(ruletest_dir(root) / "tests.jsonl")


def new_test_id() -> str:
    return datetime.now(IST).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]


def record_test(root: Path, row: dict[str, Any], result: dict[str, Any]) -> None:
    """Write the result file first, then the ledger line, so a ledger line always has its result."""
    with _lock(root):
        results_dir(root).mkdir(parents=True, exist_ok=True)
        (results_dir(root) / f"{row['id']}.json").write_text(json.dumps(result))
    _append(ruletest_dir(root) / "tests.jsonl", row, root)


def read_result(root: Path, test_id: str) -> dict[str, Any] | None:
    path = results_dir(root) / f"{test_id}.json"
    if not test_id.replace("-", "").isalnum() or not path.exists():
        return None
    return json.loads(path.read_text())


def counts(rows: list[dict[str, Any]], at: datetime | None = None) -> dict[str, int]:
    """How many tests (counting a sweep of K variants as K) were run this week, this month and in
    all: the number every result shows beside itself."""
    at = at or now()
    week_start = (at - timedelta(days=at.weekday())).date().isoformat()
    month_start = at.date().replace(day=1).isoformat()
    total = week = month = 0
    for row in rows:
        tries = int(row.get("tries", 1))
        total += tries
        day = str(row.get("at", ""))[:10]
        week += tries if day >= week_start else 0
        month += tries if day >= month_start else 0
    return {"week": week, "month": month, "total": total}


def lucky_sentence(tries: int) -> str:
    """One plain sentence on what chance alone would show among that many tries."""
    if tries <= 1:
        return "This is the only test so far, so a good result is not yet explained by luck."
    expected = tries * 0.05
    return (
        f"With {tries} tests, about {expected:.1f} would look good at the 5% level by chance "
        "alone, even if none of the rules had any edge."
    )
