"""A day's Adaptive picks as AlgoTest `.algtst` files (BL-137 Phase 1;
`obt rotation algotest-export`).

The picks are list C's core plus the Buy add-on, from the day's recorded journal entry (the live
journal for `core`, the T1 track's for `t1`), or with `preview` the evening's expected picks for
that session (`tomorrow.next_session_picks` run from the session before). Each strategy is its own
file, because an `.algtst` holds one strategy; a zip of them sits beside them.

The AlgoTest name is the book prefix plus the variant id (`T1 · N_p150-t1s11_0917`), the Buy add-on
marked `· add-on` (owner, 2026-10-19). The name does not say preview or recorded: an evening upload
that the 09:16 pick confirms keeps its name, so it is not uploaded again. `manifest.json` records
the source. Read-only over the journal and results; writes only under `out`."""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from ..legwise.algtst import Export, to_algtst
from ..legwise.schema import load_legwise
from . import journal, store
from .variants import strategy_path

#: book -> (journal track, AlgoTest name prefix)
BOOKS = {"core": (None, "Core"), "t1": ("t1", "T1")}
SEPARATOR = " · "
ADDON = "add-on"
LIST_KEY = "C"  # Adaptive


@dataclass(frozen=True)
class DayPicks:
    day: date
    book: str
    source: str  # "recorded" | "preview" | "given"
    core: list[str]
    buy: list[str]


def strategy_name(book: str, variant: str, addon: bool = False) -> str:
    name = f"{BOOKS[book][1]}{SEPARATOR}{variant}"
    return f"{name}{SEPARATOR}{ADDON}" if addon else name


def _previous_session(day: date) -> date:
    from .daylog import holiday_names, is_trading_day

    holidays = holiday_names()
    d = day - timedelta(days=1)
    while not is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def recorded_picks(day: date, book: str, root: Path | None = None) -> DayPicks | None:
    track = BOOKS[book][0]
    entries = journal.read(store.journal_path(root, track))
    entry = next((e for e in entries if e.get("day") == day.isoformat()), None)
    if entry is None:
        return None
    block = entry["lists"][LIST_KEY]
    return DayPicks(day, book, "recorded", list(block["core"]), list(block.get("buy") or []))


def preview_picks(day: date, book: str, root: Path | None = None) -> DayPicks | None:
    from .tomorrow import next_session_picks

    picks = next_session_picks(_previous_session(day), root, track=BOOKS[book][0])
    if picks is None or picks.day != day:
        return None
    return DayPicks(day, book, "preview", list(picks.core), list(picks.buy))


def build(picks: DayPicks) -> list[tuple[str, Export]]:
    """(variant, export) for every pick, core first; raises `Unmappable` on a setting with no
    known form."""
    out = []
    for variant, addon in [(v, False) for v in picks.core] + [(v, True) for v in picks.buy]:
        spec = load_legwise(strategy_path(variant))
        out.append((variant, to_algtst(spec, strategy_name(picks.book, variant, addon))))
    return out


def write(picks: DayPicks, exports: list[tuple[str, Export]], out: Path) -> Path:
    """Write `<variant>.algtst` per pick, `manifest.json` and `<day>-<book>.zip` into `out`;
    returns the zip's path. Files from an earlier run in `out` are replaced, never merged."""
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.algtst"):
        old.unlink()
    files = []
    for variant, export in exports:
        path = out / f"{variant}.algtst"
        path.write_text(export.text())
        files.append(path)
    manifest = {
        "day": picks.day.isoformat(),
        "book": picks.book,
        "source": picks.source,
        "strategies": [
            {
                "variant": variant,
                "name": export.name,
                "addon": variant in picks.buy,
                "file": f"{variant}.algtst",
            }
            for variant, export in exports
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    zip_path = out / f"{picks.day.isoformat()}-{picks.book}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, path.name)
    return zip_path


def _leg_settings(doc: dict) -> tuple[str, str, str, str]:
    leg = doc["strategy"]["ListOfLegConfigs"][0]
    strike = leg["StrikeParameter"]
    if isinstance(strike, str):
        strike_text = strike.removeprefix("StrikeType.")
    else:
        strike_text = f"premium ~{strike}"
    side = leg["PositionType"].removeprefix("PositionType.")
    sl = leg["LegStopLoss"]
    sl_text = f"{sl['Value']}%" if sl["Type"] != "None" else "none"
    trail = leg["LegTrailSL"]
    if trail["Type"] == "None":
        trail_text = "none"
    else:
        unit = "%" if trail["Type"].endswith("Percentage") else "pt"
        v = trail["Value"]
        trail_text = f"{v['InstrumentMove']}{unit}/{v['StopLossMove']}{unit}"
    re = leg["LegReentrySL"]
    re_text = f"cost x{re['Value']['ReentryCount']}" if re["Type"] != "None" else "none"
    if leg["LegMomentum"]["Type"] != "None":
        re_text += f", RB {leg['LegMomentum']['Time']}m"
    return f"{side} {strike_text}", sl_text, trail_text, re_text


def render(picks: DayPicks, exports: list[tuple[str, Export]], zip_path: Path) -> str:
    """A table to check by eye before uploading."""
    lines = [
        f"{picks.book.upper()} picks for {picks.day.isoformat()} ({picks.source}): "
        f"{len(exports)} file(s) in {zip_path.parent}",
        "",
        f"{'name':<38} {'entry':>5} {'exit':>5}  {'legs':<16} {'SL':>5}  {'trail':<9} "
        f"{'re-entry':<18} {'MTM SL':>6}",
    ]
    for _variant, export in exports:
        s = export.doc["strategy"]
        entry = s["EntryIndicators"]["Value"][0]["Value"]["Parameters"]
        exit_ = s["ExitIndicators"]["Value"][0]["Value"]["Parameters"]
        legs, sl, trail, re = _leg_settings(export.doc)
        mtm = s["OverallSL"]["Value"] if s["OverallSL"]["Type"] != "None" else "none"
        lines.append(
            f"{export.name:<38} {entry['Hour']:02d}:{entry['Minute']:02d} "
            f"{exit_['Hour']:02d}:{exit_['Minute']:02d}  {legs:<16} {sl:>5}  {trail:<9} "
            f"{re:<18} {mtm:>6}"
        )
    lines.append(f"zip: {zip_path}")
    return "\n".join(lines)
