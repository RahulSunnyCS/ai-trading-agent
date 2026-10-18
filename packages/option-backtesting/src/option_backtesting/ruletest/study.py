"""Test a rule strategy over a period: find the events, simulate the trade at each, and set the
result against its controls. The method is BL-083's event study, generalised to any rule.

    event        the first stamp in the rule's window where its condition is true (one per session),
                 traded from the next minute with the template, to its exit
    placebo      the same template and side at the same entry minute on the 20 nearest days with no
                 event of this rule (10 before, 10 after, inside the period)
    random time  the same template and side on the event days at a random entry minute of the
                 window (a 5-minute grid), 200 draws; the event's mean is placed among the draws

Everything is reported net of the BL-063 charges, with gross beside it, and slippage of 0.5% and 1%
of price per fill as a sensitivity on the events only. Nothing here picks a verdict: the numbers
are a *screen*, and the page that shows them says so.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

from . import expr as E
from . import frame as F
from . import sim, store
from .spec import CompiledRule

PERIODS: dict[str, tuple[date, date]] = {
    "learning": (date(2024, 10, 9), date(2026, 10, 8)),
    "confirmation": (date(2022, 1, 3), date(2024, 10, 8)),
}
#: sessions after this are forward only (BL-119 / BL-117 score them as they come); never tested here
DATA_CUTOFF = date(2026, 10, 8)
PLACEBO_DAYS = 10  # each side
MIN_PLACEBO = 10
DRAWS = 200
GRID_MINUTES = 5
MIN_EVENT_DAYS = 40  # fewer is reported as thin, never judged
SLIPPAGE = (0.5, 1.0)


@dataclass
class Options:
    periods: tuple[str, ...] = ("learning",)
    mode: str = "locked"  # "locked": the confirmation period needs a reveal; "exploratory": any
    workers: int = 4
    draws: int = DRAWS
    slippage: tuple[float, ...] = SLIPPAGE
    tries: int = 1
    progress: Callable[[str], None] | None = None
    strict_open: bool = True
    extra: dict[str, Any] = field(default_factory=dict)


def placebo_days(day: str, days: list[str], event_days: set[str]) -> list[str]:
    i = days.index(day)
    before = [d for d in reversed(days[:i]) if d not in event_days][:PLACEBO_DAYS]
    after = [d for d in days[i + 1 :] if d not in event_days][:PLACEBO_DAYS]
    return before + after


def entry_grid(start: int, stop: int) -> list[str]:
    """Entry minutes of the random-time control: every 5th minute from the first possible entry."""
    return [E.stamp_to_clock(s) for s in range(start + 1, stop + 2, GRID_MINUTES)]


def day_t(values_by_day: dict[str, float]) -> tuple[float, float | None]:
    """(mean, day-clustered t) of one value per day; t is None under 5 days or with no spread."""
    v = np.array(list(values_by_day.values()), dtype=float)
    if len(v) == 0:
        return float("nan"), None
    sd = v.std(ddof=1) if len(v) > 1 else 0.0
    t = float(v.mean() / (sd / np.sqrt(len(v)))) if len(v) > 4 and sd > 0 else None
    return float(v.mean()), t


def half_year(day: str) -> str:
    return f"{day[:4]}H{1 if int(day[5:7]) <= 6 else 2}"


def summarise(
    underlying: str,
    events: list[dict[str, Any]],
    days: list[str],
    event_days: set[str],
    entries: list[str],
    lookup: Callable[[str, str, str, float], dict[str, Any] | None],
    draws: int,
    seed: int,
    slippage: tuple[float, ...],
) -> dict[str, Any]:
    """The numbers of one period, from the events and a lookup of simulated rows. Pure: tests feed
    it a fake lookup."""
    rows: list[dict[str, Any]] = []
    for ev in events:
        row = lookup(ev["day"], ev["entry"], ev["side"], 0.0)
        if row is None:
            continue
        net = sim.net(underlying, row)
        placebo = []
        for pday in placebo_days(ev["day"], days, event_days):
            prow = lookup(pday, ev["entry"], ev["side"], 0.0)
            if prow is not None:
                placebo.append(sim.net(underlying, prow))
        pmean = float(np.mean(placebo)) if len(placebo) >= MIN_PLACEBO else None
        rows.append(
            {
                "day": ev["day"],
                "stamp": ev["stamp"],
                "entry": ev["entry"],
                "side": ev["side"],
                "net": round(net, 2),
                "gross": float(row["gross"]),
                "stopped_by": row["stopped_by"],
                "worst_mtm": float(row["worst_mtm"]),
                "placebo": None if pmean is None else round(pmean, 2),
                "placebo_n": len(placebo),
                "diff": None if pmean is None else round(net - pmean, 2),
                "weekday": date.fromisoformat(ev["day"]).strftime("%a"),
                "expiry_day": row["weekly_expiry"] == ev["day"],
                "spot_entry": _num(row["spot_entry"]),
                "spot_exit": _num(row["spot_exit"]),
            }
        )
    out: dict[str, Any] = {
        "events_found": len(events),
        "events": len(rows),
        "event_days": len({r["day"] for r in rows}),
        "thin": len(rows) < MIN_EVENT_DAYS,
    }
    if not rows:
        return {**out, "rows": [], "message": "no event could be simulated in this period"}
    nets = np.array([r["net"] for r in rows])
    out.update(
        net_mean=float(nets.mean()),
        net_total=float(nets.sum()),
        gross_mean=float(np.mean([r["gross"] for r in rows])),
        win_rate=float((nets > 0).mean()),
        stopped_share=float(np.mean([bool(r["stopped_by"]) for r in rows])),
        worst_mtm_mean=float(np.mean([r["worst_mtm"] for r in rows])),
    )
    with_placebo = [r for r in rows if r["diff"] is not None]
    by_day: dict[str, list[float]] = defaultdict(list)
    for r in with_placebo:
        by_day[r["day"]].append(r["diff"])
    diff_mean, t = day_t({d: float(np.mean(v)) for d, v in by_day.items()})
    out["placebo"] = {
        "events": len(with_placebo),
        "placebo_mean": float(np.mean([r["placebo"] for r in with_placebo]))
        if with_placebo
        else None,
        "diff_mean": diff_mean if with_placebo else None,
        "diff_t": t,
        "win_rate_placebo": float(np.mean([r["placebo"] > 0 for r in with_placebo]))
        if with_placebo
        else None,
    }
    out["random_time"] = (
        _random_time(underlying, rows, entries, lookup, draws, seed) if draws > 0 else {"draws": 0}
    )
    out["slippage"] = {}
    for pct in slippage:
        vals = []
        for r in rows:
            srow = lookup(r["day"], r["entry"], r["side"], pct)
            if srow is not None:
                vals.append(sim.net(underlying, srow))
        out["slippage"][f"{pct:g}"] = (
            {"events": len(vals), "net_mean": float(np.mean(vals))} if vals else None
        )
    out["by_half_year"] = _group(with_placebo or rows, lambda r: half_year(r["day"]))
    out["by_weekday"] = _group(rows, lambda r: r["weekday"])
    out["by_expiry_day"] = _group(rows, lambda r: "expiry day" if r["expiry_day"] else "other days")
    out["by_side"] = _group(rows, lambda r: r["side"])
    cumulative, running = [], 0.0
    for r in sorted(rows, key=lambda r: r["day"]):
        running += r["net"]
        cumulative.append([r["day"], round(running, 2)])
    out["equity"] = cumulative
    out["rows"] = rows
    return out


def _num(value: Any) -> float | None:
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(x) else x


def _group(rows: list[dict[str, Any]], key: Callable[[dict[str, Any]], str]) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[key(r)].append(r)
    out = {}
    for name, g in sorted(groups.items()):
        diffs = [r["diff"] for r in g if r["diff"] is not None]
        out[name] = {
            "events": len(g),
            "net_mean": float(np.mean([r["net"] for r in g])),
            "diff_mean": float(np.mean(diffs)) if diffs else None,
        }
    return out


def _random_time(
    underlying: str,
    rows: list[dict[str, Any]],
    entries: list[str],
    lookup: Callable[[str, str, str, float], dict[str, Any] | None],
    draws: int,
    seed: int,
) -> dict[str, Any]:
    """Where the events' mean sits among `draws` means of the same trades at random minutes."""
    pools: list[list[float]] = []
    for r in rows:
        values = []
        for entry in entries:
            row = lookup(r["day"], entry, r["side"], 0.0)
            if row is not None:
                values.append(sim.net(underlying, row))
        if values:
            pools.append(values)
    if not pools:
        return {"draws": 0}
    rng = np.random.default_rng(seed)
    means = np.array(
        [np.mean([p[rng.integers(len(p))] for p in pools]) for _ in range(draws)], dtype=float
    )
    event_mean = float(np.mean([r["net"] for r in rows]))
    below = float((means < event_mean).sum() + 0.5 * (means == event_mean).sum())
    return {
        "draws": draws,
        "events": len(pools),
        "mean": float(means.mean()),
        "p05": float(np.percentile(means, 5)),
        "p50": float(np.percentile(means, 50)),
        "p95": float(np.percentile(means, 95)),
        "event_percentile": below / draws,
    }


