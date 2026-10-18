"""Lot plans tracked forward (BL-135, owner 2026-10-18): what each book would make under three ways
of spreading its lots over the day's Adaptive picks, from Mon 2026-10-19.

Two books, each read from its own journal: Core (list C of the live journal, Core-298) and T1
(list C of the T1 track's journal, BL-113). Three plans, Buy add-on excluded from every one:

* **As picked** (the comparator): 1 lot on each of the three core picks.
* **Dir Boost** (BL-133): an expiry day is As picked; on any other day the Dir pick takes 2 lots
  (4 lots); on a three-Widesl day the three Widesl at 1 lot plus the best unpicked Dir at 1 lot.
* **Duo** (BL-134): W1 (the Widesl pick with the higher recorded composite, ties by name) and the
  Dir (the best unpicked Dir on a three-Widesl day), 2 lots each on other days, 2 + 1 on an expiry
  day. The other Widesl pick(s) are not traded.

An expiry day is one where the entry's own weekday days-to-expiry label is "0" for NIFTY or SENSEX.
The best unpicked Dir is the 09:16 message's optional Dir line (`pick.next_best`), re-derived here
from the results stored before the day with the very calls the pick made; it must reproduce the
entry's picks, inputs digest and universe, or the day is `unverified` and left out of the totals.

Money: gross = lots x the stored one-lot gross; brokerage = Rs 20 x 1.18 per order, 2 orders x the
stored `n_trades`, once per strategy placed; net = gross - brokerage. A needed result not stored yet
makes the day `waiting` (figures withheld, never zero); an entry recorded at or after 09:17 is
`late`. Only `scored` days count, for all three plans at once. The read-out (registered in BL-135
Phase 0) judges the first 60 scored days.

Read-only: nothing here writes to the journal, the results, a list or a message.
"""

from __future__ import annotations

import csv
import hashlib
import math
import threading
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from ..fyers.daily import data_dir
from . import journal, pick, store
from .dte import entry_basis, entry_labels, recorded_labels
from .lists import WARMUP
from .readout import block_bootstrap_mean, max_drawdown
from .variants import is_dir, is_wide, track_names, variant_names

IST = ZoneInfo("Asia/Kolkata")

#: the first forward day (owner, 2026-10-18); no entry before it is ever read
FORWARD_FROM = date(2026, 10, 19)
#: book id -> the parallel track whose journal it reads (None = the live journal)
BOOKS: dict[str, str | None] = {"core": None, "t1": "t1"}
LIST_KEY = "C"  # Adaptive

PLANS: tuple[str, ...] = ("as_picked", "dir_boost", "duo")
PLAN_NAMES: dict[str, str] = {"as_picked": "As picked", "dir_boost": "Dir Boost", "duo": "Duo"}
COMPARATOR = "as_picked"

BROKERAGE_PER_ORDER = 20.0
GST = 1.18
ORDERS_PER_TRADE = 2

READOUT_DAYS = 60
BOOT_SEED = 20261019

STATUSES: tuple[str, ...] = ("scored", "waiting", "late", "unverified")


class LotPlanError(ValueError):
    """A request the builder cannot answer (an unknown book)."""


# --- the plans (pure) ---------------------------------------------------------------------------


def is_expiry(labels: dict[str, str]) -> bool:
    """True when NIFTY or SENSEX expires today ({'NIFTY': '0', ...} on the weekday basis)."""
    return str(labels.get("NIFTY")) == "0" or str(labels.get("SENSEX")) == "0"


def w1(core: list[str], composite: dict[str, float]) -> str | None:
    """The core Widesl pick with the higher recorded composite (ties by name)."""
    wide = [n for n in core if is_wide(n)]
    if not wide:
        return None
    return min(wide, key=lambda n: (-float(composite.get(n, -math.inf)), n))


def dir_pick(core: list[str]) -> str | None:
    """The core Dir pick (Dir ATM or Dir ITM1), or None on a three-Widesl day."""
    return next((n for n in core if is_dir(n)), None)


