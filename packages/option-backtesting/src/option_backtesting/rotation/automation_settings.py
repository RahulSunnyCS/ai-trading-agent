"""The automation settings (BL-140) as the export jobs read them: the current version the
scheduler writes to `automation-settings.json` beside its database whenever the owner saves the
dashboard's Settings › Automation page (`apps/scheduler/src/automation.ts` writes it and holds the
validation; `packages/broker-login/src/automation-settings.ts` is the TypeScript reader).

No file yet means today's setup (the scheduler's defaults), so the jobs behave exactly as before
until the owner saves something. A file that cannot be read is an error: never guess."""

from __future__ import annotations

import copy
import json
import os
import re
from datetime import date
from pathlib import Path

_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
PLATFORMS = ("algotest", "quantiply")
BROKERS = ("finvasia", "angelone")
LISTS = ("none", "core", "t1")
#: BL-211: the most day-type rules a settings version may hold
MAX_RULES = 20
_DTE_LABELS = ("0", "1", "2", "3", "4", "5", "6", "7+")
_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")
_INDICES = ("NIFTY", "SENSEX")

DEFAULT = {
    "version": 0,
    "masters": {"logins": True, "uploads": True, "deploy": False},
    "rows": {
        "algotest.finvasia": {
            "login": True,
            "list": "t1",
            "upload": True,
            "multiplier": 1,
            "addon": True,
            "dirBoost": False,
        },
        "algotest.angelone": {
            "login": False,
            "list": "none",
            "upload": False,
            "multiplier": 1,
            "addon": True,
            "dirBoost": False,
        },
        "quantiply.angelone": {
            "login": True,
            "list": "core",
            "upload": True,
            "multiplier": 1,
            "addon": True,
            "dirBoost": False,
        },
        "quantiply.finvasia": {
            "login": False,
            "list": "none",
            "upload": False,
            "multiplier": 1,
            "addon": True,
            "dirBoost": False,
        },
    },
    "pause": {"until": None},
    "splitT1": False,
    "rules": [],
}


def settings_path() -> Path:
    base = os.environ.get("SCHEDULER_STATE_DIR", "").strip()
    folder = (
        Path(base) if base else Path.home() / "Library" / "Application Support" / "ai-trading-agent"
    )
    return folder / "automation-settings.json"


def read(path: Path | None = None) -> tuple[dict, str]:
    """(settings, where they came from: 'settings vN' or 'defaults')."""
    path = path or settings_path()
    if not path.exists():
        return DEFAULT, "settings: defaults (none saved yet)"
    data = json.loads(path.read_text())
    if not isinstance(data.get("masters"), dict) or not isinstance(data.get("rows"), dict):
        raise ValueError(f"{path}: not automation settings")
    for p in PLATFORMS:
        for b in BROKERS:
            row = data["rows"].get(f"{p}.{b}")
            if row is None:
                raise ValueError(f"{path}: row {p}.{b} missing")
            if row.get("list") not in ("none", "core", "t1"):
                raise ValueError(f"{path}: row {p}.{b} has list {row.get('list')!r}")
            # A snapshot written before Phase 4 has neither field: 1 and yes, what the jobs did.
            # A bad value is an error, never a guess: a wrong multiplier changes a real order.
            multiplier = row.get("multiplier", 1)
            if (
                isinstance(multiplier, bool)
                or not isinstance(multiplier, int)
                or not 1 <= multiplier <= 10
            ):
                raise ValueError(f"{path}: row {p}.{b} has multiplier {row.get('multiplier')!r}")
            addon = row.get("addon", True)
            if not isinstance(addon, bool):
                raise ValueError(f"{path}: row {p}.{b} has addon {row.get('addon')!r}")
            dir_boost = row.get("dirBoost", False)  # settings before BL-183: off
            if not isinstance(dir_boost, bool):
                raise ValueError(f"{path}: row {p}.{b} has dirBoost {row.get('dirBoost')!r}")
            row["multiplier"], row["addon"], row["dirBoost"] = multiplier, addon, dir_boost
    pause = data.get("pause") or {}
    until = pause.get("until") if isinstance(pause, dict) else "?"
    if until is not None and not (isinstance(until, str) and _DAY.fullmatch(until)):
        raise ValueError(f"{path}: pause.until is {until!r}")
    data["pause"] = {"until": until}
    split = data.get("splitT1", False)  # settings before BL-209: off
    if not isinstance(split, bool):
        raise ValueError(f"{path}: splitT1 is {split!r}")
    data["splitT1"] = split
    data["rules"] = _read_rules(path, data.get("rules", []))  # settings before BL-211: none
    return data, f"settings v{data.get('version', 0)}"


