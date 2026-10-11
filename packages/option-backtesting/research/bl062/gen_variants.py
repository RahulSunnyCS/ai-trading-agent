"""BL-062: the 34 new variants for the whole-day rotation.

NIFTY closest-premium Widesl (80, 100) at the 13 start times 12:02..15:02 and at 15:17 (28), and the
15:17 start for NIFTY and SENSEX Widesl and Dir (4) and SENSEX closest-premium Widesl (250, 320) (2).
Buy has no 15:17 variant (it exits 15:14). Built through research/common/varlib.py; written under
bl062/variants/, never into strategies/legwise/. File names: N_p80_1202.yaml, S_dir_1517.yaml.
`--out DIR` writes somewhere else."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    nifty, sensex = varlib.nifty_bases(), varlib.sensex_bases()

    def write(
        prefix: str,
        name: str,
        family: str,
        base_key: str,
        bases: dict,
        slot: str,
        premium: int | None = None,
    ):
        base, sid, old_entry = bases[base_key]
        text = varlib.with_premium(base, premium) if premium else base
        tag = slot.replace(":", "")
        new_id = f"bl062_{prefix}_{name}_{tag}"
        (out / f"{prefix}_{name}_{tag}.yaml").write_text(
            varlib.make_variant(text, sid, old_entry, new_id, slot, family)
        )

    for premium in (80, 100):  # NIFTY closest premium, the missing afternoon start times
        for slot in varlib.SLOTS_LATE + [varlib.SLOT_LAST]:
            write("N", f"p{premium}", "wide", "wide", nifty, slot, premium)
    for prefix, bases in (("N", nifty), ("S", sensex)):  # the 15:17 start for Widesl and Dir
        for key in ("wide", "dir"):
            write(prefix, key, key, key, bases, varlib.SLOT_LAST)
    for premium in (250, 320):  # SENSEX closest premium at 15:17
        write("S", f"p{premium}", "wide", "wide", sensex, varlib.SLOT_LAST, premium)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
