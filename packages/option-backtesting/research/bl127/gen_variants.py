"""BL-127: write the 16 new cells x 25 slots = 400 strategy files from Core's `N_p100_<HHMM>` text.

Only both legs' closest premium and stop-loss percent (and the strategy id) change; a parsed
comparison and a line comparison against the Core source prove nothing else differs. Core's own
N_p80 / N_p100 files (SL 115) are not regenerated. First confirms Core's `N_p80_<HHMM>` equals
`N_p100_<HHMM>` apart from the id and the premium (so the 115 % cells of both premiums are the same
strategy as the generated ones would be).

    uv run python research/bl127/gen_variants.py
"""

from __future__ import annotations

import yaml
from common import (
    CORE_DIR,
    CORE_PREMIUM,
    CORE_SL,
    VARIANTS,
    core_slots,
    name_of,
    new_cells,
)


def check_core_p80_equals_p100() -> None:
    for slot in core_slots():
        a = yaml.safe_load((CORE_DIR / f"N_p80_{slot}.yaml").read_text())
        b = yaml.safe_load((CORE_DIR / f"N_p100_{slot}.yaml").read_text())
        for leg in b["strategy"]["legs"]:
            leg["strike"] = {"closest_premium": 80}
        a["strategy"]["id"] = b["strategy"]["id"] = "x"
        assert a == b, f"Core N_p80_{slot} differs from N_p100_{slot} beyond id and premium"


def main() -> None:
    check_core_p80_equals_p100()
    VARIANTS.mkdir(exist_ok=True)
    n_written = 0
    for slot in core_slots():
        core = f"N_p100_{slot}"
        text = (CORE_DIR / f"{core}.yaml").read_text()
        base = yaml.safe_load(text)
        old_id = base["strategy"]["id"]
        for premium, sl in new_cells():
            name = name_of(premium, sl, slot)
            new = text
            for old, repl, times in (
                (f"closest_premium: {CORE_PREMIUM} }}", f"closest_premium: {premium} }}", 2),
                (f"stop_loss: {{ percent: {CORE_SL} }}", f"stop_loss: {{ percent: {sl} }}", 2),
            ):
                assert new.count(old) == times, (core, old, new.count(old))
                new = new.replace(old, repl)
            assert new.count(f"id: {old_id}\n") == 1
            new = new.replace(f"id: {old_id}\n", f"id: bl127_{name}\n")
            (VARIANTS / f"{name}.yaml").write_text(new)
            got = yaml.safe_load(new)
            want = yaml.safe_load(text)
            want["strategy"]["id"] = f"bl127_{name}"
            for leg in want["strategy"]["legs"]:
                leg["strike"] = {"closest_premium": premium}
                leg["stop_loss"] = {"percent": sl}
            assert got == want, name
            a, b = text.splitlines(), new.splitlines()
            assert len(a) == len(b)
            changed = [i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y]
            expect = 1 + (2 if sl != CORE_SL else 0) + (2 if premium != CORE_PREMIUM else 0)
            assert len(changed) == expect, (name, changed)
            n_written += 1
    assert n_written == 16 * 25, n_written
    ids = {p.stem for p in VARIANTS.glob("*.yaml")}
    assert len(ids) == 400
    print(f"wrote {n_written} files to {VARIANTS}; Core N_p80 == N_p100 apart from id and premium")


if __name__ == "__main__":
    main()
