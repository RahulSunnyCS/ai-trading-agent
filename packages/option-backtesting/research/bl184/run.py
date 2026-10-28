"""BL-184: the Directional split session — Adaptive's one Dir 09:17-13:00 plus one 13:02-15:28
against its one whole-day Dir, Core's four Dir families.

    uv run python research/bl184/run.py [--smoke] [--analyse-only]

Pre-registered in backlog/BL-184-directional-split-session.md before this ran. The machinery is
research/common/split_replay.py (BL-182 Phase 2's, generalised). Writes variants_split/,
results_split/ (the morning files), results_wholeday/ (the Core files) and out/split_*.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import split_replay as sr  # noqa: E402

SPEC = sr.Spec(
    here=HERE,
    families={"N_dir": "NIFTY", "N_ditm1": "NIFTY", "S_dir": "SENSEX", "S_ditm1": "SENSEX"},
    slots_am=sr.slots("0917", "1247"),
    slots_pm=sr.slots("1302", "1502"),
    am_exit="13:00",
    n_pick=1,
    margin_lots=1,
    title="BL-184 — one Dir 09:17–13:00 + one 13:02–15:28 vs one whole-day Dir (Core's four Dir families)",
)


def main() -> None:
    smoke = "--smoke" in sys.argv
    if "--analyse-only" not in sys.argv:
        sr.run_all(SPEC, smoke)
    if smoke:
        return
    text = sr.analyse(SPEC)
    fixed = [sr.fixed_split(SPEC, fam, "0917", "1302") for fam in ("N_dir", "S_dir")]
    extra = "\nFixed files, descriptive:\n" + "\n".join(f"- {line}" for line in fixed) + "\n"
    (SPEC.out / f"{SPEC.tag}_summary.md").write_text(text + extra)
    print(text + extra)


if __name__ == "__main__":
    main()
