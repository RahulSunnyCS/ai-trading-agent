"""Shared pieces of BL-127: the grid, the cell names, the paths, the windows and the loaders.

Window rule (registered): Stages A and B read no day on or after TEST_START; `read_gross` and
`truncated_root` enforce it in code, Stage C is the only reader of later days.
"""

from __future__ import annotations

import csv
import shutil
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
VARIANTS = HERE / "variants"  # generated, git-ignored (research/.gitignore)
RESULTS = HERE / "results"  # generated, git-ignored
CORE_DIR = HERE.parents[1] / "strategies" / "rotation"

PREMIUMS = (80, 100, 120)
SLS = (60, 70, 80, 90, 100, 115)
#: Core's own files (SL 115 %, trail 15/10, no re-entry, overall 2,500): stored results are used.
CORE_CELLS = {(80, 115): "p80", (100, 115): "p100"}
CORE_PREMIUM, CORE_SL = 100, 115

SELECTION_START = date(2024, 10, 9)
SELECTION_END = date(2025, 10, 8)
ADAPTIVE_SEL_START = date(2025, 1, 10)  # after the 63-day warm-up
TEST_START = date(2025, 10, 9)

BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261019, 0.90
PARITY = ["N_p80_0917", "N_p100_0917"]


def cells() -> list[tuple[int, int]]:
    return [(p, s) for p in PREMIUMS for s in SLS]


def family(premium: int, sl: int) -> str:
    """`p` + digits (so `variants.is_wide` is True), no `-` (so it is not a track). Core's own two
    cells keep their Core family (p80, p100). The digits are premium then SL: p8060 = ₹80, SL 60."""
    if (premium, sl) in CORE_CELLS:
        return CORE_CELLS[(premium, sl)]
    return f"p{premium}{sl}"


def is_core_cell(premium: int, sl: int) -> bool:
    return (premium, sl) in CORE_CELLS


def new_cells() -> list[tuple[int, int]]:
    return [c for c in cells() if not is_core_cell(*c)]


def core_slots() -> list[str]:
    return sorted(p.stem.rsplit("_", 1)[1] for p in CORE_DIR.glob("N_p100_*.yaml"))


def name_of(premium: int, sl: int, slot: str) -> str:
    return f"N_{family(premium, sl)}_{slot}"


def names_of(premium: int, sl: int) -> list[str]:
    return [name_of(premium, sl, s) for s in core_slots()]


def new_names() -> list[str]:
    return [n for c in new_cells() for n in names_of(*c)]


def read_gross(path: Path, last_day: date | None = None) -> dict[date, float]:
    """{day: gross} of a result file. With `last_day`, later days are dropped and the returned days
    are asserted to end on or before it (Stages A and B pass SELECTION_END)."""
    out: dict[date, float] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            d = date.fromisoformat(r["day"])
            if last_day is not None and d > last_day:
                continue
            out[d] = float(r["gross"])
    if last_day is not None and out:
        assert max(out) <= last_day, (path, max(out))
    return out


def truncated_root(
    src_root: Path, dst: Path, names: list[str], new_dir: Path, last_day: date
) -> None:
    """A temporary data root holding only rows on or before `last_day`: `days.csv` and one result
    file per name (Core's from the live store, the new variants' from `new_dir`), written as
    filtered copies. Stage B replays on it, so it cannot read a later day."""
    rot = dst / "rotation"
    res = rot / "results"
    if rot.exists():
        shutil.rmtree(rot)
    res.mkdir(parents=True)
    cut = last_day.isoformat()

    def copy(src: Path, out: Path) -> None:
        with src.open() as f, out.open("w") as g:
            for i, line in enumerate(f):
                if i == 0 or line[:10] <= cut:
                    g.write(line)

    copy(src_root / "rotation" / "days.csv", rot / "days.csv")
    for n in names:
        live = src_root / "rotation" / "results" / f"{n}.csv"
        copy(live if live.exists() else new_dir / f"{n}.csv", res / f"{n}.csv")
    # nothing later than `last_day` is on disk in the temporary root
    for p in [rot / "days.csv", *res.glob("*.csv")]:
        last = p.read_text().strip().splitlines()[-1][:10]
        assert last <= cut, (p, last)
