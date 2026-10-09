"""BL-056: the 33 SENSEX variants (3 families x 11 start times), generated from the live files.

Bases: Widesl = the live sensex_widesl_917_otm2; Dir = NIFTY Dir with underlying SENSEX and ATM
strikes; Buy = NIFTY Buy with underlying SENSEX. Rupee stops and the Buy premium are unchanged
(owner, 2026-10-09). Written OUTSIDE strategies/legwise/ so `obt daily` never runs them."""

import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
LEGWISE = HERE.parent.parent / "strategies" / "legwise"
BASE = HERE / "base"
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


def sub(pattern: str, repl: str, text: str, count: int) -> str:
    new, n = re.subn(pattern, repl, text)
    assert n == count, (pattern, n, count)
    return new


def bases() -> dict[str, tuple[str, str, str]]:
    """family -> (base yaml text, its strategy id, its entry time)."""
    wide = (LEGWISE / "sensex_widesl_917_otm2.yaml").read_text()
    dir_ = (LEGWISE / "nifty_dir_924_itm1_sl21_recost.yaml").read_text()
    dir_ = sub(r"underlying: NIFTY", "underlying: SENSEX", dir_, 1)
    dir_ = sub(r"strike_type: ITM1", "strike_type: ATM", dir_, 2)
    dir_ = sub(r"id: nifty_dir_924_itm1_sl21_recost\b", "id: sensex_dir_atm", dir_, 1)
    buy = (LEGWISE / "nifty_buy_range_breakout.yaml").read_text()
    buy = sub(r"underlying: NIFTY", "underlying: SENSEX", buy, 1)
    buy = sub(r"id: nifty_buy_range_breakout\b", "id: sensex_buy_range_breakout", buy, 1)
    BASE.mkdir(exist_ok=True)
    (BASE / "sensex_dir_atm.yaml").write_text(dir_)
    (BASE / "sensex_buy_range_breakout.yaml").write_text(buy)
    return {
        "wide": (wide, "sensex_widesl_917_otm2", '"09:17"'),
        "dir": (dir_, "sensex_dir_atm", '"09:24"'),
        "buy": (buy, "sensex_buy_range_breakout", '"09:35"'),
    }


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for key, (base, sid, old_entry) in bases().items():
        for slot in SLOTS:
            tag = slot.replace(":", "")
            t = sub(rf"id: {sid}\b", f"id: bl056_{key}_{tag}", base, 1)
            t = sub(rf"entry_time: {re.escape(old_entry)}", f'entry_time: "{slot}"', t, 1)
            if key == "buy":
                t = sub(r'until: "09:45"', f'until: "{plus(slot, 10)}"', t, 2)
            (OUT / f"{key}_{tag}.yaml").write_text(t)
    print(len(list(OUT.glob("*.yaml"))), "variants written to", OUT)


if __name__ == "__main__":
    sys.exit(main())
