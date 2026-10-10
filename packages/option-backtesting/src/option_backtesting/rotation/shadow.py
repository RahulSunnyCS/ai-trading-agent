"""The shadow scoreboard: ideas kept for forward observation, against what they would have replaced.

Read-only over `TRADING_DATA_ROOT/rotation/` (the journal, the per-variant results and the trigger
files `triggers.py` writes each evening). Nothing here writes a file, changes a list, a weight, a
pick or a stored result, and nothing scores a candidate that has no nightly scoring: such a
candidate is returned as `not_scored`, with its registered definition.

Three parts, every figure an event minus a comparator, never a standalone profit:

1. **Triggers** (BL-083): for each trigger x template, event days, event average, placebo average,
   the difference and its day-clustered t, from `triggers.summary()` over the forward window (the
   maths is that function's; it is not repeated here), beside BL-083's research numbers.
2. **Override against the pick it displaces** (BL-083 phase 2, the two registered candidates: Dir
   after T1 and Dir after T4, on lists B and REF; all four lists are shown): on a forward day with
   a lead event, the earliest lead event fires a Dir on its own index at the event's entry minute
   and replaces the list's next not-yet-started core pick (one starting at least 15 minutes after
   the entry; skipped if the Widesl minimum would break). Reported per day: the Dir's result at the
   event minute minus the displaced pick's result, one lot and the list's lots. A day whose
   displaced pick has no stored result yet is `pending`, never zero. The random-time control of
   BL-083 is not recorded forward (the trigger files hold `event` and `placebo` simulations only);
   what is recorded is the time-matched placebo Dir (same minute, 20 earlier days with no event),
   shown as its own line and labelled as what it is.
3. **BL-081 forward candidates** (list A VIX drop-only; list C VIX x live Widesl): there is no
   nightly scoring for them. They are returned `not_scored` with their registered definitions.

"Forward" is the BL-058 window: sessions from 2026-10-12. A journal entry recorded after 09:17
(`before_first_entry` false) is not forward and is listed as `late_entry`, excluded from every
total.
"""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Any

from . import journal, store, triggers
from .lists import LISTS, LOTS_PER, MIN_WIDE_N
from .variants import is_wide, parts

#: BL-058 Phase 0: the forward window starts here; the evaluation point is 60 trading days.
FORWARD_FROM = date(2026, 10, 12)
JUDGED_AT = 60
#: last day BL-083's exploration set covers (2024-10-09 -> 2026-10-08); nothing later was seen.
RESEARCH_END = date(2026, 10, 8)

#: `triggers.summary()` shows t only from 5 event days (its `len(dm) > 4`); fewer is flagged thin.
MIN_T_DAYS = 5
#: ... and an event counts only with at least this many placebo days (the same bar, inline there).
MIN_PLACEBO_DAYS = 10

#: BL-083 Phase 0 / phase 2 (owner's rule, Log 2026-10-10): the leads are Dir after T1 and Dir
#: after T4; the earliest lead event of the day fires a Dir and replaces the next not-yet-started
#: core pick, one starting at least 15 minutes after the entry (research/bl083/override.py).
LEAD_TRIGGERS = ("T1", "T4")
LEAD_TEMPLATE = "dir"
CANDIDATE_LISTS = ("B", "REF")  # BL-083 Result: above both controls in 2024-26, so shadowed
MIN_LEAD_MINUTES = 15

_UNDERLYING_ORDER = {"NIFTY": 0, "SENSEX": 1}

TRIGGER_INFO: dict[str, dict[str, str]] = {
    "T1": {
        "label": "Pivot cross with trend",
        "definition": (
            "Spot crosses yesterday's P, R1 or S1 for the first time today, and the move since "
            "the open over the 14-session ATR has the cross's sign and is at least 0.3."
        ),
    },
    "T2": {
        "label": "VIX turn",
        "definition": (
            "VIX is up 2% or more on its 09:15 open and has fallen 1% or more in 30 minutes."
        ),
    },
    "T3": {
        "label": "Straddle turn, range stabilising",
        "definition": (
            "The 09:20 ATM straddle was up 5% on its 10:00 value, is now 3% below that high, and "
            "the last-30-minute range is below its trailing 252-session median."
        ),
    },
    "T4": {
        "label": "RSI exhaustion",
        "definition": "The 5-minute RSI(14) completes a block back below 70 or back above 30.",
    },
}
TEMPLATE_INFO: dict[str, str] = {"wide": "Widesl", "dir": "Dir", "buy": "Buy"}

