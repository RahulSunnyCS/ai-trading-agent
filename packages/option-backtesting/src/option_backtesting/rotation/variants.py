"""The 298 whole-day variants: NIFTY / SENSEX x (Widesl, Dir ATM, Dir ITM1, Buy, closest-premium
Widesl) x 25 start times 09:17 .. 15:17 (Buy has none at 15:17). The first 248 are BL-058's
registered universe; the 50 Dir ITM1 files were added on 2026-10-10 (owner, BL-080) before the first
journal entry. Their strategy files are committed under `strategies/rotation/` (copied from the
research folders; never edited, so the forward test cannot drift) and named
`<N|S>_<family>_<HHMM>.yaml`."""

from __future__ import annotations

from pathlib import Path

CLOSEST = ("p80", "p100", "p250", "p320")
STRATEGIES_DIR = Path(__file__).resolve().parents[3] / "strategies" / "rotation"
UNDERLYING = {"N": "NIFTY", "S": "SENSEX"}


def variant_names(directory: Path | None = None) -> list[str]:
    names = sorted(p.stem for p in (directory or STRATEGIES_DIR).glob("*.yaml"))
    return names


def strategy_path(name: str, directory: Path | None = None) -> Path:
    return (directory or STRATEGIES_DIR) / f"{name}.yaml"


def parts(name: str) -> tuple[str, str, str]:
    """(index letter, family, HHMM) of a variant name like N_wide_0917 or S_p250_1302."""
    index, family, tag = name.split("_")
    return index, family, tag


def underlying_of(name: str) -> str:
    return UNDERLYING[parts(name)[0]]


def is_wide(name: str) -> bool:
    family = parts(name)[1]
    return family == "wide" or family in CLOSEST


def is_dir(name: str) -> bool:
    return parts(name)[1] in ("dir", "ditm1")


def is_buy(name: str) -> bool:
    return parts(name)[1] == "buy"
