"""The day's entry: score every list from the results through the previous trading day plus today's
weekday, VIX band and days to expiry, and write one hash-chained entry before the first entry
time.

Since 2026-11-09 (owner) the evening's list is the source of truth: the entry ranks with the VIX
the evening message ranked with (the previous session's close, `evening_vix`), not a live 09:15
read, so it is the list last evening sent and the evening upload put on the platforms. When the
list that message saved for the day (`result.read_tentative`) still differs (the stored results
changed overnight, say), the saved list is recorded and the re-score is kept beside it under
`rescored`. Nothing is sent."""

from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from ..fyers.daily import data_dir
from . import expiry, journal, messages, sl150_cap, store
from .attrs import last_collected_before
from .dte import DTE_BASIS
from .lists import LISTS, LOTS_PER, PUBLIC_KEYS, WARMUP
from .live import listed_dte_labels
from .score import composite, dte_matrix, family_index, runners_up, select, vix_band
from .variants import track_names, variant_names

IST = ZoneInfo("Asia/Kolkata")
FIRST_ENTRY = time(9, 17)


class PickError(RuntimeError):
    """The entry cannot be recorded; nothing was written."""


@dataclass
class PickResult:
    entry: dict
    text: str
    #: {list: {wide, dir}}: the optional next best of the public lists (message text only)
    options: dict | None = None


def previous_data_day(root: Path, day: date) -> date:
    """The latest collected, non-excluded weekday before `day`: the day whose results the pick must
    already have."""
    prev = last_collected_before(root, day)
    if prev is None:
        raise PickError(f"no collected trading day in the 14 days before {day}")
    return prev


def evening_vix(root: Path, last_day: date) -> tuple[float | None, str]:
    """(VIX, where it came from) the evening ranks the next session with: `last_day`'s India VIX
    close in the lake, else that day's stored open; (None, "none") when neither is there. The one
    stand-in both the evening message (`tomorrow.expected_picks`) and the day's entry use."""
    from . import attrs as attrs_mod

    vix = attrs_mod.vix_close_from_lake(root, last_day)
    if vix is not None:
        return float(vix), f"close {last_day.isoformat()}"
    stored = (store.read_days(root).get(last_day) or {}).get("vix_open")
    if stored not in (None, ""):
        return float(stored), f"open {last_day.isoformat()}"
    return None, "none"