def needs_runner_up(core: list[str], expiry: bool) -> dict[str, bool]:
    """Which plans need the best unpicked Dir today: only on a three-Widesl day; Dir Boost not on
    an expiry day (it is As picked then)."""
    three_wide = dir_pick(core) is None
    return {"as_picked": False, "dir_boost": three_wide and not expiry, "duo": three_wide}


def plan_lots(
    plan: str,
    core: list[str],
    composite: dict[str, float],
    expiry: bool,
    runner_up_dir: str | None = None,
) -> dict[str, int] | None:
    """{strategy: lots} for one plan on one day, in pick order. None when the plan needs the best
    unpicked Dir and it is not known (never guessed)."""
    if plan == "as_picked":
        return {n: 1 for n in core}
    d = dir_pick(core)
    if d is None and needs_runner_up(core, expiry)[plan]:
        if runner_up_dir is None:
            return None
        d = runner_up_dir
    if plan == "dir_boost":
        if expiry:
            return {n: 1 for n in core}
        out = {n: 1 for n in core}
        out[d] = out.get(d, 0) + 1  # a picked Dir doubles; a runner-up Dir is added at 1 lot
        return out
    if plan == "duo":
        top = w1(core, composite)
        if top is None or d is None:
            return None
        return {top: 2, d: 1 if expiry else 2}
    raise LotPlanError(f"unknown plan {plan!r}")


def brokerage(n_trades: int) -> float:
    """Estimated brokerage of one strategy placed: 2 orders per trade, Rs 20 + 18 % GST each."""
    return ORDERS_PER_TRADE * n_trades * BROKERAGE_PER_ORDER * GST


def plan_money(lots: dict[str, int], results: dict[str, dict | None]) -> dict | None:
    """{gross, brokerage, net} of a plan's lots from one-lot results ({name: {gross, n_trades}}),
    or None when any is missing."""
    gross = cost = 0.0
    for name, n in lots.items():
        r = results.get(name)
        if r is None:
            return None
        gross += n * r["gross"]
        cost += brokerage(r["n_trades"])
    return {"gross": round(gross, 2), "brokerage": round(cost, 2), "net": round(gross - cost, 2)}


# --- reading ------------------------------------------------------------------------------------


def _number(text: str | None) -> float | None:
    try:
        value = float(text) if text not in (None, "") else math.nan
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def read_results(name: str, root: Path) -> dict[date, dict]:
    """{day: {gross, n_trades}} of one variant (Core or a track's, `store.result_path`). A row
    without a parseable gross or trade count is left out: missing, never zero."""
    path = store.result_path(name, root)
    if not path.exists():
        return {}
    out: dict[date, dict] = {}
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                day = date.fromisoformat(r["day"])
            except (KeyError, ValueError):
                continue
            gross, trades = _number(r.get("gross")), _number(r.get("n_trades"))
            if gross is None or trades is None:
                continue
            out[day] = {"gross": round(gross, 2), "n_trades": int(trades)}
    return out


def book_names(book: str) -> list[str]:
    """The universe the book's pick ranked: Core-298, plus the track's variants for T1."""
    track = _track(book)
    return variant_names() + (track_names(track) if track else [])


def _track(book: str) -> str | None:
    if book not in BOOKS:
        raise LotPlanError(f"book must be one of {', '.join(BOOKS)}, not {book!r}")
    return BOOKS[book]