class DayTypeUnknown(RuntimeError):
    """A day-type rule needs a fact about the session that is not known (an unknown days-to-expiry
    label). Raised so the job stops loudly instead of trading a row's base list by guess."""


def _read_rules(path: Path, raw: object) -> list[dict]:
    """The day-type rules (BL-211), checked as the scheduler checks them on a Save. A bad rule is
    an error, never a guess: a wrong list changes a real order."""
    if not isinstance(raw, list):
        raise ValueError(f"{path}: rules must be a list")
    if len(raw) > MAX_RULES:
        raise ValueError(f"{path}: more than {MAX_RULES} rules")
    rows = {f"{p}.{b}" for p in PLATFORMS for b in BROKERS}
    out = []
    for i, rule in enumerate(raw, start=1):
        where = f"{path}: rule {i}"
        if not isinstance(rule, dict) or rule.get("row") not in rows:
            raise ValueError(
                f"{where} has row {rule.get('row') if isinstance(rule, dict) else rule!r}"
            )
        if rule.get("list") not in LISTS:
            raise ValueError(f"{where} has list {rule.get('list')!r}")
        when = rule.get("when")
        if not isinstance(when, dict):
            raise ValueError(f"{where} has no condition")
        if when.get("kind") == "dte":
            if when.get("index") not in _INDICES or when.get("dte") not in _DTE_LABELS:
                raise ValueError(f"{where}: bad days-to-expiry condition {when!r}")
        elif when.get("kind") == "weekday":
            if when.get("weekday") not in _WEEKDAYS:
                raise ValueError(f"{where}: bad weekday condition {when!r}")
        else:
            raise ValueError(f"{where}: unknown condition kind {when.get('kind')!r}")
        out.append(rule)
    return out


def rule_matches(when: dict, day_type) -> bool:
    """Whether a rule's condition holds on `day_type` (a `day_type.DayType`). A days-to-expiry
    condition on an index whose label is not known raises `DayTypeUnknown`."""
    if when["kind"] == "weekday":
        return day_type.weekday == when["weekday"]
    label = str(day_type.dte.get(when["index"], "unknown"))
    if label not in _DTE_LABELS:
        raise DayTypeUnknown(
            f"{day_type.day}: days to expiry of {when['index']} is {label}, so a rule on it "
            "cannot be decided"
        )
    return label == when["dte"]


def resolve(settings: dict, day_type) -> dict:
    """The settings as they stand for the session of `day_type`: each row's `list` replaced by the
    first rule of that row whose condition holds (BL-211). Everything else is the row's own. A row
    whose base list is None and which a rule gives a list is uploaded (it has no upload flag of its
    own to inherit); a rule giving None turns the upload off. `rules_applied` records, per row,
    which rule decided and the day type read. With no rule the settings come back untouched."""
    rules = settings.get("rules") or []
    if not rules:
        return settings
    out = copy.deepcopy(settings)
    applied: dict[str, dict] = {}
    for key, row in out["rows"].items():
        for i, rule in enumerate(rules, start=1):
            if rule["row"] != key or not rule_matches(rule["when"], day_type):
                continue
            was_none = row.get("list") == "none"
            row["list"] = rule["list"]
            if rule["list"] == "none":
                row["upload"] = False
            elif was_none:
                row["upload"] = True
            applied[key] = {"rule": i, "list": rule["list"], "note": rule.get("note") or ""}
            break
    out["rules_applied"] = applied
    out["day_type"] = day_type.as_json()
    return out