#: BL-083 "Event study" table (Result, 2026-10-10, after the PR 163 review): event minus the same
#: template at the same minute on the 20 nearest non-event days, rupees per lot, t day-clustered.
#: explore = 2024-10-09 -> 2026-10-08, both indices; confirm = NIFTY 2022-01-03 -> 2024-10-08.
#: T3's cells are quoted by the table's own bound ("T3, all templates: |t| <= 0.6 / <= 1.4").
RESEARCH_EVENT_STUDY: dict[tuple[str, str], dict[str, Any]] = {
    ("T1", "dir"): dict(
        explore=754,
        explore_t=3.5,
        confirm=-20,
        confirm_t=-0.1,
        explore_days=130,
        explore_nifty=631,
        explore_nifty_t=2.6,
    ),
    ("T4", "dir"): dict(
        explore=403,
        explore_t=3.95,
        confirm=156,
        confirm_t=1.7,
        explore_days=312,
        explore_nifty=440,
        explore_nifty_t=3.4,
    ),
    ("T4", "buy"): dict(explore=84, explore_t=1.8, confirm=287, confirm_t=4.0),
    ("T1", "buy"): dict(explore=58, explore_t=0.7, confirm=-209, confirm_t=-2.5),
    ("T2", "wide"): dict(explore=-215, explore_t=-1.3, confirm=-139, confirm_t=-1.1),
    ("T2", "dir"): dict(explore=76, explore_t=0.4, confirm=-210, confirm_t=-1.4),
    ("T2", "buy"): dict(explore=-34, explore_t=-0.6, confirm=-157, confirm_t=-1.6),
    ("T4", "wide"): dict(explore=108, explore_t=1.3, confirm=-199, confirm_t=-2.5),
    ("T1", "wide"): dict(explore=199, explore_t=1.1, confirm=58, confirm_t=0.4),
    ("T3", "wide"): dict(explore_t_bound=0.6, confirm_t_bound=1.4),
    ("T3", "dir"): dict(explore_t_bound=0.6, confirm_t_bound=1.4),
    ("T3", "buy"): dict(explore_t_bound=0.6, confirm_t_bound=1.4),
}

#: BL-083 "Override rule" table (phase 2): gross of the list's picks over the window, rupees on the
#: list's 2 lots per strategy. gain = with override minus plain; dd = max drawdown with / without;
#: the two controls are the P90 of the gain of 200 random-time / random-day draws. Rupee amounts
#: are written in the backlog in lakh grouping (8,00,921 = 800921).
_OVERRIDE_COLUMNS = (
    "period", "list", "plain", "override", "gain", "dd", "dd_plain",
    "random_time_p90", "random_day_p90", "above_controls",
)  # fmt: skip
RESEARCH_OVERRIDE: list[dict[str, Any]] = [
    dict(zip(_OVERRIDE_COLUMNS, row, strict=True))
    for row in [
        ("explore", "A", 800921, 820902, 19981, -72667, -72667, 30383, 14562, False),
        ("explore", "B", 808532, 887921, 79389, -82706, -82706, 45514, 9604, True),
        ("explore", "C", 840846, 862340, 21494, -74104, -83817, 39352, 19822, False),
        ("explore", "REF", 720873, 775428, 54556, -86485, -88366, 27457, 23301, True),
        ("confirm", "A", 1220482, 1210009, -10473, -64181, -66632, 18416, 7124, False),
        ("confirm", "B", 1239935, 1213186, -26749, -63238, -64402, 14340, 10848, False),
        ("confirm", "C", 1158525, 1148553, -9972, -53755, -55282, 20366, 9425, False),
        ("confirm", "REF", 1013627, 1029895, 16268, -53378, -56329, 43828, 15424, False),
    ]
]
RESEARCH_PERIODS = {
    "explore": "2024-10-09 to 2026-10-08, both indices",
    "confirm": "NIFTY 2022-01-03 to 2024-10-08",
}