class HistorySource:
    """The stored results read once per request, sliced per day into exactly the `pick.History`
    that `pick.load_history(day, root, names, basis)` returns (same rows, same checks, same
    digest; a test holds them equal). Reading every variant file once instead of once per day
    keeps a request under the proxy's timeout when several days need a re-derivation."""

    def __init__(self, root: Path, names: list[str]) -> None:
        self.root, self.names = root, names
        self._matrix: store.Matrix | None = None
        self._attrs: dict[str, dict[date, dict[str, str]]] = {}

    def history(self, day: date, basis: str = "weekdays") -> pick.History:
        if not self.names:
            raise pick.PickError("no variant strategy files found")
        if self._matrix is None:
            self._matrix = store.load_matrix(self.names, self.root)
        if basis not in self._attrs:
            self._attrs[basis] = store.read_days(self.root, basis)
        m, attrs = self._matrix, self._attrs[basis]
        keep = [i for i, d in enumerate(m.days) if d < day and d in attrs]
        days = [m.days[i] for i in keep]
        if len(days) < WARMUP:
            raise pick.PickError(f"only {len(days)} days of results (need {WARMUP})")
        prev = pick.previous_data_day(self.root, day)
        if days[-1] != prev:
            raise pick.PickError(
                f"results end {days[-1]} but the last collected trading day is {prev}"
            )
        values = m.values[keep]
        h = hashlib.sha256()
        for i, d in enumerate(days):
            a = attrs[d]
            h.update(
                f"{d}|{a['weekday']}|{a['vix_band']}|{a['dte_n']}|{a['dte_s']}|".encode()
                + ",".join(f"{v:.2f}" for v in values[i]).encode()
                + b"\n"
            )
        return pick.History(
            days,
            list(m.names),
            values,
            [attrs[d]["weekday"] for d in days],
            [attrs[d]["vix_band"] for d in days],
            [attrs[d]["dte_n"] for d in days],
            [attrs[d]["dte_s"] for d in days],
            h.hexdigest(),
        )


_rederive_lock = threading.Lock()
#: (root, book, day, entry hash) -> a verified re-derivation. The results before a day are never
#: rewritten, so a verified answer stays true; a failed one is not cached (it may be fixed).
_rederive_cache: dict[tuple, dict] = {}


def rederive_runner_up(
    entry: dict,
    root: Path,
    names: list[str],
    book: str = "core",
    source: HistorySource | None = None,
) -> dict:
    """The best unpicked Dir of list C for the entry's day, as the 09:16 message gave it:
    {verified, dir, note}. Re-runs the pick's history load, `pick.score_history` and
    `pick.next_best` on the results before the day with the entry's VIX open, labels and rule;
    verified only when the re-derived picks, the inputs digest and the universe all equal the
    entry's."""
    key = (str(root), book, entry.get("day"), entry.get("hash"))
    with _rederive_lock:
        hit = _rederive_cache.get(key)
    if hit is not None:
        return hit
    day = date.fromisoformat(str(entry["day"]))
    try:
        hist = (source or HistorySource(root, names)).history(day, entry_basis(entry))
    except pick.PickError as error:
        return {"verified": False, "dir": None, "note": f"cannot re-derive: {error}"}
    labels = recorded_labels(entry)
    dte_in = {"dte_n": labels["NIFTY"], "dte_s": labels["SENSEX"]}
    vix = _number(str(entry.get("vix_open")))
    rule = entry.get("expiry_only")
    recorded = (entry.get("lists") or {}).get(LIST_KEY) or {}
    again = pick.score_history(hist, day, vix, dte_in, expiry_only=rule).get(LIST_KEY, {})
    problems = []
    if any(again.get(k) != recorded.get(k) for k in ("core", "buy", "overridden")):
        problems.append("the re-derived picks differ from the entry")
    if entry.get("inputs_sha") and hist.digest != entry["inputs_sha"]:
        problems.append("the stored results before the day differ from those the pick read")
    if entry.get("universe") and pick.universe_fingerprint(names) != entry["universe"]:
        problems.append("the strategy universe differs from the one the pick ranked")
    best = pick.next_best(hist, day, vix, dte_in, expiry_only=rule).get(LIST_KEY) or {}
    if not problems and best.get("dir") is None:
        problems.append("no unpicked Dir to add")
    out = {
        "verified": not problems,
        "dir": None if problems else best["dir"],
        "note": "; ".join(problems) or None,
    }
    if out["verified"]:
        with _rederive_lock:
            _rederive_cache[key] = out
    return out


# --- one day ------------------------------------------------------------------------------------