# --- orchestration over the lake -------------------------------------------------------------


def find_events(
    rule: CompiledRule, frame: E.Frame, lo: date, hi: date
) -> tuple[list[dict[str, Any]], set[str]]:
    """(events, every session the rule fired on) within [lo, hi]; the second set also holds days the
    simulator cannot run, so they are never used as placebo days."""
    rows = [i for i, d in enumerate(frame.days) if lo.isoformat() <= d <= hi.isoformat()]
    fired = E.first_firings(rule.when, frame, rule.start, rule.stop, rows)
    direction = E.evaluate(rule.direction, frame) if rule.direction is not None else None
    events = []
    for i, stamp in sorted(fired.items()):
        side = "both"
        if direction is not None:
            side = "up" if bool(direction[i, stamp]) else "down"
        events.append(
            {
                "day": frame.days[i],
                "stamp": stamp,
                "entry": E.stamp_to_clock(stamp + 1),
                "side": side,
            }
        )
    return events, {frame.days[i] for i in fired}


def check_allowed(root: Path, rule: CompiledRule, period: str, mode: str) -> None:
    if period not in PERIODS:
        raise store.RuleTestError(f"unknown period {period!r}; choose {', '.join(PERIODS)}")
    if period == "confirmation":
        if rule.spec.underlying != "NIFTY":
            raise store.RuleTestError(
                "the confirmation period (2022-01 to 2024-10) has NIFTY data only"
            )
        if mode == "locked" and not store.is_revealed(root, rule.spec_hash):
            raise store.LockedError(
                "The confirmation period is locked for this strategy. Reveal it once "
                f"(`obt rule reveal {rule.spec_hash}`), or test with all data open, which "
                "labels the result exploratory."
            )


