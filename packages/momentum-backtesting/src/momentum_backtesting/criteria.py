"""The BL-010 pass/kill thresholds and rules, read from the committed criteria files
(`search_spaces/bl010_criteria*.json`) so code and file can never disagree (Phase 4 step 4).

The files are written before the runs they judge and never edited afterwards: a change is a
new addendum. This module only reads them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cache

import pandas as pd

from .config import PACKAGE_ROOT

SPACES = PACKAGE_ROOT / "search_spaces"


@cache
def load() -> dict:
    """The original criteria with each addendum merged in, in file order."""
    merged = json.loads((SPACES / "bl010_criteria.json").read_text())
    for path in sorted(SPACES.glob("bl010_criteria_addendum_*.json"), key=_number):
        extra = json.loads(path.read_text())
        _merge(merged, extra, supersedes=bool(extra.get("supersedes")))
    return merged


def _number(path) -> int:
    return int(path.stem.rsplit("_", 1)[1])


#: Keys every criteria file has that describe the file, not a rule.
_ABOUT = {"written_before_running", "name", "rule", "reason", "adds_to", "revised", "supersedes"}


def _merge(into: dict, extra: dict, supersedes: bool, where: str = "") -> None:
    """Add `extra`'s rules to `into`. Changing an existing value needs an addendum that says
    `"supersedes": ...` with its reason; otherwise it is a mistake and raises."""
    for key, value in extra.items():
        if not where and key in _ABOUT:
            continue
        if isinstance(value, dict) and isinstance(into.get(key), dict):
            _merge(into[key], value, supersedes, f"{where}{key}.")
        elif key in into and into[key] != value and not supersedes:
            raise ValueError(
                f"criteria addendum changes {where}{key} ({into[key]!r} -> {value!r}) without "
                "a 'supersedes' entry naming what it replaces and why"
            )
        else:
            into[key] = value


# --- drawdown baskets ----------------------------------------------------------------------


@dataclass(frozen=True)
class Episode:
    peak: pd.Timestamp
    trough: pd.Timestamp
    depth: float  # negative
    index_fall: float  # the index's largest peak-to-trough fall inside the same window


def episodes(curve: pd.Series, index: pd.Series, min_depth: float = 0.05) -> list[Episode]:
    """Every peak-to-trough fall of `curve` deeper than `min_depth`, each with the index's own
    worst fall between the same two dates."""
    curve = curve.dropna()
    index = index.reindex(curve.index).ffill()
    out = []
    running_peak, peak_day = curve.iloc[0], curve.index[0]
    trough, trough_day = running_peak, peak_day
    for day, value in curve.items():
        if value >= running_peak:
            if trough / running_peak - 1 <= -min_depth:
                out.append(_episode(index, peak_day, trough_day, trough / running_peak - 1))
            running_peak, peak_day, trough, trough_day = value, day, value, day
        elif value < trough:
            trough, trough_day = value, day
    if trough / running_peak - 1 <= -min_depth:
        out.append(_episode(index, peak_day, trough_day, trough / running_peak - 1))
    return out


def _episode(index: pd.Series, peak: pd.Timestamp, trough: pd.Timestamp, depth: float) -> Episode:
    window = index.loc[peak:trough].dropna()
    fall = float((window / window.cummax() - 1).min()) if len(window) > 1 else 0.0
    return Episode(peak, trough, float(depth), fall)


def basket_passes(
    curve: pd.Series, indices: dict[str, pd.Series], basket: str, *, loosen: float = 0.0
) -> bool:
    """Whether every drawdown of `curve` passes the basket: within its fixed limit, or within
    `multiple` x the named index's fall over the same window, and always within the ceiling.
    `indices` maps index name (as the criteria file spells it) to its curve. `loosen` moves the
    fixed limit (0.05 = five points more room, -0.05 = five fewer) for the threshold-stability
    check; the hard ceiling never moves."""
    spec = load()["baskets"][basket]
    relative = spec["or_relative"]
    if relative["index"] not in indices:
        raise KeyError(
            f"the {basket} basket is judged against {relative['index']}, which was not given "
            f"(have: {sorted(indices)}). reference_benchmarks.load_references() carries it once "
            "`mbt stocks fetch-benchmarks` has run."
        )
    for episode in episodes(curve, indices[relative["index"]]):
        if episode.depth < spec["hard_ceiling"]:
            return False
        if episode.depth >= spec["max_drawdown"] - loosen:
            continue
        if episode.depth < relative["multiple"] * episode.index_fall:
            return False
    return True


def baskets_passed(curve: pd.Series, indices: dict[str, pd.Series]) -> list[str]:
    return [name for name in load()["baskets"] if basket_passes(curve, indices, name)]


# --- the window rule (addendum 2) ------------------------------------------------------------


def check_windows(selection: list[tuple[str, str]], validation: list[tuple[str, str]]) -> None:
    """Raise if any selection window overlaps a validation window, with the embargo between
    them, or if either touches the sealed hold-out. Windows are (start, end) dates."""
    rules = load()["windows"]
    embargo = pd.Timedelta(weeks=rules["embargo_weeks"])
    hold = (pd.Timestamp(rules["holdout"]["from"]), pd.Timestamp(rules["holdout"]["to"]))
    for start, end in [*selection, *validation]:
        if pd.Timestamp(start) <= hold[1] and pd.Timestamp(end) >= hold[0]:
            raise ValueError(f"{start}..{end} reads the sealed hold-out {hold[0].date()}..")
    for s_start, s_end in selection:
        for v_start, v_end in validation:
            if pd.Timestamp(s_start) <= pd.Timestamp(v_end) + embargo and (
                pd.Timestamp(v_start) <= pd.Timestamp(s_end) + embargo
            ):
                raise ValueError(
                    f"selection window {s_start}..{s_end} and validation window "
                    f"{v_start}..{v_end} overlap (or are closer than the "
                    f"{rules['embargo_weeks']}-week embargo)"
                )
