"""The 298 whole-day variants: NIFTY / SENSEX x (Widesl, Dir ATM, Dir ITM1, Buy, closest-premium
Widesl) x 25 start times 09:17 .. 15:17 (Buy has none at 15:17). The first 248 are BL-058's
registered universe; the 50 Dir ITM1 files were added on 2026-10-10 (owner, BL-080) before the first
journal entry. Their strategy files are committed under `strategies/rotation/` (copied from the
research folders; never edited, so the forward test cannot drift) and named
`<N|S>_<family>_<HHMM>.yaml`.

Parallel tracks (forward tracking only, never the live journal): their extra variants live in their
own strategy folder and are named `<N|S>_<base>-<track>s<set>_<HHMM>`, e.g. `S_p285-t1s22_0917`
(T1, set 22: SENSEX closest-premium ₹285 Widesl). The base family before the `-` decides Widesl /
Dir / Buy; a Core-298 name has no `-`, so nothing about the live universe changes."""

from __future__ import annotations

from pathlib import Path

CLOSEST = ("p80", "p100", "p250", "p320")
STRATEGIES_DIR = Path(__file__).resolve().parents[3] / "strategies" / "rotation"
UNDERLYING = {"N": "NIFTY", "S": "SENSEX"}
#: Parallel track -> the folder of its extra variants (added to Core-298, which they never touch).
TRACK_DIRS = {"t1": STRATEGIES_DIR.parent / "rotation_t1"}


def variant_names(directory: Path | None = None) -> list[str]:
    names = sorted(p.stem for p in (directory or STRATEGIES_DIR).glob("*.yaml"))
    return names


def track_names(track: str) -> list[str]:
    """The extra variants of a parallel track: its own folder only (callers add Core-298)."""
    return variant_names(TRACK_DIRS[track])


def track_of(name: str) -> str | None:
    """The parallel track a variant belongs to (`t1` for `S_p285-t1s22_0917`), or None (Core)."""
    bits = name.split("_")
    if len(bits) != 3 or "-" not in bits[1]:  # Core-298, or any other stored name: the live folder
        return None
    family = bits[1]
    track = family.split("-", 1)[1].split("s", 1)[0]
    if track not in TRACK_DIRS:
        raise ValueError(f"{name}: unknown track {track!r}")
    return track


def strategy_path(name: str, directory: Path | None = None) -> Path:
    if directory is None:
        track = track_of(name)
        directory = TRACK_DIRS[track] if track else STRATEGIES_DIR
    return directory / f"{name}.yaml"


def parts(name: str) -> tuple[str, str, str]:
    """(index letter, family, HHMM) of a variant name like N_wide_0917 or S_p250_1302."""
    index, family, tag = name.split("_")
    return index, family, tag


def base_family(name: str) -> str:
    """The family before any track tag: `wide` (N_wide-t1s4_0917), `p285` (S_p285-t1s22_0917)."""
    return parts(name)[1].split("-", 1)[0]


def underlying_of(name: str) -> str:
    return UNDERLYING[parts(name)[0]]


def is_wide(name: str) -> bool:
    family = base_family(name)
    # a closest-premium Widesl: Core's p80..p320, or a track's own level (p150, p285)
    return family == "wide" or family in CLOSEST or (family[:1] == "p" and family[1:].isdigit())


def is_dir(name: str) -> bool:
    return base_family(name) in ("dir", "ditm1")


def is_buy(name: str) -> bool:
    return base_family(name) == "buy"
