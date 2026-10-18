"""Shared pieces of the BL-126 POC: the two arms, their file names, the paths."""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).parent
VARIANTS = HERE / "variants"  # generated, git-ignored (research/.gitignore)
RESULTS = HERE / "results"  # generated, git-ignored
CORE_DIR = HERE.parents[1] / "strategies" / "rotation"

#: arm -> (closest premium, SL percent, family tag in the variant name)
#: The family is `p` + digits so `variants.is_wide` is True without touching the code; no `-`, so
#: it is not a track; it clashes with no Core (p80/p100/p250/p320) or T1 (p150, p285, ...) family.
ARMS = {
    "X1": {"premium": 100, "sl": 75, "family": "p10075"},
    "X2": {"premium": 120, "sl": 60, "family": "p12060"},
}
CORE_PREMIUM, CORE_SL = 100, 115


def core_names() -> list[str]:
    return sorted(p.stem for p in CORE_DIR.glob("N_p100_*.yaml"))


def slot_of(name: str) -> str:
    return name.rsplit("_", 1)[1]


def arm_name(arm: str, slot: str) -> str:
    return f"N_{ARMS[arm]['family']}_{slot}"


def arm_names(arm: str) -> list[str]:
    return [arm_name(arm, slot_of(n)) for n in core_names()]