def day_row(
    entry: dict,
    book: str,
    root: Path,
    names: list[str],
    results: dict[str, dict[date, dict]],
    source: HistorySource | None = None,
) -> dict:
    """One forward entry as a row: its picks, each plan's lots and figures, and the day status."""
    day = date.fromisoformat(str(entry["day"]))
    labels = entry_labels(entry)
    expiry = is_expiry(labels)
    block = (entry.get("lists") or {}).get(LIST_KEY) or {}
    core = list(block.get("core") or [])
    composite = {k: float(v) for k, v in (block.get("composite") or {}).items()}
    late = not entry.get("before_first_entry")
    top = w1(core, composite)
    picks = [
        {
            "name": n,
            "family": "dir" if is_dir(n) else "widesl" if is_wide(n) else "other",
            "composite": composite.get(n),
            "w1": n == top,
        }
        for n in core
    ]
    runner = None
    notes: list[str] = []
    malformed = len(core) != 3 or top is None
    if malformed:
        notes.append("the entry does not hold three core picks with a Widesl")
    need = needs_runner_up(core, expiry)
    if not malformed and any(need.values()):
        runner = rederive_runner_up(entry, root, names, book, source)
        if not runner["verified"]:
            notes.append(runner["note"] or "the best unpicked Dir could not be verified")

    def result(name: str) -> dict | None:
        if name not in results:
            results[name] = read_results(name, root)
        return results[name].get(day)

    plans: dict[str, dict] = {}
    for plan in PLANS:
        lots = (
            None
            if malformed
            else plan_lots(plan, core, composite, expiry, (runner or {}).get("dir"))
        )
        if lots is None:
            plans[plan] = {
                "lots": [],
                "total_lots": None,
                "status": "unverified",
                "gross": None,
                "brokerage": None,
                "net": None,
            }
            continue
        rows = {n: result(n) for n in lots}
        money = plan_money(lots, rows)
        plans[plan] = {
            "lots": [
                {
                    "name": n,
                    "lots": k,
                    "gross": None if rows[n] is None else rows[n]["gross"],
                    "n_trades": None if rows[n] is None else rows[n]["n_trades"],
                    "runner_up": runner is not None and n == runner.get("dir") and n not in core,
                }
                for n, k in lots.items()
            ],
            "total_lots": sum(lots.values()),
            "status": "scored" if money else "waiting",
            "gross": money["gross"] if money else None,
            "brokerage": money["brokerage"] if money else None,
            "net": money["net"] if money else None,
        }
    plan_status = {p["status"] for p in plans.values()}
    if late:
        status = "late"
    elif "unverified" in plan_status:
        status = "unverified"
    elif "waiting" in plan_status:
        status = "waiting"
    else:
        status = "scored"
    if late:
        notes.insert(0, f"recorded at {str(entry.get('recorded_at', '?'))[11:19]}, after 09:17")
    if status == "waiting":
        missing = sorted(
            {x["name"] for p in plans.values() for x in p["lots"] if x["gross"] is None}
        )
        notes.append(f"waiting for the result of {', '.join(missing)}")
    return {
        "day": day.isoformat(),
        "book": book,
        "weekday": entry.get("weekday") or day.strftime("%a"),
        "expiry": expiry,
        "dte": labels,
        "expiry_only": entry.get("expiry_only"),
        "recorded_at": entry.get("recorded_at"),
        "status": status,
        "note": "; ".join(notes) or None,
        "picks": picks,
        "runner_up_dir": runner,
        "plans": plans,
    }


# --- the book -----------------------------------------------------------------------------------


def _plan_summary(rows: list[dict], plan: str) -> dict:
    net = np.array([r["plans"][plan]["net"] for r in rows], dtype=float)
    gross = np.array([r["plans"][plan]["gross"] for r in rows], dtype=float)
    cost = np.array([r["plans"][plan]["brokerage"] for r in rows], dtype=float)
    lots = np.array([r["plans"][plan]["total_lots"] for r in rows], dtype=float)
    n = len(rows)
    worst = int(np.argmin(net)) if n else None
    return {
        "plan": plan,
        "name": PLAN_NAMES[plan],
        "days": n,
        "lot_days": int(lots.sum()),
        "mean_lots": float(lots.mean()) if n else None,
        "gross": round(float(gross.sum()), 2),
        "brokerage": round(float(cost.sum()), 2),
        "net": round(float(net.sum()), 2),
        "gross_per_day": float(gross.mean()) if n else None,
        "brokerage_per_day": float(cost.mean()) if n else None,
        "net_per_day": float(net.mean()) if n else None,
        "max_drawdown": max_drawdown(net) if n else None,
        "worst_day": (
            {"day": rows[worst]["day"], "net": float(net[worst])} if worst is not None else None
        ),
    }