def analyse_period(
    root: Path, rule: CompiledRule, frame: E.Frame, period: str, options: Options
) -> dict[str, Any]:
    from ..legwise.market import backtest_days

    lo, hi = PERIODS[period]
    log = options.progress or (lambda _m: None)
    usable, _excluded = backtest_days(root, rule.spec.underlying, lo, hi)
    days = [d.isoformat() for d in usable]
    dayset = set(days)
    events, fired_days = find_events(rule, frame, lo, hi)
    log(f"{period}: the rule fired on {len(events)} sessions; {len(days)} usable days")
    events = [e for e in events if e["day"] in dayset]
    entries = entry_grid(rule.start, rule.stop)
    wanted: set[sim.Key] = set()
    for ev in events:
        wanted.add((ev["day"], ev["entry"], ev["side"], 0.0))
        for pday in placebo_days(ev["day"], days, fired_days):
            wanted.add((pday, ev["entry"], ev["side"], 0.0))
        for entry in entries if options.draws > 0 else []:
            wanted.add((ev["day"], entry, ev["side"], 0.0))
        for pct in options.slippage:
            wanted.add((ev["day"], ev["entry"], ev["side"], pct))
    got = sim.ensure(root, rule, wanted, options.workers, log)
    seed = int(rule.spec_hash[:8], 16) ^ (1 if period == "learning" else 2)
    result = summarise(
        rule.spec.underlying,
        events,
        days,
        fired_days,
        entries,
        lambda d, e, s, p: got.get((d, e, s, p)),
        options.draws,
        seed,
        options.slippage,
    )
    return {"period": period, "from": lo.isoformat(), "to": hi.isoformat(), **result}


def run_test(root: Path, rule: CompiledRule, text: str, options: Options) -> dict[str, Any]:
    """Run, record in the ledger and return the full result. Raises LockedError before any work when
    the confirmation period is locked."""
    for period in options.periods:
        check_allowed(root, rule, period, options.mode)
    log = options.progress or (lambda _m: None)
    store.save_spec(root, rule.spec_hash, text)
    end = max(PERIODS[p][1] for p in options.periods)
    log(f"loading {rule.spec.underlying} sessions from {F.HISTORY_START}")
    frame = F.load_frame(root, rule.spec.underlying, end, strict_open=options.strict_open)
    periods = {p: analyse_period(root, rule, frame, p, options) for p in options.periods}
    prior = store.ledger(root)
    test_id = store.new_test_id()
    stamp = store.now().isoformat(timespec="seconds")
    count_after = store.counts([*prior, {"at": stamp, "tries": options.tries}], store.now())
    result = {
        "id": test_id,
        "at": stamp,
        "spec_hash": rule.spec_hash,
        "template_hash": rule.template_hash,
        "parent": rule.spec.parent,
        "name": rule.spec.name or rule.spec.id,
        "underlying": rule.spec.underlying,
        "mode": options.mode,
        "label": "a screen, not a finding",
        "tries": options.tries,
        "counts": count_after,
        "luck": store.lucky_sentence(count_after["month"]),
        "periods": periods,
    }
    row = {
        "id": test_id,
        "at": stamp,
        "spec_hash": rule.spec_hash,
        "parent": rule.spec.parent,
        "name": rule.spec.name or rule.spec.id,
        "underlying": rule.spec.underlying,
        "mode": options.mode,
        "periods": list(options.periods),
        "tries": options.tries,
        "summary": {
            p: {k: v.get(k) for k in ("events", "net_mean", "win_rate", "thin")}
            | {
                "diff_mean": (v.get("placebo") or {}).get("diff_mean"),
                "diff_t": (v.get("placebo") or {}).get("diff_t"),
                "random_percentile": (v.get("random_time") or {}).get("event_percentile"),
            }
            for p, v in periods.items()
        },
    }
    store.record_test(root, row, result)
    return result
