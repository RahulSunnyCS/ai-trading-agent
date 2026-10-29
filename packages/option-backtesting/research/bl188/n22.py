"""BL-188 Phase 1: the N22 set — every NIFTY variant of Core-298 and T1 simulated over NIFTY
2022-01-03 -> 2024-10-31 with A0's engine, sizing, reference fallback and charges (one CSV a variant,
A0's columns, under research/bl188/n22/, git-ignored), the day attributes for those days, and the
parity gates (backlog/BL-188 Phase 0). Days after 2024-10-08 are simulated only for gate 1.

    uv run python research/bl188/n22.py simulate [--shard I/N]    # resumable, one process a shard
    uv run python research/bl188/n22.py attrs                     # out/n22_days.csv
    BL187_A0=<A0 folder> uv run python research/bl188/n22.py gates
"""

from __future__ import annotations

import csv
import os
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import split_replay as sr  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import backtest_days  # noqa: E402
from option_backtesting.rotation import attrs as at  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.dte import from_calendar_label  # noqa: E402

N22 = HERE / "n22"
OUT = HERE / "out"
DAYS_CSV = OUT / "n22_days.csv"
START, END, GATE_END = date(2022, 1, 3), date(2024, 10, 8), date(2024, 10, 31)
A0 = Path(os.environ.get("BL187_A0") or HERE.parent / "bl185" / "a0")
SENSEX_LABEL = "unknown"  # no SENSEX variant is in a NIFTY-only pool


def nifty_files() -> dict[str, Path]:
    files = {p.stem: p for p in sorted(sr.ROTATION.glob("N_*.yaml"))}
    files |= {p.stem: p for p in sorted((sr.ROTATION.parent / "rotation_t1").glob("N_*.yaml"))}
    return files


def simulate(shard: tuple[int, int]) -> None:
    N22.mkdir(parents=True, exist_ok=True)
    i, n = shard
    files = nifty_files()
    todo = {k: p for j, (k, p) in enumerate(files.items()) if j % n == i}
    todo = {k: p for k, p in todo.items() if not (N22 / f"{k}.csv").exists()}
    print(f"shard {i}/{n}: {len(todo)} variants to simulate", flush=True)
    # in chunks, so a stopped run keeps what it finished
    names = list(todo)
    for c in range(0, len(names), 12):
        chunk = {k: todo[k] for k in names[c : c + 12]}
        res = sr.simulate("NIFTY", chunk, START, GATE_END)
        for k, rows in res.items():
            tmp = N22 / f"{k}.csv.tmp"
            with open(tmp, "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(sr.COLUMNS)
                w.writerows(rows)
            tmp.rename(N22 / f"{k}.csv")
        print(f"shard {i}/{n}: {min(c + 12, len(names))}/{len(names)} written", flush=True)


def day_row(root: Path, d: date) -> dict:
    vix = at.vix_open_from_lake(root, d)
    exp = at.nearest_expiry(root, "NIFTY", d)
    cal = at.dte_label(None if exp is None else (exp - d).days)
    return {
        "day": d.isoformat(),
        "weekday": d.strftime("%a"),
        "vix_open": "" if vix is None else round(vix, 4),
        "vix_band": at.vix_band(vix),
        "dte_n": from_calendar_label(cal, d),
        "dte_s": SENSEX_LABEL,
    }


def write_attrs() -> None:
    root = data_dir()
    days, _ = backtest_days(root, "NIFTY", START, END)
    OUT.mkdir(exist_ok=True)
    with open(DAYS_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=store.DAY_COLUMNS)
        w.writeheader()
        for d in days:
            w.writerow(day_row(root, d))
    print(f"{len(days)} days -> {DAYS_CSV}")


def read_attrs() -> dict[date, dict[str, str]]:
    with open(DAYS_CSV) as f:
        return {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}


def gates() -> list[str]:
    """(1) N22 rows for 2024-10-09 -> 2024-10-31 equal A0's; (2) the attributes computed this way
    equal the stored days.csv (band, NIFTY label) on every stored day."""
    L = ["## N22 parity gates", ""]
    ok = True
    n_cmp = bad = 0
    worst = 0.0
    files = sorted(N22.glob("*.csv"))
    for f in files:
        a0f = A0 / f.name
        if not a0f.exists():
            raise SystemExit(f"no A0 row file {a0f}: set BL187_A0")
        with open(a0f) as fh:
            a0 = {r["day"]: r for r in csv.DictReader(fh)}
        with open(f) as fh:
            for r in csv.DictReader(fh):
                d = date.fromisoformat(r["day"])
                if d <= END or r["day"] not in a0:
                    continue
                n_cmp += 1
                g = abs(float(r["gross"]) - float(a0[r["day"]]["gross"]))
                worst = max(worst, g)
                if g > 1.0 or r["orders"] != a0[r["day"]]["orders"]:
                    bad += 1
    ok &= bad == 0 and n_cmp > 0
    L.append(
        f"1. {len(files)} variants, {n_cmp} variant-days 2024-10-09 → 2024-10-31 against A0: "
        f"{n_cmp - bad} equal (gross within ₹1, orders equal); largest gross difference "
        f"₹{worst:.2f}. {'PASS' if bad == 0 and n_cmp else 'FAIL'}"
    )
    root = data_dir()
    stored = store.read_days(root, "weekdays")
    diff = []
    for d, r in sorted(stored.items()):
        mine = day_row(root, d)
        if mine["vix_band"] != r["vix_band"] or mine["dte_n"] != r["dte_n"]:
            diff.append((d, (mine["vix_band"], mine["dte_n"]), (r["vix_band"], r["dte_n"])))
    ok &= not diff
    L.append(
        f"2. Day attributes on the {len(stored)} stored days, computed as for N22: band and NIFTY "
        f"label equal on {len(stored) - len(diff)}"
        + (f"; differ on {diff[:5]}" if diff else "")
        + f". {'PASS' if not diff else 'FAIL'}"
    )
    L += ["", f"**N22 gates: {'all pass' if ok else 'FAILED'}**", ""]
    OUT.mkdir(exist_ok=True)
    (OUT / "n22_gates.md").write_text("\n".join(L))
    print("\n".join(L))
    if not ok:
        raise SystemExit("N22 gate failed")
    return L


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "simulate":
        shard = (0, 1)
        if "--shard" in sys.argv:
            a, b = sys.argv[sys.argv.index("--shard") + 1].split("/")
            shard = (int(a), int(b))
        simulate(shard)
    elif cmd == "attrs":
        write_attrs()
    elif cmd == "gates":
        gates()
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
