"""A day's Adaptive picks as Quantiply create bodies (BL-139 Phase 2;
`obt rotation quantiply-export`).

The picks are the same as BL-137's AlgoTest export (`algtst_export`): list C's core plus the Buy
add-on, recorded at 09:16 or, with `preview`, the evening's expected picks for that session. Core
was the first list on Quantiply; since BL-140 the dashboard's settings may give it T1 too. The
name is BL-137's (`Core · <variant>` / `T1 · <variant>`, the add-on marked `· add-on`), so one
name means one strategy on both platforms.

Quantiply keeps one algo per weekday, so each body is for the session's weekday only. Each body is
`<variant>.json`, the exact `POST /algos` payload; `manifest.json` records the day, its weekday,
the source and, per strategy, any mapping not yet seen saved (`unconfirmed`), which the uploader
refuses. Read-only over the journal and results; writes only under `out`."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..legwise.quantiply import WEEKDAYS, Export, to_quantiply
from ..legwise.schema import load_legwise
from .algtst_export import DayPicks, strategy_name
from .live_lots import manifest_block, manifest_field
from .variants import strategy_path

#: the lists Quantiply can take (BL-140: the dashboard settings choose; core was the first)
BOOKS = ("core", "t1")
MANIFEST = "manifest.json"


@dataclass(frozen=True)
class Built:
    variant: str
    addon: bool
    export: Export


def weekday(picks: DayPicks) -> str:
    return WEEKDAYS[picks.day.weekday()]


def build(picks: DayPicks) -> list[Built]:
    """One body per pick, core first; raises `Unmappable` on a setting with no known form."""
    if picks.book not in BOOKS:
        raise ValueError(f"Quantiply takes {' or '.join(BOOKS)}, not {picks.book!r}")
    day = weekday(picks)
    out = []
    from .live_lots import scaled

    for variant, addon in [(v, False) for v in picks.core] + [(v, True) for v in picks.buy]:
        spec = load_legwise(strategy_path(variant))
        if not addon:
            spec = scaled(spec, picks.lots_of(variant))
        name = strategy_name(picks.book, variant, addon)
        out.append(Built(variant, addon, to_quantiply(spec, name, [day])))
    return out


def write(picks: DayPicks, built: list[Built], out: Path, extra: dict | None = None) -> Path:
    """Write `<variant>.json` per pick and `manifest.json` into `out`; returns the manifest's path.
    Files an earlier export wrote there (its manifest lists them) are replaced; a folder holding
    `.json` files with no manifest is refused (`FileExistsError`), never overwritten or merged."""
    out.mkdir(parents=True, exist_ok=True)
    old = out / MANIFEST
    if old.exists():
        for entry in json.loads(old.read_text()).get("strategies", []):
            (out / Path(entry["file"]).name).unlink(missing_ok=True)
    elif any(out.glob("*.json")):
        raise FileExistsError(
            f"{out} already holds .json files that no export wrote; choose an empty folder"
        )
    for b in built:
        (out / f"{b.variant}.json").write_text(b.export.text())
    manifest = {
        "day": picks.day.isoformat(),
        "weekday": weekday(picks),
        "book": picks.book,
        "source": picks.source,
        "strategies": [
            {
                "variant": b.variant,
                "name": b.export.name,
                "addon": b.addon,
                "file": f"{b.variant}.json",
                "unconfirmed": b.export.unconfirmed,
                **manifest_field(picks, b.variant, b.addon),
            }
            for b in built
        ],
        **manifest_block(picks),
        **(extra or {}),
    }
    old.write_text(json.dumps(manifest, indent=2) + "\n")
    return old


def evening_of(folder: Path) -> DayPicks | None:
    """BL-172: the list the evening uploaded for this folder's day, from its manifest: the
    evening's own (`source: preview`), or the `evening` block an earlier morning export kept."""
    path = folder / MANIFEST
    if not path.exists():
        return None
    m = json.loads(path.read_text())
    day = date.fromisoformat(m["day"])
    if m.get("source") == "preview":
        core = [s["variant"] for s in m["strategies"] if not s.get("addon")]
        buy = [s["variant"] for s in m["strategies"] if s.get("addon")]
        return DayPicks(day, m["book"], "preview", core, buy)
    if isinstance(m.get("evening"), dict):
        e = m["evening"]
        return DayPicks(day, m["book"], "preview", list(e["core"]), list(e["buy"]))
    return None


def write_latest(base: Path, picks: DayPicks, folder: Path) -> Path:
    """`latest-core.json` in `base`: the newest default export's folder, day and source, for the
    uploader (`--latest core`)."""
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"latest-{picks.book}.json"
    record = {"dir": str(folder), "day": picks.day.isoformat(), "source": picks.source}
    path.write_text(json.dumps(record, indent=2) + "\n")
    return path


def _legs(cfg: dict) -> tuple[str, str, str, str]:
    leg = cfg["legs"][0]
    side = "Buy" if leg["transactionType"] == "B" else "Sell"
    if leg["selectionType"] == "STRIKE":
        pick = leg["strike"]
    else:
        pick = f"premium ~{leg['premium']['value']}"
    sl = leg.get("stoploss")
    if sl is None:
        sl_text = "none"
    else:
        sl_text = f"{-sl['value']}{'%' if sl['type'].endswith('PERCENT') else 'pt'}"
    trail = leg.get("trailingStoploss")
    if trail is None:
        trail_text = "none"
    else:
        unit = "%" if trail["type"].endswith("PERCENT") else "pt"
        trail_text = f"{trail['moveBy']}{unit}/{trail['trailBy']}{unit}"
    re = leg.get("reEntry")
    re_text = f"cost x{re['repeat']}" if re else "none"
    if cfg.get("isORBEnabled"):
        re_text += f", RB to {cfg['orbEndTime'][:5]} {leg['orb']['entryAt'].lower()}"
    return f"{side} {pick}", sl_text, trail_text, re_text


def render(picks: DayPicks, built: list[Built], manifest: Path) -> str:
    """A table to check by eye before uploading."""
    lines = [
        f"{picks.book.upper()} picks for {picks.day.isoformat()} "
        f"({weekday(picks)}, {picks.source}): "
        f"{len(built)} body(ies) in {manifest.parent}",
        "",
        f"{'name':<36} {'entry':>5} {'exit':>5}  {'legs':<18} {'SL':>5}  {'trail':<9} "
        f"{'re-entry':<22} {'MTM SL':>6}",
    ]
    for b in built:
        cfg = b.export.body["configurations"]
        legs, sl, trail, re = _legs(cfg)
        mtm = -cfg["stoploss"]["value"] if "stoploss" in cfg else "none"
        lines.append(
            f"{b.export.name:<36} {cfg['startTime'][:5]} {cfg['endTime'][:5]}  {legs:<18} "
            f"{sl:>5}  {trail:<9} {re:<22} {mtm:>6}"
        )
    unconfirmed = sorted({u for b in built for u in b.export.unconfirmed})
    if unconfirmed:
        lines.append(f"NOT UPLOADABLE YET (unconfirmed): {'; '.join(unconfirmed)}")
    lines.append(f"manifest: {manifest}")
    return "\n".join(lines)
