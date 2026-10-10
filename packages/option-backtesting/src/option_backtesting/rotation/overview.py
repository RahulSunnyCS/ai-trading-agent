"""What the Rotation page's first screen needs besides the read-out numbers (BL-058 Phase 4): the
data-health checks and today's baskets. Read-only over the journal and the results store.

Every check carries a state (`ok` | `warn` | `bad` | `info`) and a sentence, so the page never has
to decide what a missing number means: a problem names its fix. Nothing here changes a stored
file.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from ..data.reference.loader import default_reference_data
from ..fyers.daily import data_dir
from . import base as base_mod
from . import journal, store
from .lists import LISTS, LOTS_PER, WARMUP
from .pick import FIRST_ENTRY
from .variants import is_buy, is_dir, is_wide, parts, variant_names

IST = ZoneInfo("Asia/Kolkata")
FIRST_ENTRY_DAY = date(2026, 10, 12)  # registered, BL-058 Phase 0
READOUT_DAYS = 60
ENTRY_DEADLINE = FIRST_ENTRY  # the same 09:17 the journal marks late entries by
UPDATE_DUE = time(19, 45)  # the nightly options-rotation-nightly job
UPDATE_OVERDUE = time(20, 30)  # past this a missing session is a problem, not a wait

FAMILY_LABEL = {
    "wide": "Widesl",
    "p80": "Widesl ₹80",
    "p100": "Widesl ₹100",
    "p250": "Widesl ₹250",
    "p320": "Widesl ₹320",
    "dir": "Dir ATM",
    "ditm1": "Dir ITM1",
    "buy": "Buy",
}


def describe(name: str) -> dict:
    """A variant name as the page shows it: index, family, kind, and start time as HH:MM."""
    index, family, tag = parts(name)
    kind = (
        "buy" if is_buy(name) else "dir" if is_dir(name) else "wide" if is_wide(name) else "other"
    )
    return {
        "name": name,
        "index": {"N": "NIFTY", "S": "SENSEX"}[index],
        "family": FAMILY_LABEL.get(family, family),
        "kind": kind,
        "start": f"{tag[:2]}:{tag[2:]}",
    }


def lists_spec() -> dict:
    """The registered lists: weights as percent and fit lookbacks, for the page's legend."""
    return {
        k: {
            "description": v.description,
            "weights": {w: round(x * 100) for w, x in v.weights.items()},
            "lookbacks": [{"days": d, "weight": round(w * 100)} for d, w in v.lookbacks],
        }
        for k, v in LISTS.items()
    }


