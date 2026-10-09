"""BL-059: the 78 late-session variants (13 start times 12:02..15:02 x 3 families x NIFTY and SENSEX).

Same construction as research/bl054/gen_variants.py (NIFTY) and research/bl056/gen_variants.py
(SENSEX); only the start times differ. Written under research/bl059/variants/, never into
strategies/legwise/ (`obt daily` runs every YAML there). File names carry the index: N_wide_1202.yaml."""

import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl056"))
import gen_variants as sensex  # noqa: E402  (bl056: SENSEX bases)

LEGWISE = HERE.parent.parent / "strategies" / "legwise"
OUT = HERE / "variants"
SLOTS = [
    f"{h:02d}:{m:02d}"
    for h, m in [
        (12, 2),
        (12, 17),
        (12, 32),
        (12, 47),
        (13, 2),
        (13, 17),
        (13, 32),
        (13, 47),
        (14, 2),
        (14, 17),
        (14, 32),
        (14, 47),
        (15, 2),
    ]
]


def sub(pattern: str, repl: str, text: str, count: int) -> str:
    new, n = re.subn(pattern, repl, text)
    assert n == count, (pattern, n, count)
    return new


def nifty_bases() -> dict[str, tuple[str, str, str]]:
    wide = (LEGWISE / "nifty_widesl_917_otm1.yaml").read_text()
    dir_ = (LEGWISE / "nifty_dir_924_itm1_sl21_recost.yaml").read_text()
    dir_ = sub(r"strike_type: ITM1", "strike_type: ATM", dir_, 2)
    buy = (LEGWISE / "nifty_buy_range_breakout.yaml").read_text()
    return {
        "wide": (wide, "nifty_widesl_917_otm1", '"09:17"'),
        "dir": (dir_, "nifty_dir_924_itm1_sl21_recost", '"09:24"'),
        "buy": (buy, "nifty_buy_range_breakout", '"09:35"'),
    }


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for prefix, bases in (("N", nifty_bases()), ("S", sensex.bases())):
        for key, (base, sid, old_entry) in bases.items():
            for slot in SLOTS:
                tag = slot.replace(":", "")
                t = sub(rf"id: {sid}\b", f"id: bl059_{prefix}_{key}_{tag}", base, 1)
                t = sub(rf"entry_time: {re.escape(old_entry)}", f'entry_time: "{slot}"', t, 1)
                if key == "buy":
                    t = sub(r'until: "09:45"', f'until: "{sensex.plus(slot, 10)}"', t, 2)
                (OUT / f"{prefix}_{key}_{tag}.yaml").write_text(t)
    print(len(list(OUT.glob("*.yaml"))), "variants written to", OUT)


if __name__ == "__main__":
    sys.exit(main())