def _dd_per_lot(net: np.ndarray, lots: np.ndarray) -> float:
    return max_drawdown(net) / float(lots.mean())


def readout(rows: list[dict]) -> dict:
    """The registered read-out over the first READOUT_DAYS scored days: each plan minus As picked,
    net per day, with the 90 % block bootstrap interval and drawdown per lot. `n/a` before then."""
    n = len(rows)
    if n < READOUT_DAYS:
        return {"status": "n/a", "days": n, "needed": READOUT_DAYS}
    judged = rows[:READOUT_DAYS]

    def series(plan: str, key: str) -> np.ndarray:
        return np.array([r["plans"][plan][key] for r in judged], dtype=float)

    ref_net, ref_lots = series(COMPARATOR, "net"), series(COMPARATOR, "total_lots")
    ref_dd = _dd_per_lot(ref_net, ref_lots)
    plans = {}
    for plan in PLANS:
        if plan == COMPARATOR:
            continue
        net, lots = series(plan, "net"), series(plan, "total_lots")
        mean, lo, hi = block_bootstrap_mean(net - ref_net, seed=BOOT_SEED)
        dd = _dd_per_lot(net, lots)
        beats = bool(lo > 0 and dd >= ref_dd)
        plans[plan] = {
            "name": PLAN_NAMES[plan],
            "diff_per_day": mean,
            "lo90": lo,
            "hi90": hi,
            "dd_per_lot": dd,
            "comparator_dd_per_lot": ref_dd,
            "verdict": "beats" if beats else "costs" if hi < 0 else "inconclusive",
        }
    out: dict = {
        "status": "judged",
        "days": n,
        "judged_days": READOUT_DAYS,
        "from": judged[0]["day"],
        "to": judged[-1]["day"],
        "plans": plans,
    }
    if n > READOUT_DAYS:  # descriptive only: the verdict above does not move
        later = rows[READOUT_DAYS:]
        out["after_readout"] = {
            "days": len(later),
            "diff_per_day": {
                p: float(
                    np.mean([r["plans"][p]["net"] - r["plans"][COMPARATOR]["net"] for r in later])
                )
                for p in PLANS
                if p != COMPARATOR
            },
        }
    return out


def _message(today: date, counts: dict[str, int], entries: int) -> str | None:
    if counts["scored"]:
        return None
    if today < FORWARD_FROM or not entries:
        return "Tracking starts Mon 19 Oct 2026: no forward day has been recorded yet."
    waiting = counts["waiting"]
    return (
        f"No forward day scored yet: {entries} recorded"
        + (f", {waiting} waiting for results" if waiting else "")
        + "."
    )


def build(
    book: str = "core",
    root: Path | None = None,
    names: list[str] | None = None,
    today: date | None = None,
) -> dict:
    """Every forward entry of the book as a row, the per-plan summary over the scored days, the
    cumulative net series and the read-out. Raises journal.JournalCorrupt when the journal cannot
    be read (a partial journal shown as the whole record would be worse)."""
    track = _track(book)
    root = root or data_dir()
    names = names if names is not None else book_names(book)
    today = today or datetime.now(IST).date()
    path = store.journal_path(root, track)
    entries = [
        e
        for e in journal.read(path)
        if date.fromisoformat(str(e.get("day"))) >= FORWARD_FROM
        and LIST_KEY in (e.get("lists") or {})
    ]
    entries.sort(key=lambda e: e["day"])
    results: dict[str, dict[date, dict]] = {}
    source = HistorySource(root, names)  # read lazily, only when a day needs a re-derivation
    rows = [day_row(e, book, root, names, results, source) for e in entries]
    scored = [r for r in rows if r["status"] == "scored"]
    counts = {s: sum(r["status"] == s for r in rows) for s in STATUSES}
    cumulative, running = [], dict.fromkeys(PLANS, 0.0)
    for r in scored:
        for p in PLANS:
            running[p] += r["plans"][p]["net"]
        cumulative.append({"day": r["day"], **{p: round(running[p], 2) for p in PLANS}})
    problems = journal.verify(path)
    latest = rows[-1] if rows else None
    return {
        "book": book,
        "list": LIST_KEY,
        "forward_from": FORWARD_FROM.isoformat(),
        "today": today.isoformat(),
        "plans": [
            {**_plan_summary(scored, p), "lots_today": _lots_on(latest, p, today)} for p in PLANS
        ],
        "comparator": COMPARATOR,
        "counts": {**counts, "entries": len(rows)},
        "cumulative": cumulative,
        "rows": rows,
        "readout": readout(scored),
        "chain": {"intact": not problems, "problems": problems[:3]},
        "message": _message(today, counts, len(rows)),
        "settings": {
            "brokerage_per_order": BROKERAGE_PER_ORDER,
            "gst": GST,
            "orders_per_trade": ORDERS_PER_TRADE,
            "readout_days": READOUT_DAYS,
            "bootstrap_seed": BOOT_SEED,
            "bootstrap_block_days": 5,
            "bootstrap_resamples": 2000,
            "interval": 0.90,
            "basis": "net = one-lot gross x lots - brokerage",
        },
    }


