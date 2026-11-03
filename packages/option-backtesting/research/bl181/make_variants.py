"""BL-181: write the ITM2 / ITM3 Directional variants and the ATM / ITM1 baselines.

    uv run python research/bl181/make_variants.py

Every new file is `strategies/rotation/<I>_ditm1_<HHMM>.yaml` with ONLY the strike type and the
overall stop changed (leg stop 21%, one re-entry at cost, exit 15:28 as in the live Dir). Names:
`<N|S>_ditm<k>_s<stop>_<HHMM>`. The ATM and ITM1 baselines are the rotation files themselves,
copied at the live stop (3,000) under `<N|S>_dir_s3000_<HHMM>` / `<N|S>_ditm1_s3000_<HHMM>` so the
whole study runs from one folder. Output `variants/` is git-ignored.
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).parent
ROT = HERE.parent.parent / "strategies" / "rotation"
OUT = HERE / "variants"
STOPS = (3000, 4000, 5000, 6000, 8000, 10000)  # overall stop grid, rupees (fixed in BL-181 Phase 0)
DEPTHS = (2, 3)
SLOTS = [f"{h:02d}{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47)]
SLOTS = [s for s in SLOTS if "0917" <= s <= "1517"]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.yaml"):
        old.unlink()
    n = 0
    for letter in ("N", "S"):
        for slot in SLOTS:
            # baselines at the live stop, straight from the rotation files
            for fam in ("dir", "ditm1"):
                src = ROT / f"{letter}_{fam}_{slot}.yaml"
                text = src.read_text()
                dst = OUT / f"{letter}_{fam}_s3000_{slot}.yaml"
                text = re.sub(r"id: \S+", f"id: bl181_{dst.stem}", text, count=1)
                dst.write_text(text)
                n += 1
            base = (ROT / f"{letter}_ditm1_{slot}.yaml").read_text()
            assert base.count("ITM1") >= 2 and "stop_loss_inr: 3000" in base, slot
            for k in DEPTHS:
                for stop in STOPS:
                    name = f"{letter}_ditm{k}_s{stop}_{slot}"
                    text = base.replace("strike_type: ITM1", f"strike_type: ITM{k}")
                    text = text.replace("stop_loss_inr: 3000", f"stop_loss_inr: {stop}")
                    text = re.sub(r"id: \S+", f"id: bl181_{name}", text, count=1)
                    assert text.count(f"ITM{k}") >= 2 and f"stop_loss_inr: {stop}" in text
                    (OUT / f"{name}.yaml").write_text(text)
                    n += 1
    print(f"{n} variants in {OUT}")


if __name__ == "__main__":
    main()
