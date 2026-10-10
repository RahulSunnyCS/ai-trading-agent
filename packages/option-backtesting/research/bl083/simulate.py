"""BL-083 phase 1: simulate each template at every trigger's entry minute and at its placebo days.

    uv run --with pandas --with numpy --with duckdb python research/bl083/simulate.py --validate
    uv run --with pandas --with numpy --with duckdb python research/bl083/simulate.py [workers]

Templates are the live shapes taken from strategies/rotation/{N|S}_{wide,dir,buy}_1202.yaml with only
the entry time changed (Buy's range window moves with it: entry + 10 minutes). Placebo = the same
template at the same minute on the 20 nearest days (10 before, 10 after) with no event of that trigger
in the same set and index. Day data is loaded once per (index, day). Results are cached per key in
results/sims.csv (resumable). lot_sizing current, sizing date 2026-10-12, costs as the research (net =
gross - costs, costs 0).
"""

from __future__ import annotations

import csv
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
import yaml

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
OUT = HERE / "out"
RES = HERE / "results" / "sims.csv"
SIZING = date(2026, 10, 12)
SETS = {"explore": (date(2024, 10, 9), date(2026, 10, 8)), "confirm": (date(2022, 1, 3), date(2024, 10, 8))}
TEMPLATES = ("wide", "dir", "buy")


def _hhmm_plus(hhmm: str, minutes: int) -> str:
    m = int(hhmm[:2]) * 60 + int(hhmm[3:]) + minutes
    return f"{m // 60:02d}:{m % 60:02d}"


def make_strategy(underlying: str, template: str, entry: str):
    from option_backtesting.legwise.schema import LegwiseStrategy

    d = yaml.safe_load((ROOT / "strategies" / "rotation" / f"{underlying[0]}_{template}_1202.yaml").read_text())["strategy"]
    d["entry_time"] = entry
    for leg in d["legs"]:
        if "range_breakout" in leg:
            leg["range_breakout"]["until"] = _hhmm_plus(entry, 10)
    return LegwiseStrategy.model_validate(d)


def _ref():
    from option_backtesting.data.reference.loader import (
        MissingReferenceData,
        default_reference_data,
    )

    class Early:
        def __init__(self, ref):
            self._ref = ref

        def __getattr__(self, name):
            return getattr(self._ref, name)

        def _early(self, call, u, when):
            try:
                return call(u, when)
            except MissingReferenceData:
                return call(u, date(2024, 10, 3))

        def lot_size(self, u, expiry):
            return self._early(self._ref.lot_size, u, expiry)

        def strike_step(self, u, as_of):
            return self._early(self._ref.strike_step, u, as_of)

    return Early(default_reference_data())


def work(task):
    underlying, day, keys = task
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day

    try:
        data = load_day(data_dir(), underlying, date.fromisoformat(day))
    except FileNotFoundError:
        return []
    ref = _ref()
    out = []
    for template, entry in keys:
        try:
            r = simulate_day(make_strategy(underlying, template, entry), data, ref, SIZING)
        except Exception as e:  # noqa: BLE001
            out.append([underlying, day, template, entry, "", "", f"ERR {type(e).__name__}"])
            continue
        out.append([underlying, day, template, entry, round(r.gross - r.costs, 2), round(r.worst_mtm, 2), r.stopped_by or ""])
    return out


def trading_days(underlying: str, lo: date, hi: date) -> list[str]:
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.market import backtest_days

    days, _ = backtest_days(data_dir(), underlying, lo, hi)
    return [d.isoformat() for d in days]


def placebo_days(day: str, days: list[str], event_days: set[str]) -> list[str]:
    i = days.index(day)
    before = [d for d in reversed(days[:i]) if d not in event_days][:10]
    after = [d for d in days[i + 1 :] if d not in event_days][:10]
    return before + after


def jobs():
    ev = pd.read_csv(OUT / "triggers.csv", dtype={"entry": str})
    need: dict[tuple, set] = {}
    plan = []  # (set, underlying, trigger, day, entry, [placebo days])
    for (st, und), g in ev.groupby(["set", "underlying"]):
        lo, hi = SETS[st]
        days = trading_days(und, lo, hi)
        dayset = set(days)
        for trig, gt in g.groupby("trigger"):
            event_days = set(gt.day)
            for _, r in gt.iterrows():
                if r.day not in dayset:
                    continue
                pdays = placebo_days(r.day, days, event_days)
                plan.append((st, und, trig, r.day, r.entry, pdays))
                for d in [r.day, *pdays]:
                    for t in TEMPLATES:
                        need.setdefault((und, d), set()).add((t, r.entry))
    return plan, need


def validate() -> int:
    """A template at 11:32 must reproduce the stored 11:32 variant (BL-054 / BL-056 results)."""
    sys.path.insert(0, str(ROOT / "research" / "common"))
    bad = 0
    for und, fam, stem in (("NIFTY", "wide", "wide_1132"), ("NIFTY", "dir", "dir_1132"), ("NIFTY", "buy", "buy_1132")):
        stored = pd.read_csv(ROOT / "research" / "bl054" / "results" / f"{stem}.csv").set_index("day").net
        days = [d for d in stored.index if "2025-03-03" <= d <= "2025-03-28"][:12]
        got = {}
        for d in days:
            for row in work((und, d, [(fam, "11:32")])):
                got[row[1]] = row[4]
        diffs = [(d, got.get(d), stored[d]) for d in days if d in got and abs(got[d] - stored[d]) > 0.01]
        print(f"{und} {fam} 11:32: {len(got)} days, {len(diffs)} differ {diffs[:3]}")
        bad += len(diffs) + (len(got) == 0)
    return bad


def main() -> None:
    if "--validate" in sys.argv:
        sys.exit(1 if validate() else 0)
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    plan, need = jobs()
    pd.to_pickle(plan, HERE / "out" / "plan.pkl")
    done = set()
    if RES.exists():
        with open(RES) as f:
            for r in csv.reader(f):
                if r and r[0] != "underlying" and not r[6].startswith("ERR"):
                    done.add((r[0], r[1], r[2], r[3]))
    tasks = []
    for (und, d), keys in need.items():
        todo = [(t, e) for t, e in sorted(keys) if (und, d, t, e) not in done]
        if todo:
            tasks.append((und, d, todo))
    print(f"{len(plan)} events; {sum(len(k) for k in need.values())} simulations needed, "
          f"{sum(len(t[2]) for t in tasks)} to run over {len(tasks)} index-days", flush=True)
    RES.parent.mkdir(exist_ok=True)
    new = not RES.exists()
    with open(RES, "a", newline="") as f, ProcessPoolExecutor(workers) as pool:
        w = csv.writer(f)
        if new:
            w.writerow(["underlying", "day", "template", "entry", "net", "worst_mtm", "stopped_by"])
        for k, rows in enumerate(pool.map(work, tasks, chunksize=4), 1):
            w.writerows(rows)
            if k % 200 == 0:
                f.flush()
                print(f"  {k}/{len(tasks)} index-days", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
