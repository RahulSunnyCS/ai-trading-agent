"""BL-060: the 48 SENSEX Widesl closest-premium variants ({250, 320} x 24 start times 09:17..15:02).

Base = the live sensex_widesl_917_otm2 with both legs' strike set by closest premium
(research/common/varlib.py); everything else unchanged. Written under bl060/variants/, never into
strategies/legwise/ (`obt daily` runs every YAML there). File names: p250_0917.yaml.
`--out DIR` writes somewhere else."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

PREMIUMS = (250, 320)


def main() -> None:
    out = varlib.out_dir(HERE / "variants")
    out.mkdir(parents=True, exist_ok=True)
    base, sid, old_entry = varlib.sensex_bases()["wide"]
    for premium in PREMIUMS:
        text = varlib.with_premium(base, premium)
        for slot in varlib.SLOTS_MORNING + varlib.SLOTS_LATE:
            tag = slot.replace(":", "")
            variant = varlib.make_variant(
                text, sid, old_entry, f"bl060_S_p{premium}_{tag}", slot, "wide"
            )
            (out / f"p{premium}_{tag}.yaml").write_text(variant)
    print(len(list(out.glob("*.yaml"))), "variants written to", out)


if __name__ == "__main__":
    sys.exit(main())