def code_commit() -> str:
    """Short HEAD, with `+dirty` when the code this entry ran has uncommitted changes."""
    repo = Path(__file__).resolve().parents[3]
    try:
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            [
                "git",
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--",
                "src",
                "strategies/rotation",
                "strategies/rotation_t1",
            ],
            capture_output=True,
            text=True,
            cwd=repo,
            check=True,
        ).stdout.strip()
        return head + ("+dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def universe_fingerprint(names: list[str]) -> dict:
    return {
        "variants": len(names),
        "sha": hashlib.sha256("\n".join(sorted(names)).encode()).hexdigest()[:12],
    }


@dataclass
class History:
    """The stored results and day attributes a pick ranks on, as arrays, plus a digest of them."""

    days: list[date]
    cols: list[str]
    values: np.ndarray  # days x variants, net P&L (history only: no row for the target day)
    weekday: list[str]
    band: list[str]
    dte_n: list[str]
    dte_s: list[str]
    digest: str


def load_history(day: date, root: Path, names: list[str], basis: str = "weekdays") -> History:
    """Everything the pick reads from disk. Raises PickError when the history is short or does not
    reach the last collected trading day."""
    if not names:
        raise PickError("no variant strategy files found")
    with store.slipped(0.0):  # the ranking never reads the display-only slippage copy
        m = store.load_matrix(names, root, through=day - timedelta(days=1))
    attrs = store.read_days(root, basis)
    keep = [i for i, d in enumerate(m.days) if d in attrs]
    days = [m.days[i] for i in keep]
    if len(days) < WARMUP:
        raise PickError(f"only {len(days)} days of results (need {WARMUP})")
    prev = previous_data_day(root, day)
    if days[-1] != prev:
        raise PickError(
            f"results end {days[-1]} but the last collected trading day is {prev}: "
            f"run `obt rotation update --day {prev}`"
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
    return History(
        days,
        list(m.names),
        values,
        [attrs[d]["weekday"] for d in days],
        [attrs[d]["vix_band"] for d in days],
        [attrs[d]["dte_n"] for d in days],
        [attrs[d]["dte_s"] for d in days],
        h.hexdigest(),
    )


def _rank(hist: History, day: date, vix_open: float | None, dte: dict[str, str]):
    """Per list key: (composite over every variant, the selected picks), for `day`."""
    weekday = np.array([*hist.weekday, day.strftime("%a")])
    band = np.array([*hist.band, vix_band(vix_open)])
    dn = np.array([*hist.dte_n, dte["dte_n"]])
    ds = np.array([*hist.dte_s, dte["dte_s"]])
    cols = hist.cols
    Pv = np.vstack([hist.values, np.zeros((1, len(cols)))])
    dmat = dte_matrix(dn, ds, cols)
    fam = family_index(cols)
    for key, lst in LISTS.items():
        comp = composite(Pv, weekday, band, dmat, cols, lst, fam)
        yield key, cols, comp, select(comp, cols)


def list_composites(
    hist: History,
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    key: str,
    names: list[str],
) -> dict[str, float]:
    """{name: composite} of list `key` for `names`, as `score_history` rounds them."""
    for k, cols, comp, _ in _rank(hist, day, vix_open, dte):
        if k == key:
            at = {c: i for i, c in enumerate(cols)}
            return {n: round(float(comp[at[n]]), 4) for n in names if n in at}
    return {}


#: the list in an entry the evening's saved list stands for (Adaptive)
EVENING_LIST = "C"


def _evening_list(day: date, root: Path, track: str | None) -> dict | None:
    from .entries import evening_list

    return evening_list(day, root, track)


def _check_expiry_only(expiry_only: str | None) -> None:
    if expiry_only is not None and expiry_only not in expiry.INDICES:
        raise ValueError(
            f"expiry_only must be one of {', '.join(expiry.INDICES)} or None, not {expiry_only!r}"
        )


def score_history(
    hist: History,
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    expiry_only: str | None = None,
) -> dict:
    """{list: {core, buy, overridden, composite}} for `day`.

    `expiry_only` ('NIFTY' | 'SENSEX', BL-122): the lists in `expiry.RULE_LISTS` (Adaptive) take
    only that index's variants (a filter of the same ranking, `expiry.filter_picks`), and their
    block also carries `unfiltered` (the picks without the rule) and `expiry_only`. None, the
    default, is the ranking exactly as before; reconstructed history never passes it.

    BL-192: on a day `sl150_cap.applies` (from 2026-10-30, NIFTY not expiring), a rule list holds at
    most one `N_wide-t1s4` (`sl150_cap.cap_picks`, a filter like the expiry rule's); its block then
    carries `sl150_capped` (the core before the cap). Decided by the day itself, so reconstructed
    history gets it too, and every day before 2026-10-30 stays as it was."""
    _check_expiry_only(expiry_only)
    cap = sl150_cap.applies(day, dte["dte_n"])
    out = {}
    for key, cols, comp, picks in _rank(hist, day, vix_open, dte):
        chosen = picks
        if expiry_only and key in expiry.RULE_LISTS:
            chosen = expiry.filter_picks(comp, cols, picks, expiry_only)
        elif cap and key in expiry.RULE_LISTS:
            chosen = sl150_cap.cap_picks(comp, cols, picks)
        out[key] = {
            "core": chosen.core,
            "buy": chosen.buy,
            "overridden": chosen.overridden,
            "composite": {k: round(v, 4) for k, v in chosen.composite.items()},
        }
        if chosen is not picks and expiry_only:
            out[key]["unfiltered"] = {"core": picks.core, "buy": picks.buy}
            out[key]["expiry_only"] = expiry_only
        elif chosen is not picks:  # BL-192: the SL150% cap changed the picks
            out[key]["sl150_capped"] = {"core": picks.core}
    return out


def next_best(
    hist: History,
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    expiry_only: str | None = None,
) -> dict[str, dict[str, str | None]]:
    """{list: {wide, dir}}: the best Widesl and the best Dir variant that were not picked, for the
    public lists. Message text only; it is not part of the journal entry. With `expiry_only`, a
    rule list's options come from that index only, like its picks."""
    _check_expiry_only(expiry_only)
    out: dict[str, dict[str, str | None]] = {}
    for key, cols, comp, picks in _rank(hist, day, vix_open, dte):
        if key not in PUBLIC_KEYS:
            continue
        if expiry_only and key in expiry.RULE_LISTS:
            chosen = expiry.filter_picks(comp, cols, picks, expiry_only)
            out[key] = expiry.filtered_runners_up(comp, cols, chosen, expiry_only)
        elif key in expiry.RULE_LISTS and sl150_cap.applies(day, dte["dte_n"]):
            capped = sl150_cap.cap_picks(comp, cols, picks)
            out[key] = sl150_cap.capped_runners_up(comp, cols, picks, capped)
        else:
            out[key] = runners_up(comp, cols, picks)
    return out


def score_lists(
    day: date,
    vix_open: float | None,
    dte: dict[str, str],
    root: Path | None = None,
    names: list[str] | None = None,
) -> dict:
    """{list: {core, buy, overridden, composite}} for `day`, from the stored results before it."""
    root = root or data_dir()
    hist = load_history(day, root, names or variant_names())
    return score_history(hist, day, vix_open, dte)


#: A parallel track records only these lists (owner, 2026-10-16: Adaptive only for T1).
TRACK_LISTS = {"t1": ("C",)}


def record(
    day: date,
    root: Path | None = None,
    vix_open: float | None = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
    dry_run: bool = False,
    track: str | None = None,
    vix_source: str | None = None,
) -> PickResult:
    """Score and append today's entry from the evening's list (module docstring). `track` (e.g.
    "t1") records a parallel track instead: Core-298 plus its extra variants, only its own lists,
    in its own journal; the live journal is never touched by a track run. `vix_open` given (tests,
    a run by hand) is used instead of the evening's VIX, recorded as read from `vix_source` when
    that is also given, else as "given"."""
    root = root or data_dir()
    if not dry_run and day != now_fn().astimezone(IST).date():
        raise PickError(f"{day} is not today (IST): an entry can only be recorded on its own day")
    if not dry_run and any(
        e["day"] == day.isoformat() for e in journal.read(store.journal_path(root, track))
    ):
        # a retry after a success: answer before anything slow
        raise journal.AlreadyRecorded(f"{day.isoformat()} is already in the journal")
    names = variant_names() + (track_names(track) if track else [])
    dte, dte_source = listed_dte_labels(day)
    # BL-122: from 2026-10-19, on a day exactly one index expires, Adaptive takes only its
    # strategies. A bad kill-switch value fails here, loudly.
    rule = expiry.rule_index(day, dte)
    sl150_cap.effective_from()  # BL-192: a bad kill-switch value fails here too
    commit = code_commit()
    try:
        hist = load_history(day, root, names)
    except PickError as error:
        if track:  # the fix is the track's own update, not the live one
            raise PickError(
                str(error).replace("`obt rotation update", f"`obt rotation update --track {track}")
            ) from error
        raise
    if track:
        core_days = load_history(day, root, variant_names()).days
        if hist.days != core_days:
            missing = sorted(set(core_days) - set(hist.days))
            raise PickError(
                f"the {track} track lacks results for {len(missing)} day(s) Core-298 has "
                f"(first {', '.join(d.isoformat() for d in missing[:3])}): "
                f"run `obt rotation update --track {track}`"
            )
    if vix_open is None:
        vix_open, source = evening_vix(root, hist.days[-1])
    else:
        source = vix_source or "given"
    if vix_open is None:
        raise PickError(
            f"no India VIX close or open is stored for {hist.days[-1]}, the evening's stand-in "
            f"for {day}; nothing recorded"
        )
    lists = score_history(hist, day, vix_open, dte, expiry_only=rule)
    if track:
        lists = {k: v for k, v in lists.items() if k in TRACK_LISTS[track]}
    # The evening's list is the source of truth (owner, 2026-11-09).
    evening = _evening_list(day, root, track)
    block = lists.get(EVENING_LIST)
    if evening is None:
        evening_status = "not saved"
    elif block is not None and (block["core"], block["buy"]) == (evening["core"], evening["buy"]):
        evening_status = "matched"
    elif block is not None:
        evening_status = "replaced"
        picked = [*evening["core"], *evening["buy"]]
        lists[EVENING_LIST] = {
            "core": list(evening["core"]),
            "buy": list(evening["buy"]),
            "overridden": [],
            "composite": list_composites(hist, day, vix_open, dte, EVENING_LIST, picked),
            "rescored": {"core": block["core"], "buy": block["buy"]},
        }
    else:
        evening_status = "not saved"
    fields = {
        "v": 3,
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": round(vix_open, 4),
        "vix_source": source,
        "vix_band": vix_band(vix_open),
        "dte": {"NIFTY": dte["dte_n"], "SENSEX": dte["dte_s"]},
        "dte_source": dte_source,
        "dte_basis": DTE_BASIS,
        "lists": lists,
        "commit": commit,
        "universe": universe_fingerprint(names),
        "inputs_sha": hist.digest,
        "inputs_days": len(hist.days),
        "lots_per_strategy": LOTS_PER,
        "picks_from": "evening",
        "evening_list": {
            "status": evening_status,
            "sent_on": (evening or {}).get("sent_on"),
        },
    }
    if track:
        fields["track"] = track
    if rule:  # omitted on every other day, so those entries are exactly what they were
        fields["expiry_only"] = rule
    path = store.journal_path(root, track)
    stamp = now_fn().astimezone(IST)  # taken right before the write, so the flag describes it
    fields["recorded_at"] = stamp.isoformat(timespec="seconds")
    fields["before_first_entry"] = stamp.time() < FIRST_ENTRY
    if dry_run:
        entry = {**fields, "prev": journal.head(path), "hash": "(dry run)"}
    else:
        entry = journal.append(path, fields)
    options = next_best(hist, day, vix_open, dte, expiry_only=rule)
    if track:
        options = {k: v for k, v in options.items() if k in TRACK_LISTS[track]}
    return PickResult(entry, render(entry, options), options)


def render(entry: dict, options: dict[str, dict[str, str | None]] | None = None) -> str:
    """The message for one entry: Adaptive's layout, or the T1 layout for a track entry
    (`messages.render_entry`; BL-125)."""
    return messages.render_entry(entry, options)