#: BL-081 "Read-out" and "2. The state-based versions": the two versions that passed every 2024-26
#: control, kept for forward shadow only. Quoted, not computed: no nightly scoring exists for them.
BL081_CANDIDATES: list[dict[str, Any]] = [
    {
        "id": "A_vix_since_open_drop_only",
        "list": "A",
        "title": "List A: VIX since open, drop only",
        "definition": (
            "At each checkpoint (10:30, 11:30, 12:30, 13:30) a pending pick of list A, one "
            "starting at least 15 minutes later, is dropped and not replaced when the pooled fit "
            "of its pool (strategy type x start band x index; 21 / 63 / 126 / 252-day windows, "
            "at least 5 matching days) on past days with the same VIX change since the 09:15 "
            "open (below -2%, flat, above +2%) is below zero rupees."
        ),
        "research": {
            "explore": "8,19,012 against a shuffle maximum of 8,03,484 and a random P90 of "
            "8,15,521 (+₹18k, +2.3%)",
            "confirm": "about -₹9.7k in 2022-24",
        },
    },
    {
        "id": "C_vix_x_live_widesl_free_swap_m50",
        "list": "C",
        "title": "List C: VIX x live Widesl, free swap, 50% blend",
        "definition": (
            "At each checkpoint (10:30, 11:30, 12:30, 13:30) the pending variants (both "
            "indices, starting at least 15 minutes later) are re-scored as 50% of the 09:16 "
            "composite's percentile plus 50% of the percentile of the pooled fit of their pool "
            "(strategy type x start band x index) in today's state: VIX change since the open "
            "(below -2%, flat, above +2%) x the running Widesl's P&L (up, flat or down by "
            "₹1,000). A pending pick that falls out of the top is swapped for the best-scoring "
            "unpicked pending variant of either index and type (free swap). The Widesl minimum "
            "and the lots never change."
        ),
        "research": {
            "explore": "8,50,880 against a shuffle maximum of 8,24,882 and a random P90 of "
            "8,05,607 (+₹10k, +1.2%)",
            "confirm": "about -₹9.8k in 2022-24",
        },
    },
]
BL081_REASON = (
    "No nightly scoring exists for this candidate. Scoring it needs each checkpoint hour's market "
    "state (VIX since open, the running Widesl's mark) and the pooled state fit from the stored "
    "results; the trigger scoring does not compute them. Nothing here scores it."
)


# ---- reading the stores (read-only) ----


def _read_gross(name: str, root: Path) -> dict[str, float]:
    """{day: gross} of one variant's results file (the file also has net, costs: both read-only)."""
    path = store.results_dir(root) / f"{name}.csv"
    if not path.exists():
        return {}
    out: dict[str, float] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            if r.get("gross") not in (None, ""):
                out[r["day"]] = float(r["gross"])
    return out


def _float(value: Any) -> float | None:
    try:
        return None if value in (None, "") else float(value)
    except (TypeError, ValueError):
        return None


def _hhmm_minutes(text: str) -> int:
    return int(text[:2]) * 60 + int(text[3:5])


def _start_minute(name: str) -> int:
    tag = parts(name)[2]
    return int(tag[:2]) * 60 + int(tag[2:])


def _inside(day: str, since: str, until: str | None) -> bool:
    return day >= since and (until is None or day <= until)


def _window(day_from: date | None, day_to: date | None) -> tuple[str, str | None]:
    """The forward window, narrowed by the caller; never earlier than the first forward day."""
    start = max(day_from, FORWARD_FROM) if day_from else FORWARD_FROM
    return start.isoformat(), day_to.isoformat() if day_to else None


# ---- 1. the trigger table ----


