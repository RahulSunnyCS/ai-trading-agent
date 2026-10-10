"""BL-054: write the 33 NIFTY variant YAMLs (3 families x 11 start times) into variants/.

Generated from the live strategy files (research/common/varlib.py) so nothing else drifts. They
live OUTSIDE strategies/legwise/ on purpose: `obt daily` runs every YAML in that folder.
`--out DIR` writes somewhere else."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    for key, (base, sid, old_entry) in varlib.nifty_bases().items():
        for slot in varlib.SLOTS_MORNING:
            tag = slot.replace(":", "")
            text = varlib.make_variant(base, sid, old_entry, f"bl054_{key}_{tag}", slot, key)
            (out / f"{key}_{tag}.yaml").write_text(text)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
