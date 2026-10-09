"""BL-056: write the 33 SENSEX variant YAMLs (3 families x 11 start times) into variants/.

Bases (research/common/varlib.py): Widesl = the live sensex_widesl_917_otm2; Dir = NIFTY Dir with
underlying SENSEX and ATM strikes; Buy = NIFTY Buy with underlying SENSEX. Rupee stops and the Buy
premium are unchanged (owner, 2026-10-09). Written OUTSIDE strategies/legwise/ so `obt daily`
never runs them. `--out DIR` writes somewhere else."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    for key, (base, sid, old_entry) in varlib.sensex_bases().items():
        for slot in varlib.SLOTS_MORNING:
            tag = slot.replace(":", "")
            text = varlib.make_variant(base, sid, old_entry, f"bl056_{key}_{tag}", slot, key)
            (out / f"{key}_{tag}.yaml").write_text(text)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