def read_for_session(day: date, path: Path | None = None) -> tuple[dict, str]:
    """`read`, resolved for the session on `day` (BL-211): what the jobs trade that day. With no
    rule it is `read` exactly; with rules, the day type is computed (and kept for the TypeScript
    jobs) and an unknown label a rule needs raises `DayTypeUnknown`."""
    settings, source = read(path)
    if not settings.get("rules"):
        return settings, source
    from . import day_type

    resolved = resolve(settings, day_type.ensure(day))
    applied = resolved.get("rules_applied") or {}
    note = f"{source}, {day}: " + (
        ", ".join(f"{k} → {v['list']} (rule {v['rule']})" for k, v in applied.items())
        if applied
        else "no rule applies"
    )
    return resolved, note


#: what an account's capital reads as when the settings have none (owner, 2026-10-29: ₹8.5 lakh)
DEFAULT_CAPITAL = 850_000
#: the brokers' names in messages
BROKER_NAMES = {"angelone": "Angel One", "finvasia": "Shoonya"}


def capital(settings: dict) -> dict[str, int]:
    """{broker: rupees}, each account's capital from Settings › Automation; the default where the
    settings have none. For the messages only, so it never raises: `read` stays as strict as the
    jobs that place strategies need, and a bad figure here only reads as the default."""
    raw = settings.get("capital")
    raw = raw if isinstance(raw, dict) else {}
    return {
        b: v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else DEFAULT_CAPITAL
        for b in BROKERS
        for v in [raw.get(b)]
    }


#: the margin block's defaults (BL-205, owner 2026-11-04): a 10% buffer on the largest per-lot
#: requirement of the last 6 days of tomorrow's type
DEFAULT_MARGIN = {"bufferPct": 10, "days": 6}


def margin(settings: dict) -> dict[str, int]:
    """{'bufferPct', 'days'} for the evening message's margin block (Settings › Automation).
    For the message only, so it never raises: a missing or bad value reads as the default."""
    raw = settings.get("margin")
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for key, low, high in (("bufferPct", 0, 50), ("days", 1, 30)):
        v = raw.get(key)
        ok = isinstance(v, int) and not isinstance(v, bool) and low <= v <= high
        out[key] = v if ok else DEFAULT_MARGIN[key]
    return out


def book_capital(settings: dict, book: str) -> int:
    """The capital behind a list (`core` or `t1`): the accounts with a row that uploads it, each
    counted once (two platforms on one account share its money); the default when none does."""
    per = capital(settings)
    brokers = {
        b
        for p in PLATFORMS
        for b in BROKERS
        if (row := settings["rows"].get(f"{p}.{b}"))
        and row.get("list") == book
        and row.get("upload")
    }
    return sum(per[b] for b in brokers) if brokers else DEFAULT_CAPITAL


def paused_for(settings: dict, session: str) -> str | None:
    """The pause's last day when a session on `session` (an IST day, YYYY-MM-DD) is paused, else
    None. Inclusive."""
    until = (settings.get("pause") or {}).get("until")
    return until if until is not None and session <= until else None


def upload_books(settings: dict, platform: str, broker: str | None = None) -> list[str]:
    """The lists (`core`, `t1`) to upload to `platform`, for one broker's row or any of them;
    empty when uploads are switched off or no row uploads."""
    if not settings["masters"].get("uploads"):
        return []
    books = set()
    for b in [broker] if broker else BROKERS:
        row = settings["rows"][f"{platform}.{b}"]
        if row.get("upload") and row.get("list") in ("core", "t1"):
            books.add(row["list"])
    return sorted(books)


