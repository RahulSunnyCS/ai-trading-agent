"""The Today page's baskets with what the platforms hold (dashboard review, 2026-10-28): each
Adaptive book's picks for the latest recorded session and for the next session (the evening
message's "(Tentative)" list, `result.read_tentative`), every pick with its settings in words
(`labels.label`), and, per account that Settings › Automation has uploading that book, whether
the pick is uploaded and switched on there, replayed from the uploaders' own ledgers.

Read-only: it reads the journals, the tentative files, the automation settings and the ledgers
the broker-login jobs append; it never writes and never calls a platform. A ledger that is
missing or cannot be read is said, never read as "nothing uploaded".

Ledgers (written by `packages/broker-login`):
- Quantiply, per broker: `rotation/quantiply/ledger.jsonl` (Angel One) and `ledger-<broker>.jsonl`;
  `create` / `delete` lines with the algo `id`, its `name` (`Core · N_dir_0917`, `· add-on` on a
  Buy add-on), the session `day` and its `weekday`. A Quantiply algo runs on its weekday, so a
  pick is uploaded for a session when an algo of that name and weekday was created and not
  deleted since. Switching on is the deploy ledger (`deploy-ledger.jsonl`,
  `deploy-ledger-<broker>.jsonl`): the last `enable` / `disable` for that name in that session.
- AlgoTest: `rotation/algotest/ledger.jsonl`, `upload` / `delete` lines with `id`, `name`
  (`T1 · N_dir_0917`) and `day`; a saved strategy is not tied to a weekday, so a pick is uploaded
  when a strategy of that name was uploaded and not deleted since.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from . import automation_settings, journal, labels, result, store

BOOKS = ("core", "t1")
#: the name prefix each uploader gives a book's strategies
BOOK_PREFIX = {"core": "Core", "t1": "T1"}
PLATFORM_LABEL = {"algotest": "AlgoTest", "quantiply": "Quantiply"}
BROKER_LABEL = {"finvasia": "Shoonya", "angelone": "Angel One"}
WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")


def _weekday(day: str) -> str:
    return WEEKDAYS[date.fromisoformat(day).weekday()]


def _picks(core: list[str], buy: list[str]) -> list[dict]:
    out = []
    for role, names in (("core", core), ("buy", buy)):
        for name in names:
            lab = labels.label(name)
            out.append(
                {
                    "name": name,
                    "role": role,
                    "start": labels.slot(name),
                    "head": lab.head,
                    "params": lab.params,
                }
            )
    return sorted(out, key=lambda p: (p["role"] == "buy", p["start"] or "99:99", p["name"]))


def _latest_entry(root: Path, track: str | None) -> dict | None:
    entries = journal.read(store.journal_path(root, track))
    return entries[-1] if entries else None


def _recorded(root: Path) -> dict | None:
    """The latest recorded session of each book (the live journal's list C, and the T1 track's)."""
    live = _latest_entry(root, None)
    if live is None:
        return None
    books: dict[str, list[dict]] = {}
    for book, track in (("core", None), ("t1", "t1")):
        e = live if track is None else _latest_entry(root, track)
        if e is None or e["day"] != live["day"]:
            continue  # the track has no entry for that session: left out, never guessed
        block = e["lists"].get("C")
        if block:
            books[book] = _picks(list(block["core"]), list(block["buy"]))
    return {
        "day": live["day"],
        "kind": "recorded",
        "on_time": bool(live.get("before_first_entry")),
        "books": books,
    }


def _tentative(root: Path, after: str | None) -> dict | None:
    """The newest tentative list for a session after `after` (the latest recorded day)."""
    folder = result.tentative_path("x", root).parent
    if not folder.is_dir():
        return None
    days = sorted(
        p.name.removesuffix(".tentative.json")
        for p in folder.glob("*.tentative.json")
        if after is None or p.name.removesuffix(".tentative.json") > after
    )
    if not days:
        return None
    doc = result.read_tentative(days[-1], root)
    books: dict[str, list[dict]] = {}
    sent_on = None
    for book, key in (("core", "adaptive"), ("t1", "t1")):
        part = doc.get(key)
        if isinstance(part, dict) and isinstance(part.get("core"), list):
            books[book] = _picks(list(part["core"]), list(part.get("buy") or []))
            sent_on = sent_on or part.get("sent_on")
    if not books:
        return None
    return {"day": days[-1], "kind": "tentative", "sent_on": sent_on, "books": books}


def _read_jsonl(path: Path) -> list[dict] | None:
    """The ledger's lines, skipping a torn one; None when the file does not exist."""
    if not path.exists():
        return None
    out = []
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def _strip(name: str) -> str:
    """`Core · N_dir_0917 · add-on` -> `N_dir_0917`."""
    parts = [p.strip() for p in str(name).split("·")]
    return parts[1] if len(parts) >= 2 else str(name)