def _trading_days(start: date, end: date, ref) -> list[date]:
    """Every exchange trading day in [start, end]."""
    out, d = [], start
    while d <= end:
        if ref.is_trading_day(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def expected_session(now: datetime, ref) -> date:
    """The latest trading day whose session the nightly update should have stored by `now`: today
    once 19:45 has passed on a trading day, else the trading day before."""
    d = now.date()
    if not (ref.is_trading_day(d) and now.time() >= UPDATE_DUE):
        d -= timedelta(days=1)
    while not ref.is_trading_day(d):
        d -= timedelta(days=1)
    return d


def _check(id_: str, label: str, value: str, state: str, detail: str = "") -> dict:
    return {"id": id_, "label": label, "value": value, "state": state, "detail": detail}


def health(root: Path | None = None, now: datetime | None = None) -> dict:
    """The data-health strip: the checks, and one overall state (the worst of them)."""
    root = root or data_dir()
    now = (now or datetime.now(IST)).astimezone(IST)
    today = now.date()
    names = variant_names()
    ref = default_reference_data()
    checks: list[dict] = []
    try:
        entries = journal.read(store.journal_path(root))
        unreadable = ""
    except journal.JournalCorrupt as error:
        entries, unreadable = [], str(error)
    days = store.read_days(root)

    # the latest session the nightly update stored, judged against the trading calendar: the last
    # finished session must be there, whatever the weekday arithmetic of calendar days says
    want = expected_session(now, ref)
    if days:
        last = max(days)
        behind = [d for d in _trading_days(last + timedelta(days=1), want, ref)]
        if not behind:
            state, note = "ok", ""
        elif now.date() == want and now.time() < UPDATE_OVERDUE:
            state, note = "info", f"{want} is stored by the 19:45 update"
        else:
            state = "bad"
            note = (
                f"no stored results for {', '.join(str(d) for d in behind[:3])}"
                f"{'...' if len(behind) > 3 else ''}: the 19:45 `options-rotation-nightly` job did "
                f"not store them (or data_quality excluded the day); run "
                f"`obt rotation update --day {behind[0]}`"
            )
        checks.append(_check("session", "Latest session", f"{last:%a %-d %b}", state, note))
        have = sum(1 for n in names if last in store.result_days(n, root))
        checks.append(
            _check(
                "results",
                "Results",
                f"{have} / {len(names)}",
                "ok" if have == len(names) else "bad",
                ""
                if have == len(names)
                else (
                    f"{len(names) - have} variants have no result for {last}: "
                    f"run `obt rotation update --day {last}`"
                ),
            )
        )
    else:
        checks.append(_check("session", "Latest session", "none", "bad", "no stored results"))

    # today's entry: expected on a trading day once 09:17 has passed
    trading = ref.is_trading_day(today)
    have_today = next((e for e in entries if e["day"] == today.isoformat()), None)
    if not entries and today < FIRST_ENTRY_DAY:
        checks.append(_check("entry", "Entry", f"first {FIRST_ENTRY_DAY:%a %-d %b} 09:16", "info"))
    elif have_today:
        on_time = bool(have_today.get("before_first_entry"))
        checks.append(
            _check(
                "entry",
                "Today's entry",
                f"{have_today['recorded_at'][11:19]} " + ("on time" if on_time else "LATE"),
                "ok" if on_time else "bad",
                ""
                if on_time
                else "recorded after 09:17: not a forward entry, excluded from the read-out",
            )
        )
    elif not trading:
        checks.append(_check("entry", "Today's entry", "no session today", "info"))
    elif now.time() < ENTRY_DEADLINE:
        checks.append(_check("entry", "Today's entry", "due 09:16", "info"))
    else:
        checks.append(
            _check(
                "entry",
                "Today's entry",
                "missing",
                "bad",
                "nothing recorded: no 09:15 VIX open, or the 09:16 job did not run",
            )
        )

    if unreadable:
        checks.append(
            _check(
                "chain", "Chain", "UNREADABLE", "bad", f"{unreadable}: run `obt rotation verify`"
            )
        )
    elif entries:
        e = entries[-1]
        src = e.get("vix_source", "?")
        fallback = src not in ("fyers", "given")
        checks.append(
            _check(
                "vix",
                "VIX open",
                f"{e['vix_open']} from {src}",
                "warn" if fallback else "ok",
                "read from the fallback source: Fyers had no token or no bar" if fallback else "",
            )
        )
        problems = journal.verify(store.journal_path(root))
        checks.append(
            _check(
                "chain",
                "Chain",
                f"{e['hash'][:8]}… intact" if not problems else "BROKEN",
                "ok" if not problems else "bad",
                "; ".join(problems[:2]),
            )
        )
    else:
        checks.append(_check("chain", "Chain", "0 entries", "info"))

    # a trading day, from the first entry on, that has no entry at all: never a zero, never silent
    if entries or today >= FIRST_ENTRY_DAY:
        through = today if now.time() >= ENTRY_DEADLINE else today - timedelta(days=1)
        have_days = {e["day"] for e in entries}
        missing = [
            d
            for d in _trading_days(FIRST_ENTRY_DAY, through, ref)
            if d.isoformat() not in have_days and d <= through
        ]
        if missing and not unreadable:
            checks.append(
                _check(
                    "missing",
                    "Entries",
                    f"{len(missing)} day(s) not recorded",
                    "bad",
                    "no entry for "
                    + ", ".join(str(d) for d in missing[-5:])
                    + ": those sessions are not part of the forward test",
                )
            )

    pending_base = base_mod.pending_days(root)
    checks.append(
        _check(
            "base",
            "Base",
            f"{len(base_mod.base_days(root))} days",
            "ok" if not pending_base else "warn",
            ""
            if not pending_base
            else (
                f"{len(pending_base)} day(s) lack the Dir ATM 09:24 leg: "
                "`obt rotation base --backfill`"
            ),
        )
    )
    order = {"ok": 0, "info": 0, "warn": 1, "bad": 2}
    worst = max((c["state"] for c in checks), key=lambda s: order[s], default="ok")
    return {"checks": checks, "state": worst, "as_of": now.isoformat(timespec="seconds")}


def baskets(root: Path | None = None, day: date | None = None) -> dict:
    """The picks of one journal entry (default the latest), per list, with each pick's composite,
    how many lists hold it, and what changed since the entry before."""
    root = root or data_dir()
    out: dict = {"entry": None, "lists": {}, "changed": {}, "readout_days": READOUT_DAYS}
    try:
        entries = journal.read(store.journal_path(root))
    except journal.JournalCorrupt as error:
        out["error"] = str(error)
        return out
    if day is not None:
        entries = [e for e in entries if e["day"] <= day.isoformat()]
    if not entries:
        return out
    e, prev = entries[-1], (entries[-2] if len(entries) > 1 else None)
    shared: dict[str, int] = {}
    for p in e["lists"].values():
        for n in p["core"] + p["buy"]:
            shared[n] = shared.get(n, 0) + 1
    out["entry"] = {
        "day": e["day"],
        "weekday": e["weekday"],
        "vix_open": e["vix_open"],
        "vix_band": e["vix_band"],
        "dte": e["dte"],
        "recorded_at": e["recorded_at"],
        "on_time": bool(e.get("before_first_entry")),
        "hash": e["hash"],
        "lots_per_strategy": e.get("lots_per_strategy", LOTS_PER),
    }
    for k, p in e["lists"].items():
        comp = p.get("composite", {})
        out["lists"][k] = {
            "core": [
                {**describe(n), "composite": comp.get(n), "shared_by": shared[n]} for n in p["core"]
            ],
            "buy": [
                {**describe(n), "composite": comp.get(n), "shared_by": shared[n]} for n in p["buy"]
            ],
            "overridden": bool(p.get("overridden")),
        }
        if prev:
            before = set(prev["lists"][k]["core"] + prev["lists"][k]["buy"])
            now_ = set(p["core"] + p["buy"])
            out["changed"][k] = {"added": sorted(now_ - before), "removed": sorted(before - now_)}
    out["warmup_days"] = WARMUP
    return out
