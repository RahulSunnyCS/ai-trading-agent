"""Follow-up to BL-221 (owner question, 2026-11-15): T1's Dir picks over the last two years split by the
hourly EMA 20/50 trend state known before each session (the state BL-221 used; out/table.json).
Descriptive only: no rule, no test.

    uv run python research/bl221/t1_dir_split.py            # main split
    uv run python research/bl221/t1_dir_split.py --legs     # + which leg stopped (re-simulates the Dir picks)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PKG = HERE.parents[1]
sys.path.insert(0, str(PKG / "src"))
sys.path.insert(0, str(PKG / "research" / "common"))
ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
FROM, TO = date(2024, 10, 9), date(2026, 10, 8)
DIR_RE = re.compile(r"^[NS]_(dir|ditm1)")

from adaptive_picks import picks_for, strategy_path  # noqa: E402

from option_backtesting.rotation import store  # noqa: E402

TABLE = json.loads((HERE / "out" / "table.json").read_text())
STATE = {d: TABLE["table"][d]["trend"]["hourly"] for d in TABLE["days"]}


def main(legs: bool):
    picks = picks_for("t1", ROOT, FROM, TO)
    dir_picks = {d: [n for n in ns if DIR_RE.match(n)] for d, ns in picks.items()}
    days = sorted(d for d in picks if d.isoformat() in STATE)
    n_up = sum(STATE[d.isoformat()] > 0 for d in days)
    print(f"{len(days)} T1 sessions {days[0]} -> {days[-1]}; hourly EMA20>EMA50 (up) on {n_up} "
          f"({n_up / len(days) * 100:.0f}%), below (down) on {len(days) - n_up} ({(len(days) - n_up) / len(days) * 100:.0f}%)")
    has_dir = [d for d in days if dir_picks[d]]
    print(f"days T1 held at least one Dir: {len(has_dir)}; Dir picks {sum(len(dir_picks[d]) for d in has_dir)}; "
          f"names: {sorted({n for d in has_dir for n in dir_picks[d]})[:6]}...")
    for slip in (0.5, 0.0):
        with store.slipped(slip):
            nets = {n: store.read_net(n, ROOT) for n in {n for d in has_dir for n in dir_picks[d]}}
        day_net = {d: sum(nets[n].get(d, 0.0) for n in dir_picks[d]) for d in has_dir}
        missing = sum(1 for d in has_dir for n in dir_picks[d] if d not in nets[n])
        print(f"\n=== slippage {slip}% (results missing for {missing} pick-days) ===")
        rows = []
        for name, test in (("UP trend (20>50)", lambda s: s > 0), ("DOWN trend (20<50)", lambda s: s < 0)):
            ds = [d for d in has_dir if test(STATE[d.isoformat()])]
            v = np.array([day_net[d] for d in ds])
            win, lose = v[v > 0], v[v < 0]
            rows.append((name, len(ds), v.sum(), v.mean(), (v > 0).mean(), win.sum(), lose.sum()))
        tot = sum(r[2] for r in rows)
        gp = sum(r[5] for r in rows)
        gl = sum(r[6] for r in rows)
        print(f"{'state':20}{'days':>6}{'total ₹':>11}{'₹/day':>8}{'win%':>6}{'profit on win days':>20}{'loss on lose days':>19}")
        for n, k, t, m, w, p, loss in rows:
            print(f"{n:20}{k:>6}{t:>11.0f}{m:>8.0f}{w * 100:>5.0f}%{p:>12.0f} ({p / gp * 100:>3.0f}%){loss:>12.0f} ({loss / gl * 100:>3.0f}%)")
        print(f"{'all Dir days':20}{len(has_dir):>6}{tot:>11.0f}{tot / len(has_dir):>8.0f}")
        # by market direction that day (open to close) as a second lens
    # the index's own direction on the day, from the frame
    from option_backtesting.ruletest.frame import load_frame
    frame = load_frame(ROOT, "NIFTY", TO, date(2020, 9, 1))
    at = {d: i for i, d in enumerate(frame.days)}
    with store.slipped(0.5):
        nets = {n: store.read_net(n, ROOT) for n in {n for d in has_dir for n in dir_picks[d]}}
    day_net = {d: sum(nets[n].get(d, 0.0) for n in dir_picks[d]) for d in has_dir}
    ret = {d: (frame.C[at[d.isoformat()], 374] / frame.O[at[d.isoformat()], 0] - 1) * 100 for d in has_dir}
    print("\n=== by what NIFTY did that day (open to close), 0.5% slippage ===")
    for nm, test in (("rally day (> +0.3%)", lambda r: r > 0.3), ("flat day (±0.3%)", lambda r: abs(r) <= 0.3),
                     ("fall day (< -0.3%)", lambda r: r < -0.3)):
        ds = [d for d in has_dir if test(ret[d])]
        v = np.array([day_net[d] for d in ds])
        print(f"  {nm:22} {len(ds):>4} days  total {v.sum():>9.0f}  ₹/day {v.mean():>6.0f}  win {np.mean(v > 0) * 100:>3.0f}%"
              f"  profit on winning days {v[v > 0].sum():>8.0f}  loss on losing days {v[v < 0].sum():>8.0f}")
    print("  cross: hourly state x day direction (₹ total over Dir days, days)")
    for sname, st in (("up-trend", lambda s: s > 0), ("down-trend", lambda s: s < 0)):
        out = []
        for nm, test in (("rally", lambda r: r > 0.3), ("flat", lambda r: abs(r) <= 0.3), ("fall", lambda r: r < -0.3)):
            ds = [d for d in has_dir if st(STATE[d.isoformat()]) and test(ret[d])]
            out.append(f"{nm} {len(ds)}d {sum(day_net[d] for d in ds):.0f}")
        print(f"    {sname:11} " + " | ".join(out))
    if legs:
        leg_lens(has_dir, dir_picks)


def leg_lens(has_dir, dir_picks):
    import yaml

    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import MissingReferenceData, simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import LegwiseStrategy
    from option_backtesting.rotation.lists import SIZING_DATE
    sizing, ref = date.fromisoformat(SIZING_DATE), default_reference_data()
    agg = defaultdict(lambda: {"ce": 0.0, "pe": 0.0, "ce_stop": 0, "pe_stop": 0, "n": 0, "net": 0.0})
    cache = {}
    for d in has_dir:
        st = "up" if STATE[d.isoformat()] > 0 else "down"
        for name in dir_picks[d]:
            idx = name[0]
            und = "NIFTY" if idx == "N" else "SENSEX"
            data = cache.get((und, d)) or load_day(ROOT, und, d)
            cache = {(und, d): data}
            spec = yaml.safe_load(strategy_path(name).read_text())["strategy"]
            try:
                res = simulate_day(LegwiseStrategy.model_validate(spec), data, ref, sizing)
            except MissingReferenceData:
                continue
            a = agg[st]
            a["n"] += 1
            a["net"] += res.net
            for t in res.trades:
                leg = "ce" if t.contract[2] == "CE" else "pe"
                a[leg] += t.pnl
                if t.exit_reason == "SL":
                    a[leg + "_stop"] += 1
    print("\n=== leg lens (engine re-run of each Dir pick, no slippage; gross by leg, SL exits counted) ===")
    for st in ("up", "down"):
        a = agg[st]
        print(f"  {st}-trend: {a['n']} pick-days, net {a['net']:.0f}; CE legs gross {a['ce']:.0f} (stopped {a['ce_stop']}x), "
              f"PE legs gross {a['pe']:.0f} (stopped {a['pe_stop']}x)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--legs", action="store_true")
    main(ap.parse_args().legs)