def trigger_table(root: Path, since: str, until: str | None) -> list[dict]:
    """Every trigger x template: forward event days, averages, difference, t (from 5 event days),
    and BL-083's research numbers. A cell with no scored events is a row with `days` 0."""
    scored = {(r["trigger"], r["template"]): r for r in triggers.summary(root, since, until)}
    events = [e for e in triggers.read_events(root) if _inside(e["day"], since, until)]
    rows = []
    for trig in triggers.TRIGGERS:
        seen = [e for e in events if e["trigger"] == trig]
        seen_days = {e["day"] for e in seen}
        for tpl in triggers.TEMPLATES:
            s = scored.get((trig, tpl))
            days = s["days"] if s else 0
            rows.append(
                {
                    "trigger": trig,
                    "template": tpl,
                    "label": TRIGGER_INFO[trig]["label"],
                    "template_label": TEMPLATE_INFO[tpl],
                    "candidate": trig in LEAD_TRIGGERS and tpl == LEAD_TEMPLATE,
                    "events_seen": len(seen),
                    "days_seen": len(seen_days),
                    "events": s["events"] if s else 0,
                    "days": days,
                    "event_avg": s["event"] if s else None,
                    "placebo_avg": s["placebo"] if s else None,
                    "diff": s["diff"] if s else None,
                    "t": s["t"] if s else None,
                    "thin": days < MIN_T_DAYS,
                    "unscored_events": len(seen) - (s["events"] if s else 0),
                    "research": RESEARCH_EVENT_STUDY.get((trig, tpl)),
                }
            )
    return rows


# ---- 2. the override against the pick it displaces ----


def _earliest_lead(events_of_day: list[dict]) -> dict | None:
    """The day's earliest lead-trigger event (either index); ties go to NIFTY, then T1."""
    leads = [e for e in events_of_day if e["trigger"] in LEAD_TRIGGERS]
    if not leads:
        return None
    return min(
        leads,
        key=lambda e: (
            int(e["stamp"]),
            _UNDERLYING_ORDER.get(e["underlying"], 9),
            LEAD_TRIGGERS.index(e["trigger"]),
        ),
    )


def displaced_pick(core: list[str], entry: str) -> tuple[str | None, str]:
    """(the core pick the override replaces, '') or (None, why not): the not-yet-started pick with
    the earliest start, at least MIN_LEAD_MINUTES after the entry minute, and the Widesl minimum
    must still hold without it (the Dir is not Widesl)."""
    after = _hhmm_minutes(entry) + MIN_LEAD_MINUTES
    pending = [n for n in core if _start_minute(n) >= after]
    if not pending:
        return None, (
            f"no core pick starts {MIN_LEAD_MINUTES} minutes or more after the entry minute "
            f"{entry}: the event is ignored"
        )
    out = min(pending, key=_start_minute)  # core order breaks a tie (min keeps the first)
    wide = sum(is_wide(n) for n in core if n != out)
    if wide < MIN_WIDE_N:
        return None, (
            f"replacing {out} would leave {wide} Widesl strategies, below the minimum {MIN_WIDE_N}"
        )
    return out, ""


def _row(day: str, key: str, event: dict, **more: Any) -> dict:
    base = {
        "day": day,
        "list": key,
        "candidate": key in CANDIDATE_LISTS,
        "trigger": event["trigger"],
        "underlying": event["underlying"],
        "entry": event["entry"],
        "detail": event.get("detail") or None,
        "displaced": None,
        "displaced_start": None,
        "displaced_gross": None,
        "dir_net": None,
        "diff_lot": None,
        "diff_basket": None,
        "placebo_dir": None,
        "placebo_days": 0,
        "control_diff_basket": None,
    }
    base.update(more)
    return base


NO_ENTRY = "no journal entry for this day, so the pick it would displace is unknown"


