"""Shared construction for the research variant generators (BL-054, BL-056, BL-059).

One place for the start-time slots and for how a variant YAML is derived from a live strategy
file, so the generators cannot drift apart and none of them imports another. Nothing here writes
files; each generator decides where its output goes (always outside strategies/legwise/, because
`obt daily` runs every YAML in that folder)."""

import re
import sys
from pathlib import Path

LEGWISE = Path(__file__).resolve().parents[2] / "strategies" / "legwise"
SLOTS_MORNING = [
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
SLOTS_LATE = [
    "12:02",
    "12:17",
    "12:32",
    "12:47",
    "13:02",
    "13:17",
    "13:32",
    "13:47",
    "14:02",
    "14:17",
    "14:32",
    "14:47",
    "15:02",
]

# the last 15-minute start before 15:30 (BL-062); Widesl and Dir exit 15:28, Buy exits 15:14 and has none
SLOT_LAST = "15:17"


def plus(hhmm: str, minutes: int) -> str:
    h, m = map(int, hhmm.split(":"))
    t = h * 60 + m + minutes
    return f"{t // 60:02d}:{t % 60:02d}"


def sub(pattern: str, repl: str, text: str, count: int) -> str:
    """re.sub that insists on exactly `count` replacements (a changed base file fails loudly)."""
    new, n = re.subn(pattern, repl, text)
    assert n == count, (pattern, n, count)
    return new


def nifty_bases() -> dict[str, tuple[str, str, str]]:
    """family -> (base YAML text, its strategy id, its entry time as written in the file).
    Dir is the live ITM1 strategy turned into ATM; Widesl and Buy are the live files."""
    dir_ = (LEGWISE / "nifty_dir_924_itm1_sl21_recost.yaml").read_text()
    return {
        "wide": (
            (LEGWISE / "nifty_widesl_917_otm1.yaml").read_text(),
            "nifty_widesl_917_otm1",
            '"09:17"',
        ),
        "dir": (
            sub(r"strike_type: ITM1", "strike_type: ATM", dir_, 2),
            "nifty_dir_924_itm1_sl21_recost",
            '"09:24"',
        ),
        "buy": (
            (LEGWISE / "nifty_buy_range_breakout.yaml").read_text(),
            "nifty_buy_range_breakout",
            '"09:35"',
        ),
    }


def sensex_bases() -> dict[str, tuple[str, str, str]]:
    """Widesl = the live sensex_widesl_917_otm2; Dir and Buy = the NIFTY files with the
    underlying changed (Dir with ATM strikes). Rupee stops and the Buy premium unchanged."""
    dir_ = sub(r"underlying: NIFTY", "underlying: SENSEX", nifty_bases()["dir"][0], 1)
    dir_ = sub(r"id: nifty_dir_924_itm1_sl21_recost\b", "id: sensex_dir_atm", dir_, 1)
    buy = sub(r"underlying: NIFTY", "underlying: SENSEX", nifty_bases()["buy"][0], 1)
    buy = sub(r"id: nifty_buy_range_breakout\b", "id: sensex_buy_range_breakout", buy, 1)
    return {
        "wide": (
            (LEGWISE / "sensex_widesl_917_otm2.yaml").read_text(),
            "sensex_widesl_917_otm2",
            '"09:17"',
        ),
        "dir": (dir_, "sensex_dir_atm", '"09:24"'),
        "buy": (buy, "sensex_buy_range_breakout", '"09:35"'),
    }


def make_variant(base: str, sid: str, old_entry: str, new_id: str, slot: str, family: str) -> str:
    """The base strategy with a new id and entry time; Buy's range window moves with it
    (start + 10 minutes, as in the live 09:35 -> 09:45)."""
    t = sub(rf"id: {sid}\b", f"id: {new_id}", base, 1)
    t = sub(rf"entry_time: {re.escape(old_entry)}", f'entry_time: "{slot}"', t, 1)
    if family == "buy":
        t = sub(r'until: "09:45"', f'until: "{plus(slot, 10)}"', t, 2)
    return t


def require(path, how: str):
    """Read a per-day result CSV (net P&L by day), or stop with the command that creates it."""
    import pandas as pd

    if not Path(path).exists():
        raise SystemExit(
            f"missing {path}\ncreate it from the live strategy file:\n  {how}\n"
            "(research/bl054/run_variant.py writes research/bl054/results/<strategy>.csv)"
        )
    return pd.read_csv(path, parse_dates=["day"]).set_index("day").net


def live_csv(results_dir, name: str):
    """The per-day net P&L of a live strategy (strategies/legwise/<name>.yaml) from
    <results_dir>/<name>.csv."""
    return require(
        Path(results_dir) / f"{name}.csv",
        "cd packages/option-backtesting && uv run python research/bl054/run_variant.py "
        f"strategies/legwise/{name}.yaml",
    )


def with_premium(text: str, premium: int) -> str:
    """The strategy with both legs' strike set by closest premium instead of a strike offset
    (SENSEX Widesl OTM2 -> closest_premium; NIFTY's OTM1 file uses the same shape)."""
    return sub(
        r"strike: \{ strike_type: OTM\d+ \}", f"strike: {{ closest_premium: {premium} }}", text, 2
    )


def variant_file(name: str, kind: str) -> Path:
    """Where a rotation variant's files live. `name` is like N_wide_0917 or S_p250_1202 (index, family,
    start time); `kind` is "results" (per-day net P&L, .csv) or "variants" (the strategy YAML, .yaml).
    Which folder holds a variant depends on which research item ran its start time."""
    research = Path(__file__).resolve().parents[1]
    prefix, family, tag = name.split("_")
    slot = f"{tag[:2]}:{tag[2:]}"
    nifty = prefix == "N"
    early, last = slot in SLOTS_MORNING, slot == SLOT_LAST
    if family in ("wide", "dir", "buy"):
        if early:
            folder, stem = ("bl054" if nifty else "bl056"), f"{family}_{tag}"
        else:
            folder, stem = ("bl062" if last else "bl059"), f"{prefix}_{family}_{tag}"
    elif early:  # closest-premium Widesl: p80 / p100 (NIFTY), p250 / p320 (SENSEX)
        folder, stem = ("bl061" if nifty else "bl060"), f"{family}_{tag}"
    elif last or nifty:
        folder, stem = "bl062", f"{prefix}_{family}_{tag}"
    else:
        folder, stem = "bl060", f"{family}_{tag}"
    return research / folder / kind / f"{stem}.{'csv' if kind == 'results' else 'yaml'}"


def out_dir(default: Path) -> Path:
    """Output folder: `--out DIR` on the command line, else the default."""
    if "--out" in sys.argv:
        return Path(sys.argv[sys.argv.index("--out") + 1])
    return default