def _lots_on(row: dict | None, plan: str, today: date) -> int | None:
    """The plan's lots for today's entry (None when today has no entry or they are unknown)."""
    if row is None or row["day"] != today.isoformat():
        return None
    return row["plans"][plan]["total_lots"]


# --- terminal -----------------------------------------------------------------------------------


def _inr(x: float | None) -> str:
    return "-" if x is None else f"{x:+,.0f}"


def render(r: dict, last: int = 10) -> str:
    """A short text read for `obt rotation lot-plans`."""
    head = f"LOT PLANS · {r['book'].upper()} book (Adaptive), forward from {r['forward_from']}"
    lines = [head]
    if not r["chain"]["intact"]:
        lines.append(f"  CHAIN PROBLEMS: {'; '.join(r['chain']['problems'])}")
    c = r["counts"]
    lines.append(
        f"  entries {c['entries']}: scored {c['scored']}, waiting {c['waiting']}, "
        f"late {c['late']}, unverified {c['unverified']}"
    )
    if r["message"]:
        lines.append(f"  {r['message']}")
    lines.append(
        f"  {'plan':11s}{'today':>6s}{'days':>6s}{'net':>11s}{'per day':>10s}"
        f"{'max dd':>10s}{'worst':>10s}{'brokerage':>11s}"
    )
    for p in r["plans"]:
        worst = p["worst_day"]["net"] if p["worst_day"] else None
        today = "-" if p["lots_today"] is None else str(p["lots_today"])
        lines.append(
            f"  {p['name']:11s}{today:>6s}{p['days']:>6d}{_inr(p['net']):>11s}"
            f"{_inr(p['net_per_day']):>10s}{_inr(p['max_drawdown']):>10s}{_inr(worst):>10s}"
            f"{p['brokerage']:>11,.0f}"
        )
    ro = r["readout"]
    if ro["status"] == "n/a":
        lines.append(f"  read-out: n/a ({ro['days']} of {ro['needed']} scored days)")
    else:
        lines.append(f"  read-out on {ro['judged_days']} days {ro['from']} -> {ro['to']}:")
        for p in ro["plans"].values():
            lines.append(
                f"    {p['name']} minus As picked {p['diff_per_day']:+,.0f} a day "
                f"[{p['lo90']:+,.0f}, {p['hi90']:+,.0f}], drawdown per lot {p['dd_per_lot']:,.0f} "
                f"vs {p['comparator_dd_per_lot']:,.0f}: {p['verdict']}"
            )
    for row in r["rows"][-last:]:
        figures = "  ".join(
            f"{PLAN_NAMES[p]} {plan['total_lots'] or '-'}L {_inr(plan['net'])}"
            for p, plan in row["plans"].items()
        )
        tag = " expiry" if row["expiry"] else ""
        lines.append(f"  {row['day']}{tag:7s} {row['status']:10s} {figures}")
        if row["note"]:
            lines.append(f"      {row['note']}")
    return "\n".join(lines)