def override_days(
    root: Path,
    since: str,
    until: str | None,
    entries: list[dict],
    no_entry_reason: str = NO_ENTRY,
) -> list[dict]:
    """One row per forward day with a lead event and per list (all four lists), with its status:
    scored | pending | not_applied | late_entry | no_entry."""
    events = [e for e in triggers.read_events(root) if _inside(e["day"], since, until)]
    by_day: dict[str, list[dict]] = {}
    for e in events:
        by_day.setdefault(e["day"], []).append(e)
    event_net: dict[tuple, float] = {}
    placebo: dict[tuple, list[float]] = {}
    for r in triggers.read_sims(root):
        if r["template"] != LEAD_TEMPLATE:
            continue
        net = _float(r["net"])
        if net is None:
            continue
        key = (r["underlying"], r["ref_day"], r["trigger"])
        if r["kind"] == "event":
            event_net[key] = net
        elif r["kind"] == "placebo":
            placebo.setdefault(key, []).append(net)
    entry_of = {e["day"]: e for e in entries}
    gross: dict[str, dict[str, float]] = {}
    rows: list[dict] = []
    for day in sorted(by_day):
        ev = _earliest_lead(by_day[day])
        if ev is None:
            continue
        entry = entry_of.get(day)
        for key in LISTS:
            if entry is None or key not in entry.get("lists", {}):
                rows.append(_row(day, key, ev, status="no_entry", reason=no_entry_reason))
                continue
            if not entry.get("before_first_entry", False):
                rows.append(
                    _row(
                        day,
                        key,
                        ev,
                        status="late_entry",
                        reason="the entry was recorded after 09:17: not forward, excluded",
                    )  # fmt: skip
                )
                continue
            core = list(entry["lists"][key].get("core") or [])
            name, why = displaced_pick(core, ev["entry"])
            if name is None:
                rows.append(_row(day, key, ev, status="not_applied", reason=why))
                continue
            start = f"{_start_minute(name) // 60:02d}:{_start_minute(name) % 60:02d}"
            if name not in gross:
                gross[name] = _read_gross(name, root)
            g = gross[name].get(day)
            net = event_net.get((ev["underlying"], day, ev["trigger"]))
            if g is None or net is None:
                missing = (
                    f"{name} has no stored result for {day} yet"
                    if g is None
                    else f"the Dir simulation at {ev['entry']} is not stored yet"
                )
                rows.append(
                    _row(
                        day,
                        key,
                        ev,
                        status="pending",
                        reason=missing,
                        displaced=name,
                        displaced_start=start,
                        displaced_gross=g,
                        dir_net=net,
                    )  # fmt: skip
                )
                continue
            diff = net - g
            pl = placebo.get((ev["underlying"], day, ev["trigger"]), [])
            ctrl = None
            pl_mean = None
            if len(pl) >= MIN_PLACEBO_DAYS:
                pl_mean = sum(pl) / len(pl)
                ctrl = LOTS_PER * (pl_mean - g)
            rows.append(
                _row(
                    day,
                    key,
                    ev,
                    status="scored",
                    reason="",
                    displaced=name,
                    displaced_start=start,
                    displaced_gross=round(g, 2),
                    dir_net=round(net, 2),
                    diff_lot=round(diff, 2),
                    diff_basket=round(LOTS_PER * diff, 2),
                    placebo_dir=None if pl_mean is None else round(pl_mean, 2),
                    placebo_days=len(pl),
                    control_diff_basket=None if ctrl is None else round(ctrl, 2),
                )  # fmt: skip
            )
    return rows


def list_summary(key: str, rows: list[dict], forward_days: int) -> dict:
    """Totals of one list's rows, and the running sums the chart draws (scored days only)."""
    mine = [r for r in rows if r["list"] == key]
    scored = [r for r in mine if r["status"] == "scored"]
    series = []
    cum = cum_ctrl = 0.0
    n_ctrl = 0
    for r in scored:
        cum += r["diff_basket"]
        point = {"day": r["day"], "diff_basket": r["diff_basket"], "cum_basket": round(cum, 2)}
        if r["control_diff_basket"] is not None:
            cum_ctrl += r["control_diff_basket"]
            n_ctrl += 1
            point["control_diff_basket"] = r["control_diff_basket"]
            point["cum_control"] = round(cum_ctrl, 2)
        series.append(point)

    def count(status: str) -> int:
        return sum(r["status"] == status for r in mine)

    return {
        "list": key,
        "candidate": key in CANDIDATE_LISTS,
        "description": LISTS[key].description,
        "forward_days": forward_days,
        "event_days": len(mine),
        "scored": len(scored),
        "pending": count("pending"),
        "not_applied": count("not_applied"),
        "late_entry": count("late_entry"),
        "no_entry": count("no_entry"),
        "total_basket": round(cum, 2) if scored else None,
        "mean_lot": round(sum(r["diff_lot"] for r in scored) / len(scored), 2) if scored else None,
        "beat_share": sum(r["diff_basket"] > 0 for r in scored) / len(scored) if scored else None,
        "control_days": n_ctrl,
        "control_total_basket": round(cum_ctrl, 2) if n_ctrl else None,
        "series": series,
    }


# ---- the report ----


