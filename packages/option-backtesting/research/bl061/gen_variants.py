"""BL-061: the 22 NIFTY closest-premium Widesl variants ({80, 100} x 11 start times 09:17..11:47).

Base = the live nifty_widesl_917_otm1 with both legs' strike set by closest premium
(research/common/varlib.py); nothing else changed. Written under bl061/variants/, never into
strategies/legwise/ (`obt daily` runs every YAML there). File names: p80_0917.yaml.
`--out DIR` writes somewhere else. The SENSEX counterparts are BL-060's."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

PREMIUMS = (80, 100)


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    base, sid, old_entry = varlib.nifty_bases()["wide"]
    for premium in PREMIUMS:
        text = varlib.with_premium(base, premium)
        for slot in varlib.SLOTS_MORNING:
            tag = slot.replace(":", "")
            new_id = f"bl061_N_p{premium}_{tag}"
            variant = varlib.make_variant(text, sid, old_entry, new_id, slot, "wide")
            (out / f"p{premium}_{tag}.yaml").write_text(variant)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
