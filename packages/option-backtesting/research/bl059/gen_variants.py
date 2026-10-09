"""BL-059: the 78 late-session variants (13 start times 12:02..15:02 x 3 families x NIFTY and SENSEX).

Same construction as BL-054 (NIFTY) and BL-056 (SENSEX), through research/common/varlib.py; only
the start times differ. Written under bl059/variants/, never into strategies/legwise/ (`obt
daily` runs every YAML there). File names carry the index: N_wide_1202.yaml. `--out DIR` writes
somewhere else."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    for prefix, bases in (("N", varlib.nifty_bases()), ("S", varlib.sensex_bases())):
        for key, (base, sid, old_entry) in bases.items():
            for slot in varlib.SLOTS_LATE:
                tag = slot.replace(":", "")
                text = varlib.make_variant(
                    base, sid, old_entry, f"bl059_{prefix}_{key}_{tag}", slot, key
                )
                (out / f"{prefix}_{key}_{tag}.yaml").write_text(text)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