def _journal(root: Path) -> tuple[list[dict], dict]:
    path = store.journal_path(root)
    info: dict[str, Any] = {
        "exists": path.exists(), "entries": 0, "forward": 0, "late": 0,
        "chain_intact": None, "error": None,
    }  # fmt: skip
    try:
        entries = journal.read(path)
    except journal.JournalCorrupt as error:
        info["error"] = str(error)
        return [], info
    entries = [e for e in entries if e.get("day", "") >= FORWARD_FROM.isoformat()]
    info["entries"] = len(entries)
    info["forward"] = sum(bool(e.get("before_first_entry")) for e in entries)
    info["late"] = info["entries"] - info["forward"]
    if path.exists():
        info["chain_intact"] = not journal.verify(path)
    return entries, info


def report(root: Path, day_from: date | None = None, day_to: date | None = None) -> dict[str, Any]:
    """Everything the Shadow scoreboard shows, from the stored files under `root` (read-only)."""
    since, until = _window(day_from, day_to)
    entries, jinfo = _journal(root)
    entries = [e for e in entries if _inside(e["day"], since, until)]
    forward_days = sum(bool(e.get("before_first_entry")) for e in entries)

    tdir = triggers.triggers_dir(root)
    scored_days = sorted(
        {
            d
            for (_u, d) in triggers.read_scored(root)
            if d >= since and (until is None or d <= until)
        }
    )
    event_days = {e["day"] for e in triggers.read_events(root) if _inside(e["day"], since, until)}
    sessions = sorted(set(scored_days) | event_days)  # an event day is a scored day
    if jinfo["error"] is None:
        rows = override_days(root, since, until, entries)
    else:
        rows = override_days(
            root, since, until, [], f"the journal cannot be read ({jinfo['error']})"
        )
    return {
        "forward_from": FORWARD_FROM.isoformat(),
        "research_end": RESEARCH_END.isoformat(),
        "window": {"from": since, "to": until},
        "banner": {
            "sessions": len(sessions),
            "with_event": len(event_days),
            "judged_at": JUDGED_AT,
            "remaining": max(0, JUDGED_AT - len(sessions)),
            "first_day": sessions[0] if sessions else None,
            "last_day": sessions[-1] if sessions else None,
        },
        "files": {
            "events": (tdir / "events.csv").exists(),
            "sims": (tdir / "sims.csv").exists(),
            "scored_days": (tdir / "scored_days.csv").exists(),
            "journal": jinfo["exists"],
        },
        "journal": jinfo,
        "triggers": trigger_table(root, since, until),
        "trigger_info": [{"trigger": t, **TRIGGER_INFO[t]} for t in triggers.TRIGGERS],
        "override": {
            "rule": {
                "triggers": list(LEAD_TRIGGERS),
                "template": LEAD_TEMPLATE,
                "candidate_lists": list(CANDIDATE_LISTS),
                "min_lead_minutes": MIN_LEAD_MINUTES,
                "min_widesl": MIN_WIDE_N,
                "lots_per_strategy": LOTS_PER,
                "basis": "gross",
            },
            "lists": [list_summary(k, rows, forward_days) for k in LISTS],
            "days": rows,
            "controls": {
                "random_time": {
                    "status": "not_recorded",
                    "reason": (
                        "The research's control, the same Dir at a random minute between 10:31 "
                        "and 14:00 on the same days, is not recorded forward: the trigger files "
                        "hold event and placebo simulations only."
                    ),
                },
                "placebo": {
                    "status": "recorded",
                    "reason": (
                        "The time-matched placebo: the same Dir at the same minute on the 20 "
                        "earlier days with no event, replacing the same pick. It is the trigger "
                        "table's comparator, not the research's random-time control."
                    ),
                    "min_days": MIN_PLACEBO_DAYS,
                },
            },
        },
        "research": {
            "periods": RESEARCH_PERIODS,
            "override": RESEARCH_OVERRIDE,
            "applied": "54 to 57 of 302 events applied in the exploration set and 56 to 64 of 395 "
            "in the confirmation set; the rest had no pending pick or would break the Widesl "
            "minimum.",
            "note": "Two years of one regime; the last two years decide under the owner's rule, "
            "the 2022-24 set is information. The two leads were chosen from 12 cells in the "
            "same two years they are judged on.",
        },
        "candidates": [
            {**c, "status": "not_scored", "reason": BL081_REASON} for c in BL081_CANDIDATES
        ],
    }
