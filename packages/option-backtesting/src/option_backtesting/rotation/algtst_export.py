"""A day's Adaptive picks as AlgoTest `.algtst` files (BL-137 Phase 1;
`obt rotation algotest-export`).

The picks are list C's core plus the Buy add-on, from the day's recorded journal entry (the live
journal for `core`, the T1 track's for `t1`), or with `preview` the evening's expected picks for
that session (`tomorrow.next_session_picks` run from the session before). Each strategy is its own
file, because an `.algtst` holds one strategy; a zip of them sits beside them.

The AlgoTest name is the book prefix plus the variant id (`T1 · N_p150-t1s11_0917`), the Buy add-on
marked `· add-on` (owner, 2026-10-19). The name does not say preview or recorded: an evening upload
that the 09:16 pick confirms keeps its name, so it is not uploaded again. `manifest.json` records
the source. Read-only over the journal and results; writes only under `out`.

BL-209: with the T1 split (`picks.accounts` set) one variant can be exported at several lots, so
a copy above 1 lot is named and filed with its lots (`T1 · S_p320_0947 · ×2`,
`S_p320_0947-x2.algtst`). The export holds every copy the split layout needs and every copy each
account needs to trade all of T1 alone (`picks.alone`: the other account not logged in), and the
manifest records which account trades which (`accounts`, `alone`): the morning activation reads
that, never re-derives it."""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from ..legwise.algtst import Export, to_algtst
from ..legwise.schema import load_legwise
from . import live_lots
from .entries import read as read_entries
from .live_lots import manifest_block, manifest_field
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
    #: BL-183: {'NIFTY': .., 'SENSEX': ..} days to expiry on the weekday basis, when known
    dte: dict[str, str] | None = None
    #: BL-183: lots per core pick (`live_lots.lots_for_day`) when the Dir ×2 rule was asked for;
    #: None = every pick 1 lot and the manifest as before
    lots: dict[str, int] | None = None
    #: BL-209: {broker: {variant: lots}} of the core picks under the T1 split, lead account first
    #: (`account_split.split`); None = no split, one export for every account as before
    accounts: dict[str, dict[str, int]] | None = None
    #: BL-209: {broker: {variant: lots}}, what each account trades when it trades all of T1 alone
    alone: dict[str, dict[str, int]] | None = None

    def lots_of(self, variant: str) -> int:
        return (self.lots or {}).get(variant, 1)


def strategy_name(book: str, variant: str, addon: bool = False, lots: int = 1) -> str:
    """The AlgoTest name; `lots` above 1 is in the name only for a split export's copies."""
    name = f"{BOOKS[book][1]}{SEPARATOR}{variant}"
    if lots > 1:
        name = f"{name}{SEPARATOR}×{lots}"
    return f"{name}{SEPARATOR}{ADDON}" if addon else name


def copies(picks: DayPicks) -> list[tuple[str, int, bool]]:
    """(variant, lots, addon) per strategy to export: each pick at its lots, the add-on after; under
    the split every distinct (variant, lots) either layout needs, in pick order then lots."""
    if picks.accounts is None:
        core = [(v, picks.lots_of(v), False) for v in picks.core]
    else:
        wanted = {
            (v, n)
            for layout in (picks.accounts, picks.alone or {})
            for book in layout.values()
            for v, n in book.items()
        }
        core = [
            (v, n, False) for v, n in sorted(wanted, key=lambda c: (picks.core.index(c[0]), c[1]))
        ]
    return core + [(v, 1, True) for v in picks.buy]


def copy_name(picks: DayPicks, variant: str, lots: int, addon: bool) -> str:
    return strategy_name(picks.book, variant, addon, lots if picks.accounts is not None else 1)


def copy_file(picks: DayPicks, variant: str, lots: int) -> str:
    return (
        f"{variant}-x{lots}.algtst"
        if picks.accounts is not None and lots > 1
        else f"{variant}.algtst"
    )


def _previous_session(day: date) -> date:
    from .daylog import holiday_names, is_trading_day

    holidays = holiday_names()
    d = day - timedelta(days=1)
    while not is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def recorded_picks(day: date, book: str, root: Path | None = None) -> DayPicks | None:
    track = BOOKS[book][0]
    entries = read_entries(root, track)
    entry = next((e for e in entries if e.get("day") == day.isoformat()), None)
    if entry is None:
        return None
    from .dte import entry_labels

    block = entry["lists"][LIST_KEY]
    return DayPicks(
        day,
        book,
        "recorded",
        list(block["core"]),
        list(block.get("buy") or []),
        dte=entry_labels(entry),
    )


