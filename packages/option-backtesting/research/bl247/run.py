"""BL-247: run every pair over one half's sessions, and the prices-live gate.

    uv run python research/bl247/run.py gate              # fit sessions: stale-leg shares only
    uv run python research/bl247/run.py fit               # fit half, net per session and cell
    uv run python research/bl247/run.py test --passed results/passed.json

`gate` writes results/gate.json with no P&L in it. A net matrix is written to
results/<half>/<ROOT>.npz (rows = sessions, columns = (entry, pair)). The test half runs only the
cohorts a committed `passed` file names.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from functools import cache
from pathlib import Path

import numpy as np
import pyarrow.compute as pc
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))

import grid  # noqa: E402
import mcx_charges  # noqa: E402
from mcx_sessions import schedule, season  # noqa: E402
from trading_data import lake, quality  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402

RESULTS = HERE / "results"
#: today's lot on every day, the sizing date BL-218 used
SIZING_DATE = date(2026, 11, 11)
COLUMNS = [
    (entry, family, params)
    for family in grid.FAMILIES
    for entry in grid.ENTRIES
    for params in grid.pairs(family)
]


@cache
def _reference():
    return default_reference_data()


@cache
def _strategy(column: int, root: str, season_name: str):
    entry, family, params = COLUMNS[column]
    return grid.build(family, params, entry, root, season_name)


def _minutes(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


def _last_trades(root_dir: Path, root: str, day: date) -> dict:
    """{(expiry, strike, type): sorted IST minutes of the day with a trade}."""
    path = lake.bars_1m_path(root_dir, "option", root, day)
    table = pq.read_table(path, columns=["ts", "expiry", "strike", "option_type", "volume"])
    table = table.filter(pc.greater(table.column("volume"), 0))
    ts = table.column("ts").cast("int64").to_numpy()
    ts = ts // 10 ** (len(str(int(ts.max()))) - 10)  # the file's ticks per second
    minutes = ((ts + 19_800) % 86_400) // 60
    out: dict = {}
    for key, minute in zip(
        zip(
            table.column("expiry").to_pylist(),
            table.column("strike").to_pylist(),
            table.column("option_type").to_pylist(),
            strict=True,
        ),
        minutes,
        strict=True,
    ):
        out.setdefault(key, []).append(int(minute))
    return out


def _run_day(job: tuple) -> dict:
    root_dir, root, day, columns, want_gate = job
    season_name = season(root_dir, root, day)
    out = {"day": day, "season": season_name, "reason": ""}
    try:
        data = load_day(root_dir, root, day)
    except FileNotFoundError as error:
        out["reason"] = f"load: {error}"
        return out
    ref = _reference()
    traded = _last_trades(root_dir, root, day) if want_gate else {}
    net = np.full(len(COLUMNS), np.nan)
    entered = np.zeros(len(COLUMNS), np.int8)
    legs: dict[tuple, bool] = {}
    for i in columns:
        entry, family, _params = COLUMNS[i]
        result = simulate_day(_strategy(i, root, season_name), data, ref, sizing_date=SIZING_DATE)
        if want_gate:
            # each leg's first sale only; the P&L of this run is not read or kept
            first: dict = {}
            for trade in result.trades:
                first.setdefault(trade.leg_id, trade.contract)
            for contract in first.values():
                at = _minutes(entry)
                recent = any(at - grid.STALE_MINUTES <= m < at for m in traded.get(contract, ()))
                legs[(family, entry, contract)] = not recent
        else:
            charges = sum(mcx_charges.trade_charges(t) for t in result.trades)
            net[i] = result.gross - charges
            entered[i] = bool(result.trades)
    if want_gate:
        out["legs"] = [(family, entry, stale) for (family, entry, _), stale in legs.items()]
    else:
        out["net"], out["entered"] = net, entered
    return out


def _sessions(root_dir: Path, root: str, half: str) -> tuple[list[dict], dict]:
    sched = [s for s in schedule(root_dir, root, grid.HALVES, grid.WEEKS) if s["half"] == half]
    return sched, quality.excluded_days(root_dir, "option", root) or {}


def _map(jobs: list[tuple], workers: int) -> dict:
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return {r["day"]: r for r in pool.map(_run_day, jobs, chunksize=2)}


def gate(root_dir: Path, workers: int) -> None:
    report: dict = {"grid_sha": grid.grid_sha(), "half": "fit", "cohorts": {}}
    for root in grid.ROOTS:
        sched, excluded = _sessions(root_dir, root, "fit")
        columns = list(range(len(COLUMNS)))
        jobs = [
            (root_dir, root, s["day"], columns, True) for s in sched if s["day"] not in excluded
        ]
        results = _map(jobs, workers)
        for week in grid.WEEKS:
            days = [s["day"] for s in sched if s["week"] == week and s["day"] in results]
            for family in grid.FAMILIES:
                shares, counts = {}, {}
                for entry in grid.ENTRIES:
                    stale = [
                        leg_stale
                        for d in days
                        for f, e, leg_stale in results[d].get("legs", [])
                        if f == family and e == entry
                    ]
                    shares[entry] = sum(stale) / len(stale) if stale else 1.0
                    counts[entry] = len(stale)
                live = all(v <= grid.STALE_LIMIT for v in shares.values())
                report["cohorts"][f"{root}|{family}|{week}"] = {
                    "stale_share": shares,
                    "legs": counts,
                    "sessions": len(days),
                    "live": live,
                }
                print(
                    f"{root:11} {family:7} {week:7} stale "
                    + "  ".join(f"{e} {shares[e]:5.1%} ({counts[e]} legs)" for e in grid.ENTRIES)
                    + f"  -> {'judged' if live else 'NOT JUDGED: prices not live'}"
                )
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "gate.json").write_text(json.dumps(report, indent=1))


def run_half(root_dir: Path, half: str, workers: int, passed: str | None) -> None:
    gate_report = json.loads((RESULTS / "gate.json").read_text())
    wanted = {k for k, v in gate_report["cohorts"].items() if v["live"]}
    if half == "test":
        if not passed:
            raise SystemExit("the test half needs --passed <committed file>")
        subprocess.run(
            # in HEAD, not merely staged
            ["git", "cat-file", "-e", f"HEAD:./{Path(passed).resolve().relative_to(HERE)}"],
            cwd=HERE,
            check=True,
            capture_output=True,
        )
        wanted &= set(json.loads(Path(passed).read_text()))
    out_dir = RESULTS / half
    out_dir.mkdir(parents=True, exist_ok=True)
    for root in grid.ROOTS:
        families = {k.split("|")[1] for k in wanted if k.startswith(root + "|")}
        if not families:
            continue
        columns = [i for i, (_, family, _) in enumerate(COLUMNS) if family in families]
        sched, excluded = _sessions(root_dir, root, half)
        jobs = [
            (root_dir, root, s["day"], columns, False) for s in sched if s["day"] not in excluded
        ]
        results = _map(jobs, workers)
        rows, nets, entries = [], [], []
        for s in sched:
            r = results.get(s["day"])
            reason = f"excluded: {excluded[s['day']]}" if s["day"] in excluded else r["reason"]
            rows.append(
                {
                    "day": s["day"].isoformat(),
                    "expiry": s["expiry"].isoformat(),
                    "week": s["week"],
                    "season": r["season"] if r else "",
                    "reason": reason,
                }
            )
            empty = r is None or "net" not in r
            nets.append(np.full(len(COLUMNS), np.nan) if empty else r["net"])
            entries.append(np.zeros(len(COLUMNS), np.int8) if empty else r["entered"])
        np.savez_compressed(
            out_dir / f"{root}.npz", net=np.vstack(nets), entered=np.vstack(entries)
        )
        (out_dir / f"{root}.json").write_text(
            json.dumps({"grid_sha": grid.grid_sha(), "days": rows}, indent=1)
        )
        skipped = sum(1 for x in rows if x["reason"])
        print(f"{root}: {len(rows)} sessions ({skipped} not run) -> {out_dir}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=("gate", "fit", "test"))
    ap.add_argument("--passed", help="committed list of the cohorts that passed the fit half")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    root_dir = data_dir()
    if args.what == "gate":
        gate(root_dir, args.workers)
    else:
        run_half(root_dir, args.what, args.workers, args.passed)


if __name__ == "__main__":
    main()
