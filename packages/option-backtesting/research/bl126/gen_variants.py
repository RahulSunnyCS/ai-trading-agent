"""BL-126: write the 50 strategy files (X1, X2 x the 25 Core `N_p100_<HHMM>` entry times).

Each file is Core's own text with the leg-level closest premium and stop-loss percent replaced
(plus the strategy id); a parsed comparison then proves nothing else differs.

    uv run python research/bl126/gen_variants.py
"""

from __future__ import annotations

import yaml
from common import ARMS, CORE_DIR, CORE_PREMIUM, CORE_SL, VARIANTS, arm_name, core_names, slot_of


def main() -> None:
    VARIANTS.mkdir(exist_ok=True)
    n_written = 0
    for core in core_names():
        slot = slot_of(core)
        text = (CORE_DIR / f"{core}.yaml").read_text()
        base = yaml.safe_load(text)
        for arm, cfg in ARMS.items():
            name = arm_name(arm, slot)
            new = text
            for old, repl, times in (
                (f"closest_premium: {CORE_PREMIUM} }}", f"closest_premium: {cfg['premium']} }}", 2),
                (
                    f"stop_loss: {{ percent: {CORE_SL} }}",
                    f"stop_loss: {{ percent: {cfg['sl']} }}",
                    2,
                ),
            ):
                assert new.count(old) == times, (core, old, new.count(old))
                new = new.replace(old, repl)
            old_id = base["strategy"]["id"]
            assert new.count(f"id: {old_id}\n") == 1
            new = new.replace(f"id: {old_id}\n", f"id: bl126_{name}\n")
            (VARIANTS / f"{name}.yaml").write_text(new)
            # verify by parsed diff: only id + the two legs' premium and SL differ
            got = yaml.safe_load(new)
            want = yaml.safe_load(text)
            want["strategy"]["id"] = f"bl126_{name}"
            for leg in want["strategy"]["legs"]:
                leg["strike"] = {"closest_premium": cfg["premium"]}
                leg["stop_loss"] = {"percent": cfg["sl"]}
            assert got == want, name
            # and the raw text differs from Core's on exactly the expected lines
            a, b = text.splitlines(), new.splitlines()
            assert len(a) == len(b)
            changed = [i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y]
            expect = 1 + 2 + (2 if cfg["premium"] != CORE_PREMIUM else 0)  # id, 2 SL, 2 premium
            assert len(changed) == expect, (name, changed)
            n_written += 1
    print(f"wrote {n_written} files to {VARIANTS}")


if __name__ == "__main__":
    main()