def quantiply_state(root: Path, broker: str, book: str, sessions: list[str]) -> dict:
    """Per session: `uploaded` (an algo of that name was created for the session, or one for its
    weekday is held now), `enabled` (switched on at some point in the session, by the deploy
    ledger: an `enable`, or the 15:40 `disable`, which only switches off algos that were on, by
    the tool or by hand) and `held` (every algo of the book held now for the session's weekday)."""
    folder = store.rotation_dir(root) / "quantiply"
    suffix = "" if broker == "angelone" else f"-{broker}"
    ledger = _read_jsonl(folder / f"ledger{suffix}.jsonl")
    deploys = _read_jsonl(folder / f"deploy-ledger{suffix}.jsonl") or []
    if ledger is None:
        return {"error": "no upload ledger for this account yet"}
    prefix = f"{BOOK_PREFIX[book]} ·"
    live: dict[str, dict] = {}
    created: dict[str, set[str]] = {}
    for row in ledger:
        if not row.get("ok") or not str(row.get("name", "")).startswith(prefix):
            continue
        if row.get("action") == "create" and row.get("id"):
            live[str(row["id"])] = row
            created.setdefault(str(row.get("day")), set()).add(_strip(row["name"]))
        elif row.get("action") == "delete":
            live.pop(str(row.get("id")), None)
    out: dict = {}
    for session in sessions:
        weekday = _weekday(session)
        held = {
            _strip(r["name"])
            for r in live.values()
            if (r.get("weekday") or _weekday(str(r.get("day")))) == weekday
        }
        enabled = {
            _strip(r["name"])
            for r in deploys
            if r.get("ok")
            and r.get("session") == session
            # the 15:40 switch-off only touches algos that were on, by the tool or by hand
            and r.get("action") in ("enable", "disable")
            and str(r.get("name", "")).startswith(prefix)
        }
        out[session] = {
            "uploaded": sorted(held | created.get(session, set())),
            "enabled": sorted(enabled),
            "held": sorted(held),
            "deploys_known": True,
        }
    return out


def algotest_state(root: Path, book: str, sessions: list[str]) -> dict:
    """A saved AlgoTest strategy is not tied to a weekday: uploaded = uploaded for the session, or
    held now. Deploys on /live keep no ledger here, so `enabled` is not known."""
    ledger = _read_jsonl(store.rotation_dir(root) / "algotest" / "ledger.jsonl")
    if ledger is None:
        return {"error": "no upload ledger yet"}
    prefix = f"{BOOK_PREFIX[book]} ·"
    live: dict[str, str] = {}
    uploaded: dict[str, set[str]] = {}
    for row in ledger:
        name = str(row.get("name", ""))
        if not row.get("ok") or not name.startswith(prefix):
            continue
        if row.get("action") == "upload" and row.get("id"):
            live[str(row["id"])] = _strip(name)
            uploaded.setdefault(str(row.get("day")), set()).add(_strip(name))
        elif row.get("action") == "delete":
            live.pop(str(row.get("id")), None)
    held = set(live.values())
    return {
        session: {
            "uploaded": sorted(held | uploaded.get(session, set())),
            "enabled": [],
            "held": sorted(held),
            "deploys_known": False,
        }
        for session in sessions
    }


def build(root: Path, settings: dict | None = None) -> dict:
    settings_note = None
    if settings is None:
        try:
            settings, settings_note = automation_settings.read()
        except (OSError, ValueError) as error:
            settings, settings_note = None, f"the automation settings cannot be read: {error}"
    recorded = _recorded(root)
    tentative = _tentative(root, recorded["day"] if recorded else None)
    sessions = [s for s in (recorded, tentative) if s is not None]
    days = [s["day"] for s in sessions]
    accounts = []
    if settings is not None and settings["masters"].get("uploads"):
        for platform in automation_settings.PLATFORMS:
            for broker in automation_settings.BROKERS:
                row = settings["rows"][f"{platform}.{broker}"]
                book = row.get("list")
                if not row.get("upload") or book not in BOOKS:
                    continue
                state = (
                    quantiply_state(root, broker, book, days)
                    if platform == "quantiply"
                    else algotest_state(root, book, days)
                )
                for session in sessions:
                    st = state.get(session["day"]) if isinstance(state, dict) else None
                    if isinstance(st, dict):
                        picked = {p["name"] for p in session["books"].get(book, [])}
                        st["extra"] = [n for n in st["held"] if n not in picked]
                accounts.append(
                    {
                        "platform": platform,
                        "broker": broker,
                        "label": f"{PLATFORM_LABEL[platform]} · {BROKER_LABEL[broker]}",
                        "book": book,
                        "state": state,
                    }
                )
    return {
        "sessions": sessions,
        "accounts": accounts,
        "settings": settings_note,
        "paused_until": automation_settings.paused_for(settings, days[-1])
        if settings is not None and days
        else None,
    }
