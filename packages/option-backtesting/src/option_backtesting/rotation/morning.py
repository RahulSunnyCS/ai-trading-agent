"""BL-172 Phase 4: the 09:16 pick changes only what starts after 09:17 (owner, 2026-10-28).

The evening uploads tomorrow's expected picks and the 08:10 job switches them on. At 09:16 the real
pick is recorded. A strategy that enters at 09:17 cannot be changed by then: the evening's 09:17
strategy keeps running, and a new 09:17 pick is not added. For the rest, the day's list is chosen
again with the 09:16 pick's own rule (`score.select`: the top `N_CORE` Widesl / Dir variants by the
09:16 composite, at least `MIN_WIDE_N` Widesl), with the evening's 09:17 strategy kept in and no
other 09:17 variant allowed; the highest scorers stay. The Buy add-on follows the 09:16 pick unless
it enters at 09:17 (then the evening's add-on, if any, stays).

The result is written as the day's export, so the 09:19 upload creates only what is new and the
09:21 switch-on turns it on and the replaced strategies off; nothing else in the pipeline changes.

When the 09:16 ranking cannot be rebuilt to the recorded picks (the stored results changed since,
say), nothing is changed: the evening's list runs, and the notes say why.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np

from .algtst_export import BOOKS, DayPicks, recorded_picks
from .lists import MIN_WIDE_N, N_CORE
from .variants import is_buy, is_dir, is_wide, parts, underlying_of

#: An entry at or before this minute cannot be changed once the 09:16 pick is in.
EARLY_MINUTES = 9 * 60 + 17

#: The rebuilt composite must match the journal's to this many decimals.
COMPOSITE_DP = 4


def entry_minutes(name: str) -> int:
    tag = parts(name)[2]
    return int(tag[:2]) * 60 + int(tag[2:])


def is_early(name: str) -> bool:
    return entry_minutes(name) <= EARLY_MINUTES


@dataclass
class Morning:
    """The day's list as it will run, and what the 09:16 pick changed."""

    picks: DayPicks
    evening: DayPicks
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    not_made: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.added or self.removed)


def select_keeping(
    comp: np.ndarray, names: list[str], keep: list[str], allowed: list[bool]
) -> list[str]:
    """`score.select`'s core with `keep` forced in and only `allowed` variants otherwise: the top
    `N_CORE` by composite, the lowest-scoring Dir that is not kept swapped for the next-best allowed
    Widesl until at least `MIN_WIDE_N` are Widesl. Order: by composite, like `select`."""
    index = {n: v for v, n in enumerate(names)}
    wide = np.array([is_wide(n) for n in names])
    dir_ = np.array([is_dir(n) for n in names])
    order = sorted(
        (v for v, n in enumerate(names) if allowed[v] and not is_buy(n)),
        key=lambda v: (-comp[v], names[v]),
    )
    core = [index[k] for k in keep if k in index and not is_buy(k)][:N_CORE]
    forced = set(core)
    for v in order:
        if len(core) >= N_CORE:
            break
        if v not in core:
            core.append(v)
    n_wide = int(wide[core].sum())
    spare = [v for v in order if wide[v] and v not in core]
    while n_wide < MIN_WIDE_N and spare:
        dirs = [v for v in core if dir_[v] and v not in forced]
        if not dirs:
            break
        drop = min(dirs, key=lambda v: (comp[v], names[v]))
        core.remove(drop)
        core.append(spare.pop(0))
        n_wide += 1
    return [names[v] for v in sorted(core, key=lambda v: (-comp[v], names[v]))]


def choose(
    evening: DayPicks,
    recorded: DayPicks,
    comp: np.ndarray,
    names: list[str],
    rule_index: str | None = None,
    cap: bool = False,
) -> Morning:
    """The day's list under the owner's rule (module docstring). `comp` is the 09:16 composite of
    the Adaptive list over `names`; `rule_index` the BL-122 expiring index when the entry has one
    (the pool is then that index's variants, the kept 09:17 strategy aside); `cap` the BL-192
    SL150% cap (at most one `N_wide-t1s4`: a kept 09:17 copy, else the best-ranked)."""
    evening_all = [*evening.core, *evening.buy]
    keep = [v for v in evening.core if is_early(v)]
    allowed = [
        (not is_early(n) or n in evening_all)
        and (rule_index is None or underlying_of(n) == rule_index or n in keep)
        for n in names
    ]
    core = select_keeping(comp, names, keep, allowed)
    if cap:
        from .sl150_cap import SETTING

        mine = [n for n in core if n.startswith(SETTING)]
        if len(mine) >= 2:
            kept = [k for k in keep if k.startswith(SETTING)]
            stay = kept[0] if kept else mine[0]  # `core` is in composite order
            allowed = [
                a and (not n.startswith(SETTING) or n == stay)
                for a, n in zip(allowed, names, strict=True)
            ]
            core = select_keeping(comp, names, keep, allowed)
    # The add-on: the evening's stays when it enters at 09:17 (already running); otherwise the
    # 09:16 pick's own, unless that one enters at 09:17 (too late to add).
    early_buy = [v for v in evening.buy if is_early(v)]
    buy = early_buy or [b for b in recorded.buy if not is_early(b)]
    picks = DayPicks(recorded.day, recorded.book, "recorded", core, buy)
    run = [*core, *buy]
    m = Morning(
        picks=picks,
        evening=evening,
        added=[v for v in run if v not in evening_all],
        removed=[v for v in evening_all if v not in run],
        not_made=[
            v for v in [*recorded.core, *recorded.buy] if v not in run and v not in evening_all
        ],
    )
    if m.not_made:
        m.notes.append(f"09:16 picks not made: {', '.join(m.not_made)}")
    return m