def preview_picks(day: date, book: str, root: Path | None = None) -> DayPicks | None:
    """The evening's picks for session `day`: the list the 16:00 message saved for it, which is
    what that session records and trades (owner, 2026-11-09), else the same ranking run again
    (`tomorrow.next_session_picks`) when the message has not saved one (or saved it without its
    days to expiry, before 2026-11-09)."""
    from .entries import evening_list
    from .tomorrow import next_session_picks

    saved = evening_list(day, root, BOOKS[book][0])
    if saved is not None and isinstance(saved.get("dte"), dict):
        return DayPicks(
            day,
            book,
            "preview",
            [str(n) for n in saved["core"]],
            [str(n) for n in saved.get("buy") or []],
            dte=dict(saved["dte"]),
        )
    picks = next_session_picks(_previous_session(day), root, track=BOOKS[book][0])
    if picks is None or picks.day != day:
        return None
    return DayPicks(day, book, "preview", list(picks.core), list(picks.buy), dte=picks.dte)


def build(picks: DayPicks) -> list[tuple[str, Export]]:
    """(variant, export) for every pick, core first; raises `Unmappable` on a setting with no
    known form."""
    out = []
    for variant, lots, addon in copies(picks):
        spec = load_legwise(strategy_path(variant))
        # AlgoTest scales the overall MTM SL by the leg lots itself: keep the 1-lot figure
        spec = live_lots.scaled(spec, lots, overall_per_lot=True)
        out.append((variant, to_algtst(spec, copy_name(picks, variant, lots, addon))))
    return out


def _account_names(picks: DayPicks, layout: dict[str, dict[str, int]]) -> dict[str, list[str]]:
    """{broker: [AlgoTest names]} of a layout; the add-on goes with the lead account in the split
    (owner, 2026-11-04: Shoonya takes it) and with each account trading alone."""
    lead = next(iter(picks.accounts or {}), None)
    out = {}
    for broker, book in layout.items():
        names = [copy_name(picks, v, n, False) for v, n in book.items()]
        if layout is picks.alone or broker == lead:
            names += [copy_name(picks, v, 1, True) for v in picks.buy]
        out[broker] = names
    return out


def write(picks: DayPicks, exports: list[tuple[str, Export]], out: Path) -> Path:
    """Write `<variant>.algtst` per pick, `manifest.json` and `<day>-<book>.zip` into `out`;
    returns the zip's path. Files from an earlier export in `out` (the ones its `manifest.json`
    lists) are replaced; any other `.algtst` there is left alone, and a folder holding `.algtst`
    files with no manifest is refused (`FileExistsError`) rather than overwritten or merged."""
    out.mkdir(parents=True, exist_ok=True)
    old_manifest = out / "manifest.json"
    if old_manifest.exists():
        for entry in json.loads(old_manifest.read_text()).get("strategies", []):
            (out / Path(entry["file"]).name).unlink(missing_ok=True)
        for old_zip in out.glob("*-*.zip"):
            old_zip.unlink()
    elif any(out.glob("*.algtst")):
        raise FileExistsError(
            f"{out} already holds .algtst files that no export wrote; choose an empty folder"
        )
    files, strategies = [], []
    for (variant, export), (_, lots, addon) in zip(exports, copies(picks), strict=True):
        path = out / copy_file(picks, variant, lots)
        path.write_text(export.text())
        files.append(path)
        field = (
            {"lots": lots} if picks.accounts is not None else manifest_field(picks, variant, addon)
        )
        strategies.append(
            {"variant": variant, "name": export.name, "addon": addon, "file": path.name, **field}
        )
    manifest = {
        "day": picks.day.isoformat(),
        "book": picks.book,
        "source": picks.source,
        "strategies": strategies,
        **manifest_block(picks),
    }
    if picks.accounts is not None:
        manifest["split"] = "BL-209"
        manifest["dte"] = picks.dte
        manifest["accounts"] = _account_names(picks, picks.accounts)
        manifest["alone"] = _account_names(picks, picks.alone or {})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    zip_path = out / f"{picks.day.isoformat()}-{picks.book}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, path.name)
    return zip_path


def write_latest(base: Path, picks: DayPicks, folder: Path) -> Path:
    """`latest-<book>.json` in `base`: the newest default export's folder, day and source, for
    `packages/broker-login`'s uploader (`--latest <book>`)."""
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"latest-{picks.book}.json"
    record = {"dir": str(folder), "day": picks.day.isoformat(), "source": picks.source}
    path.write_text(json.dumps(record, indent=2) + "\n")
    return path


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
