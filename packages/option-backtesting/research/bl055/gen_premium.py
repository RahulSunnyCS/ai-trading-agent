"""BL-055: Widesl OTM1 with the strike set by closest premium (80 or 100), at 3 start times."""

import re
from pathlib import Path

HERE = Path(__file__).parent
base = (HERE.parent.parent / "strategies" / "legwise" / "nifty_widesl_917_otm1.yaml").read_text()
for prem in (80, 100):
    for slot in ("09:17", "09:32", "10:02"):
        t = re.sub(
            r"id: nifty_widesl_917_otm1\b", f"id: bl055_p{prem}_{slot.replace(':', '')}", base
        )
        t, n1 = re.subn(
            r"strike: \{ strike_type: OTM1 \}", f"strike: {{ closest_premium: {prem} }}", t
        )
        t, n2 = re.subn(r'entry_time: "09:17"', f'entry_time: "{slot}"', t)
        assert n1 == 2 and n2 == 1, (prem, slot, n1, n2)
        (HERE / "variants" / f"p{prem}_{slot.replace(':', '')}.yaml").write_text(t)
print(len(list((HERE / "variants").glob("*.yaml"))), "premium variants written")