def unchanged(evening: DayPicks, recorded: DayPicks, why: str) -> Morning:
    """The evening's list runs as uploaded (the 09:16 change could not be judged)."""
    picks = DayPicks(recorded.day, recorded.book, "recorded", list(evening.core), list(evening.buy))
    return Morning(picks=picks, evening=evening, notes=[f"the evening's list runs: {why}"])


def _ranking(day: date, book: str, entry: dict, root: Path):
    """(names, the Adaptive list's 09:16 composite) rebuilt from the stored results, the way the
    09:16 job ranked (`pick._rank` with the entry's own VIX open and days to expiry)."""
    from . import dte as dte_mod
    from . import pick
    from .variants import track_names, variant_names

    track = BOOKS[book][0]
    names = variant_names() + (track_names(track) if track else [])
    hist = pick.load_history(day, root, names)
    labels = dte_mod.entry_labels(entry)
    for key, cols, comp, _picks in pick._rank(
        hist, day, entry.get("vix_open"), {"dte_n": labels["NIFTY"], "dte_s": labels["SENSEX"]}
    ):
        if key == "C":
            return list(cols), np.asarray(comp)
    raise ValueError("no Adaptive (C) ranking")


def _reproduces(
    entry_block: dict, names: list[str], comp: np.ndarray, rule: str | None, cap: bool = False
) -> str:
    """'' when the rebuilt ranking gives the journal's own picks and composites, else why not.
    `cap`: the day's BL-192 SL150% cap applies (as `pick.score_history` applied it)."""
    from . import expiry, sl150_cap
    from .score import select

    picks = select(comp, names)
    if rule:
        picks = expiry.filter_picks(comp, names, picks, rule)
    elif cap:
        picks = sl150_cap.cap_picks(comp, names, picks)
    if list(picks.core) != list(entry_block["core"]) or list(picks.buy) != list(
        entry_block.get("buy") or []
    ):
        return "the 09:16 ranking rebuilt today does not give the recorded picks"
    by_name = {n: float(comp[v]) for v, n in enumerate(names)}
    for name, value in (entry_block.get("composite") or {}).items():
        if round(by_name.get(name, float("nan")), COMPOSITE_DP) != round(value, COMPOSITE_DP):
            return f"the rebuilt composite of {name} differs from the journal's"
    return ""


def morning_list(day: date, book: str, evening: DayPicks, root: Path | None = None) -> Morning:
    """The day's list for `book`: the owner's rule over the recorded 09:16 entry, or the evening's
    list unchanged when the ranking cannot be rebuilt to it."""
    from ..fyers.daily import data_dir
    from . import journal, store
    from .algtst_export import LIST_KEY

    root = root or data_dir()
    recorded = recorded_picks(day, book, root)
    if recorded is None:
        raise LookupError(f"no recorded {book} entry for {day}")
    if {*recorded.core, *recorded.buy} == {*evening.core, *evening.buy}:
        return Morning(picks=recorded, evening=evening)
    entries = journal.read(store.journal_path(root, BOOKS[book][0]))
    entry = next(e for e in entries if e.get("day") == day.isoformat())
    try:
        names, comp = _ranking(day, book, entry, root)
    except Exception as error:  # a short history, a missing file: never guess
        return unchanged(evening, recorded, f"the 09:16 ranking could not be rebuilt ({error})")
    rule = entry.get("expiry_only")
    from . import dte as dte_mod
    from . import sl150_cap

    cap = not rule and sl150_cap.applies(day, dte_mod.entry_labels(entry)["NIFTY"])
    why = _reproduces(entry["lists"][LIST_KEY], names, comp, rule, cap)
    if why:
        return unchanged(evening, recorded, why)
    return choose(evening, recorded, comp, names, rule, cap)
