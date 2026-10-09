"""BL-054: write the 33 variant YAMLs (3 families x 11 start times) next to this file.

Generated from the live strategy files so nothing else drifts. They live OUTSIDE
strategies/legwise/ on purpose: `obt daily` runs every YAML in that folder."""

import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
LEGWISE = HERE.parent.parent / "strategies" / "legwise"
OUT = HERE / "variants"
SLOTS = [
    "09:17",
    "09:32",
    "09:47",
    "10:02",
    "10:17",
    "10:32",
    "10:47",
    "11:02",
    "11:17",
    "11:32",
    "11:47",
]


def plus(hhmm: str, minutes: int) -> str:
    h, m = map(int, hhmm.split(":"))
    t = h * 60 + m + minutes
    return f"{t // 60:02d}:{t % 60:02d}"


def sub1(pattern: str, repl: str, text: str, count: int) -> str:
    new, n = re.subn(pattern, repl, text)
    assert n == count, (pattern, n, count)
    return new


def main() -> None:
    OUT.mkdir(exist_ok=True)
    fam = {
        "wide": (LEGWISE / "nifty_widesl_917_otm1.yaml", "nifty_widesl_917_otm1", '"09:17"'),
        "dir": (
            LEGWISE / "nifty_dir_924_itm1_sl21_recost.yaml",
            "nifty_dir_924_itm1_sl21_recost",
            '"09:24"',
        ),
        "buy": (LEGWISE / "nifty_buy_range_breakout.yaml", "nifty_buy_range_breakout", '"09:35"'),
    }
    for key, (path, sid, old_entry) in fam.items():
        base = path.read_text()
        for slot in SLOTS:
            tag = slot.replace(":", "")
            t = sub1(rf"id: {sid}\b", f"id: bl054_{key}_{tag}", base, 1)
            t = sub1(rf"entry_time: {re.escape(old_entry)}", f'entry_time: "{slot}"', t, 1)
            if key == "dir":
                t = sub1(r"strike_type: ITM1", "strike_type: ATM", t, 2)
            if key == "buy":
                t = sub1(r'until: "09:45"', f'until: "{plus(slot, 10)}"', t, 2)
            (OUT / f"{key}_{tag}.yaml").write_text(t)
    print(len(list(OUT.glob("*.yaml"))), "variants written to", OUT)


if __name__ == "__main__":
    sys.exit(main())
