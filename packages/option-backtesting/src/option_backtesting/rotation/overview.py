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
from .variants import is_buy, is_dir, is_wide, parts, variant_names

IST = ZoneInfo("Asia/Kolkata")
FIRST_ENTRY_DAY = date(2026, 10, 12)  # registered, BL-058 Phase 0
READOUT_DAYS = 60
ENTRY_DEADLINE = time(9, 17)

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


def _check(id_: str, label: str, value: str, state: str, detail: str = "") -> dict:
    return {"id": id_, "label": label, "value": value, "state": state, "detail": detail}


def health(root: Path | None = None, now: datetime | None = None) -> dict:
    """The data-health strip: the checks, and one overall state (the worst of them)."""
    root = root or data_dir()
    now = (now or datetime.now(IST)).astimezone(IST)
    today = now.date()
    names = variant_names()
    entries = journal.read(store.journal_path(root))
    days = store.read_days(root)
    checks: list[dict] = []

    # the latest session the nightly update stored, and how complete its results are
    if days:
        last = max(days)
        age = (today - last).days
        have = sum(1 for n in names if last in store.result_days(n, root))
        state = "ok" if age <= 3 else "warn" if age <= 6 else "bad"
        checks.append(
            _check(
                "session",
                "Latest session",
                f"{last:%a %-d %b}",
                state,
                f"{age} day(s) ago; check the 19:45 `options-rotation-nightly` job"
                if state != "ok"
                else "",
            )
        )
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
    ref = default_reference_data()
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

    if entries:
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
    entries = journal.read(store.journal_path(root))
    out: dict = {"entry": None, "lists": {}, "changed": {}, "readout_days": READOUT_DAYS}
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


def next_entry_day(today: date) -> date:
    d = max(today, FIRST_ENTRY_DAY)
    ref = default_reference_data()
    while not ref.is_trading_day(d):
        d += timedelta(days=1)
    return d
