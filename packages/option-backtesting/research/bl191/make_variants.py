"""BL-191 Amendment 1: write the C1 / C2 Widesl variants and the two parity copies.

    uv run python research/bl191/make_variants.py

For each of the 25 rotation start times (09:17 -> 15:17), into `variants/` (git-ignored):

    N_wide-c1_<HHMM>    strategies/rotation/N_wide_<HHMM>.yaml, overall stop 2,500 -> 3,000
    N_wide-c2_<HHMM>    strategies/rotation_t1/N_wide-t1s4_<HHMM>.yaml, leg stop 150 -> 115 %,
                        overall stop 4,000 -> 3,000
    N_wide-pbase_<HHMM> N_wide_<HHMM> unchanged (parity with the stored results)
    N_wide-ps4_<HHMM>   N_wide-t1s4_<HHMM> unchanged (parity with the stored results)
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).parent
STRATEGIES = HERE.parent.parent / "strategies"
OUT = HERE / "variants"
SLOTS = [s for s in (f"{h:02d}{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47)) if "0917" <= s <= "1517"]  # fmt: skip


def write(name: str, text: str) -> None:
    text = re.sub(r"id: \S+", f"id: bl191_{name}", text, count=1)
    (OUT / f"{name}.yaml").write_text(text)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.yaml"):
        old.unlink()
    assert len(SLOTS) == 25
    for slot in SLOTS:
        base = (STRATEGIES / "rotation" / f"N_wide_{slot}.yaml").read_text()
        s4 = (STRATEGIES / "rotation_t1" / f"N_wide-t1s4_{slot}.yaml").read_text()
        assert base.count("percent: 115") == 2 and base.count("stop_loss_inr: 2500") == 1, slot
        assert s4.count("percent: 150.0") == 2 and s4.count("stop_loss_inr: 4000.0") == 1, slot
        write(f"N_wide-pbase_{slot}", base)
        write(f"N_wide-ps4_{slot}", s4)
        write(f"N_wide-c1_{slot}", base.replace("stop_loss_inr: 2500", "stop_loss_inr: 3000"))
        c2 = s4.replace("percent: 150.0", "percent: 115.0")
        write(f"N_wide-c2_{slot}", c2.replace("stop_loss_inr: 4000.0", "stop_loss_inr: 3000.0"))
    print(f"{4 * len(SLOTS)} variants in {OUT}")


if __name__ == "__main__":
    main()