def _uploading_rows(settings: dict, platform: str, book: str) -> list[dict]:
    return [
        settings["rows"][f"{platform}.{b}"]
        for b in BROKERS
        if settings["rows"][f"{platform}.{b}"].get("upload")
        and settings["rows"][f"{platform}.{b}"].get("list") == book
    ]


def addon_wanted(settings: dict, platform: str, book: str) -> bool:
    """Whether the `platform` export of `book` carries the Buy add-on picks: yes unless every row
    that uploads that list has the add-on off. One export serves every account of a platform, so
    while any account that shares the list wants the add-on it stays in."""
    rows = _uploading_rows(settings, platform, book)
    if not settings["masters"].get("uploads") or not rows:
        return True  # nothing uploads this list: leave the export as it always was
    return any(r.get("addon", True) for r in rows)


def addon_mixed(settings: dict, platform: str, book: str) -> bool:
    """Whether the rows that upload this list disagree about the add-on (so the export keeps it
    for an account that asked to leave it out)."""
    rows = _uploading_rows(settings, platform, book)
    return len({bool(r.get("addon", True)) for r in rows}) > 1


def dir_boost_wanted(settings: dict, platform: str, book: str) -> bool:
    """Whether the `platform` export of `book` trades the picked Dir at 2 lots on a non-expiry day
    (BL-183): only when every row that uploads that list has it on. One export serves every
    account of a platform, so while any account that shares the list wants 1 lot, it stays 1 lot
    (the safe way round: a doubled order is the one that can be wrong in rupees)."""
    rows = _uploading_rows(settings, platform, book)
    if not settings["masters"].get("uploads") or not rows:
        return False
    return all(r.get("dirBoost", False) for r in rows)


def dir_boost_mixed(settings: dict, platform: str, book: str) -> bool:
    """Whether the rows that upload this list disagree about Dir ×2 (so the export stays at 1 lot
    for an account that asked for 2)."""
    rows = _uploading_rows(settings, platform, book)
    return len({bool(r.get("dirBoost", False)) for r in rows}) > 1


def dir_boost_lists(settings: dict, uploads_on: dict[str, bool] | None = None) -> dict[str, bool]:
    """BL-183, for the messages: {'adaptive', 't1'} -> whether some platform's export of that list
    trades the Dir ×2 rule (`dir_boost_wanted`) and reaches that platform (`uploads_on`, by
    platform: its `.env` upload switch; unset = every platform), so its lines say the lots."""
    on = uploads_on if uploads_on is not None else {p: True for p in PLATFORMS}
    return {
        key: any(on.get(p, False) and dir_boost_wanted(settings, p, book) for p in PLATFORMS)
        for key, book in (("adaptive", "core"), ("t1", "t1"))
    }


def env_uploads_on(env: dict[str, str] | None = None) -> dict[str, bool]:
    """The `.env` hard switches that let each platform's uploader change anything:
    ALGOTEST_UPLOAD / QUANTIPLY_UPLOAD = on."""
    env = os.environ if env is None else env
    return {p: str(env.get(f"{p.upper()}_UPLOAD", "")).strip().lower() == "on" for p in PLATFORMS}


def split_t1(settings: dict) -> list[str] | None:
    """BL-209: the two AlgoTest accounts T1 is split across ([lead, other], `account_split.LEAD`
    first) when the switch is on and both AlgoTest rows upload T1; None otherwise, and the export is
    what it is without the split."""
    if not settings.get("splitT1") or not settings["masters"].get("uploads"):
        return None
    rows = [
        b
        for b in BROKERS
        if (r := settings["rows"][f"algotest.{b}"]).get("upload") and r.get("list") == "t1"
    ]
    if len(rows) != 2:
        return None
    from .account_split import LEAD

    return sorted(rows, key=lambda b: b != LEAD)
