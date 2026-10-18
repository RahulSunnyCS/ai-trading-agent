"""BL-128: write the 18 cells x 25 slots = 450 strategy files from Core's `S_p250_<HHMM>` text.

Only both legs' closest premium and stop-loss percent (and the strategy id) change; the same SL goes
on both legs (Core's 114 % call / 115 % put split is not reproduced). A parsed comparison and a line
comparison against the Core source prove nothing else differs. First confirms that Core's
`S_p320_<HHMM>` equals `S_p250_<HHMM>` apart from the id and the premium for all 25 slots, and that
no generated id clashes with a Core, T1, BL-126 or BL-127 id and each parses as a Widesl on SENSEX.

    uv run python research/bl128/gen_variants.py
"""

from __future__ import annotations

import yaml
from common import (
    CORE_BASE,
    CORE_CALL_SL,
    CORE_DIR,
    CORE_PREMIUM,
    CORE_PUT_SL,
    UNDERLYING,
    VARIANTS,
    core_slots,
    name_of,
    new_cells,
)

from option_backtesting.rotation import variants as rv


def check_core_p320_equals_p250() -> None:
    for slot in core_slots():
        a = yaml.safe_load((CORE_DIR / f"S_p320_{slot}.yaml").read_text())
        b = yaml.safe_load((CORE_DIR / f"{CORE_BASE}_{slot}.yaml").read_text())
        for leg in a["strategy"]["legs"]:
            leg["strike"] = {"closest_premium": CORE_PREMIUM}
        a["strategy"]["id"] = b["strategy"]["id"] = "x"
        assert a == b, f"Core S_p320_{slot} differs from {CORE_BASE}_{slot} beyond id and premium"


def other_ids() -> set[str]:
    """Names already in use: Core-298, T1, and the BL-127 (NIFTY) / BL-126 name families."""
    taken = set(rv.variant_names()) | set(rv.track_names("t1"))
    slots = core_slots()
    for premium in (80, 100, 120):  # BL-127 grid (NIFTY): N_p<premium><SL>_<HHMM>
        for sl in (60, 70, 80, 90, 100, 115):
            taken |= {f"N_p{premium}{sl}_{s}" for s in slots}
    return taken


def main() -> None:
    check_core_p320_equals_p250()
    VARIANTS.mkdir(exist_ok=True)
    taken = other_ids()
    n_written = 0
    for slot in core_slots():
        core = f"{CORE_BASE}_{slot}"
        text = (CORE_DIR / f"{core}.yaml").read_text()
        base = yaml.safe_load(text)
        old_id = base["strategy"]["id"]
        for premium, sl in new_cells():
            name = name_of(premium, sl, slot)
            assert name not in taken, f"{name} clashes with an existing variant"
            new = text
            assert new.count(f"closest_premium: {CORE_PREMIUM} }}") == 2
            new = new.replace(
                f"closest_premium: {CORE_PREMIUM} }}", f"closest_premium: {premium} }}"
            )
            # each leg's own SL value -> the cell's SL (done per line: 114 / 115 may equal `sl`)
            lines = new.splitlines(keepends=True)
            for want_old in (CORE_CALL_SL, CORE_PUT_SL):
                hit = [
                    i for i, ln in enumerate(lines) if f"stop_loss: {{ percent: {want_old} }}" in ln
                ]
                assert len(hit) == 1, (core, want_old, hit)
                i = hit[0]
                lines[i] = lines[i].replace(f"percent: {want_old} }}", f"percent: @{sl} }}")
            new = "".join(lines).replace("percent: @", "percent: ")
            assert new.count(f"id: {old_id}\n") == 1
            new = new.replace(f"id: {old_id}\n", f"id: bl128_{name}\n")
            (VARIANTS / f"{name}.yaml").write_text(new)
            got = yaml.safe_load(new)
            want = yaml.safe_load(text)
            want["strategy"]["id"] = f"bl128_{name}"
            for leg in want["strategy"]["legs"]:
                leg["strike"] = {"closest_premium": premium}
                leg["stop_loss"] = {"percent": sl}
            assert got == want, name
            a, b = text.splitlines(), new.splitlines()
            assert len(a) == len(b)
            changed = [i for i, (x, y) in enumerate(zip(a, b, strict=True)) if x != y]
            # id, both premiums, and each leg's SL line unless the value is already the leg's own
            expect = 1 + 2 + (sl != CORE_CALL_SL) + (sl != CORE_PUT_SL)
            assert len(changed) == expect, (name, changed)
            # parses as a Widesl on SENSEX, not a track
            assert rv.is_wide(name) and rv.underlying_of(name) == UNDERLYING, name
            assert rv.track_of(name) is None and not rv.is_dir(name) and not rv.is_buy(name), name
            n_written += 1
    assert n_written == 18 * 25, n_written
    ids = {p.stem for p in VARIANTS.glob("*.yaml")}
    assert len(ids) == 450
    print(
        f"wrote {n_written} files to {VARIANTS}; Core S_p320 == S_p250 apart from id and premium "
        "for all 25 slots"
    )


if __name__ == "__main__":
    main()
