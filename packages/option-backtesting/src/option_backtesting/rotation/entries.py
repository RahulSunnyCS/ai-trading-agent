"""The journal as its readers see it: each day's entry with last evening's list in place of the
recorded Adaptive picks (owner, 2026-11-09: the evening's list is the source of truth, and
whoever reads a day's picks reads the evening's).

The journal file is never changed: it stays insert-only and hash-chained (`journal.py`). From
`EVENING_FROM`, when the list the evening message saved for a day (`result.read_tentative`) differs
from the entry's list C, `read` returns the entry with that list in list C and the recorded block
under `evening_override.recorded`; `raw` gives back the entry exactly as written, for anything that
checks a hash. Composites are kept for the names the two lists share (the evening's other picks
were never scored by that entry's ranking, so a reader that re-derives the ranking says the picks
differ, never guesses). From 2026-11-10 the morning entry already records the evening's list
(`pick.record`, `picks_from: evening`) and is read exactly as recorded, so in practice this changes
only 2026-11-09, picked at 09:16 before the rule; a list saved after an entry (a resend) changes
nothing.

Days before `EVENING_FROM` read exactly as recorded: the 09:16 pick was the list of record then.
"""

from __future__ import annotations

import copy
from datetime import date
from pathlib import Path

from . import journal, store

#: the first session whose evening list is the list of record
EVENING_FROM = date(2026, 11, 9)
#: the list the evening's saved lists stand for (Adaptive)
LIST_KEY = "C"
#: journal track -> the key of its list in the evening's saved lists (`result.save_tentative`)
EVENING_KEY = {None: "adaptive", "t1": "t1"}
OVERRIDE = "evening_override"


def evening_list(day: date | str, root: Path | None, track: str | None) -> dict | None:
    """The list the evening message saved for session `day` and `track` ({day, sent_on, core, buy,
    and dte / expiry_only when saved}), or None when there is none or it cannot be read."""
    from . import result

    key = EVENING_KEY.get(track)
    if key is None:
        return None
    doc = result.read_tentative(str(day), root).get(key)
    if not isinstance(doc, dict) or doc.get("day") != str(day):
        return None
    core, buy = doc.get("core"), doc.get("buy", [])
    if not isinstance(core, list) or not core or not isinstance(buy, list):
        return None
    if not all(isinstance(n, str) for n in [*core, *buy]):
        return None
    return doc


def effective(entry: dict, root: Path | None, track: str | None) -> dict:
    """`entry` with the evening's list in list C when that applies (module docstring), else
    `entry` itself (the same object)."""
    try:
        day = date.fromisoformat(str(entry.get("day")))
    except ValueError:
        return entry
    if day < EVENING_FROM:
        return entry
    if entry.get("picks_from") == "evening":
        # recorded from the evening's list at the time (`pick.record`): a list saved later (a
        # `result --force` resend re-ranks the next session) must never change it
        return entry
    block = (entry.get("lists") or {}).get(LIST_KEY)
    if not isinstance(block, dict):
        return entry
    evening = evening_list(day, root, track)
    if evening is None:
        return entry
    core, buy = list(evening["core"]), list(evening.get("buy") or [])
    if (list(block.get("core") or []), list(block.get("buy") or [])) == (core, buy):
        return entry
    out = copy.deepcopy(entry)
    recorded = copy.deepcopy(block)
    composite = {n: v for n, v in (block.get("composite") or {}).items() if n in {*core, *buy}}
    out["lists"][LIST_KEY] = {
        "core": core,
        "buy": buy,
        "overridden": False,  # unknown for the evening's list: `score.select`'s flag is a bool
        "composite": composite,
        **({"expiry_only": block["expiry_only"]} if "expiry_only" in block else {}),
    }
    out[OVERRIDE] = {"sent_on": evening.get("sent_on"), "recorded": recorded}
    return out


def raw(entry: dict) -> dict:
    """The entry exactly as the journal holds it (its hash checks), from an `effective` one."""
    if OVERRIDE not in entry:
        return entry
    out = copy.deepcopy(entry)
    out["lists"][LIST_KEY] = out.pop(OVERRIDE)["recorded"]
    return out


def read(
    root: Path | None = None, track: str | None = None, path: Path | None = None
) -> list[dict]:
    """Every entry of `track`'s journal (or the one at `path`), as readers see it. Raises what
    `journal.read` raises."""
    path = path or store.journal_path(root, track)
    return [effective(e, root, track) for e in journal.read(path)]


def track_of_path(path: Path, root: Path | None) -> str | None:
    """The track whose journal is at `path` (None for the live journal)."""
    for track in EVENING_KEY:
        if Path(path) == store.journal_path(root, track):
            return track
    return None


def evening_stamp(root: Path | None = None) -> tuple:
    """(name, mtime, size) of every saved evening list from `EVENING_FROM` on: part of the key of
    any cache over `read`, since a changed list changes what `read` returns without changing the
    journal."""
    from . import result

    folder = result.tentative_path("x", root).parent
    out = []
    try:
        paths = sorted(folder.glob("*.tentative.json"))
    except OSError:
        return ()
    for p in paths:
        if p.name[:10] < EVENING_FROM.isoformat():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        out.append((p.name, st.st_mtime_ns, st.st_size))
    return tuple(out)
