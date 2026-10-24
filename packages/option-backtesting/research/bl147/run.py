"""BL-147: close the directional (Dir family) strategies at 14:55 instead of 15:28. Rules fixed in
backlog/BL-147-directional-early-exit.md before this ran. Reads the stored results, the journals and the
lake; reruns the legwise engine in memory with only `exit_time` changed; writes only research/bl147/out/.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl147/run.py --stage sim
    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl147/run.py --stage analyse"""

from __future__ import annotations

import argparse
import contextlib
import csv
import json
import os
import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
from trading_data import lake

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise
from option_backtesting.rotation import daylog, journal, store
from option_backtesting.rotation.attrs import excluded_map
from option_backtesting.rotation.lists import SIZING_DATE
from option_backtesting.rotation.variants import (
    base_family,
    strategy_path,
    track_names,
    underlying_of,
    variant_names,
)

OUT = Path(__file__).resolve().parent / "out"
SEED, RESAMPLES, BLOCK = 20261021, 2000, 5
EXIT_NEW = "14:55"
START, END = date(2024, 10, 9), date(2026, 10, 19)
T1_SELECTION_END = date(2025, 10, 8)
DIR_FAMILIES = ("dir", "ditm1")
INDEX = {"NIFTY": "NIFTY", "SENSEX": "SENSEX"}


def dir_variants() -> list[str]:
    names = variant_names() + track_names("t1")
    return [n for n in names if base_family(n) in DIR_FAMILIES]


def with_exit(strategy: LegwiseStrategy, exit_time: str) -> LegwiseStrategy:
    c = strategy.model_copy(deep=True)
    c.exit_time = exit_time
    return LegwiseStrategy.model_validate(c.model_dump())


def stage_sim() -> None:
    root = data_dir()
    if not str(root).startswith("/Volumes/TradingData"):
        raise SystemExit(f"TRADING_DATA_ROOT is {root}: set it to /Volumes/TradingData")
    OUT.mkdir(parents=True, exist_ok=True)
    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    excluded = excluded_map(root)
    limit = 14 * 60 + 55
    names = [
        n
        for n in dir_variants()
        if int(n.split("_")[-1][:2]) * 60 + int(n.split("_")[-1][2:]) < limit
    ]  # a variant that enters at or after 14:55 is left out (BL-147 Phase 0)
    stored: dict[str, dict[date, float]] = {}
    strategies: dict[str, tuple[LegwiseStrategy, LegwiseStrategy, int]] = {}
    for n in names:
        s = load_legwise(strategy_path(n))
        entry = int(s.entry_time[:2]) * 60 + int(s.entry_time[3:])
        strategies[n] = (s, with_exit(s, EXIT_NEW), entry)
        col = {}
        path = store.result_path(n, root)
        if path.exists():
            with path.open() as f:
                col = {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}
        stored[n] = col
    days = sorted({d for c in stored.values() for d in c if d.weekday() < 5 and START <= d <= END})
    rows, control_bad, control_n = [], [], 0
    for i, d in enumerate(days):
        loaded = {}
        for u in ("NIFTY", "SENSEX"):
            if d in excluded[u]:
                continue
            with contextlib.suppress(FileNotFoundError):
                loaded[u] = load_day(root, u, d)
        for n in names:
            s, s_new, entry = strategies[n]
            u = underlying_of(n)
            if entry >= limit or u not in loaded or d not in stored[n]:
                continue
            new = simulate_day(s_new, loaded[u], reference, sizing)
            rows.append(
                {
                    "variant": n,
                    "day": d.isoformat(),
                    "g1528": stored[n][d],
                    "g1455": round(new.gross, 2),
                }
            )
            if i % 20 == 0:  # control: the unchanged strategy must reproduce the stored gross
                old = simulate_day(s, loaded[u], reference, sizing)
                control_n += 1
                if abs(old.gross - stored[n][d]) > 0.011:
                    control_bad.append((n, d.isoformat(), stored[n][d], round(old.gross, 2)))
        if i % 25 == 0:
            print(
                f"{d} ({i + 1}/{len(days)}) rows={len(rows)} control={control_n} bad={len(control_bad)}",
                flush=True,
            )
    with (OUT / "deltas.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["variant", "day", "g1528", "g1455"])
        w.writeheader()
        w.writerows(rows)
    (OUT / "control.json").write_text(
        json.dumps(
            {"checked": control_n, "mismatches": control_bad[:50], "n_mismatch": len(control_bad)}
        )
    )
    print(
        f"done: {len(rows)} variant-days; control {control_n} checked, {len(control_bad)} mismatches"
    )
    if control_bad:
        sys.exit(1)


def idx_prices(root: Path, days: set[date]) -> dict[tuple[str, date], tuple[float, float, float]]:
    """{(underlying, day): (open, price at 14:55, close)} from the 1-minute index bars."""
    out: dict = {}
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    for u in ("NIFTY", "SENSEX"):
        paths = [str(lake.bars_1m_path(root, "index", INDEX[u], d)) for d in sorted(days)]
        paths = [p for p in paths if Path(p).exists()]
        rows = con.execute(
            "SELECT date, first(open ORDER BY ts), "
            "last(close ORDER BY ts) FILTER (WHERE hour(ts)*60+minute(ts) <= 14*60+54), "
            "last(close ORDER BY ts) "
            "FROM read_parquet(?, hive_partitioning=true) GROUP BY date",
            [paths],
        ).fetchall()
        for d, o, p, c in rows:
            out[(u, d)] = (o, p, c)
    con.close()
    return out


def picks_dir(root: Path, track: str | None, rec) -> dict[date, list[str]]:
    journal_days = {e["day"]: e for e in journal.read(store.journal_path(root, track))}
    out: dict[date, list[str]] = {}
    for d in sorted(rec.days_available()) + [date.fromisoformat(x) for x in journal_days]:
        if d in out:
            continue
        e = journal_days.get(d.isoformat())
        if e:
            blk = e["lists"]["C"]
            names = list(blk["core"]) + list(blk.get("buy") or [])
        else:
            got = rec.picks(d)
            names = list(got["C"]["core"]) + list(got["C"].get("buy") or []) if got else []
        out[d] = [n for n in names if base_family(n) in DIR_FAMILIES]
    return out


def boot_mean(per_day: list[tuple[float, int]]) -> list[float]:
    """Mean delta per trade-day with a circular 5-day block bootstrap over days: [point, 5th, 95th]."""
    tot = np.array([a for a, _ in per_day])
    cnt = np.array([b for _, b in per_day])
    n = len(tot)
    rng = np.random.default_rng(SEED)
    nb = int(np.ceil(n / BLOCK))
    draws = []
    for _ in range(RESAMPLES):
        idx = np.concatenate([(s + np.arange(BLOCK)) % n for s in rng.integers(0, n, nb)])[:n]
        draws.append(tot[idx].sum() / cnt[idx].sum())
    return [
        float(tot.sum() / cnt.sum()),
        float(np.percentile(draws, 5)),
        float(np.percentile(draws, 95)),
    ]


def max_dd(daily: np.ndarray) -> float:
    cum = np.cumsum(daily)
    return float((cum - np.maximum.accumulate(np.concatenate([[0], cum])[1:])).min())


def stage_analyse() -> None:
    root = data_dir()
    rows = list(csv.DictReader((OUT / "deltas.csv").open()))
    delta = {
        (r["variant"], date.fromisoformat(r["day"])): (float(r["g1528"]), float(r["g1455"]))
        for r in rows
    }
    days_all = sorted({d for _, d in delta})
    prices = idx_prices(root, set(days_all))

    def trend(u: str, d: date) -> tuple[str, str]:
        if (u, d) not in prices:
            return "na", "na"
        o, p, c = prices[(u, d)]
        move, late = (p / o - 1) * 100, (c / p - 1) * 100
        t = "down" if move <= -0.3 else "up" if move >= 0.3 else "flat"
        pat = (
            "recovery"
            if t == "down" and late >= 0.1
            else "fade"
            if t == "up" and late <= -0.1
            else "other"
        )
        return t, pat

    res: dict = {"control": json.loads((OUT / "control.json").read_text())}
    # B: breadth over every Dir variant
    by_var: dict[str, list[float]] = {}
    for (n, _), (a, b) in delta.items():
        by_var.setdefault(n, []).append(b - a)
    means = {n: float(np.mean(v)) for n, v in by_var.items()}
    allv = [x for v in by_var.values() for x in v]
    res["B"] = {
        "variants": len(by_var),
        "variant_days": len(allv),
        "mean_delta": round(float(np.mean(allv)), 1),
        "share_variants_positive_pct": round(
            100 * float(np.mean([m > 0 for m in means.values()])), 1
        ),
        "share_days_changed_pct": round(100 * float(np.mean([x != 0 for x in allv])), 1),
        "by_family": {
            fam: {
                "variants": len(ns),
                "mean_delta": round(float(np.mean([means[n] for n in ns])), 1),
                "share_positive_pct": round(100 * float(np.mean([means[n] > 0 for n in ns])), 1),
            }
            for fam, ns in {
                "N_dir": [n for n in means if n.startswith("N_dir_")],
                "N_ditm1": [n for n in means if n.startswith("N_ditm1_")],
                "S_dir": [n for n in means if n.startswith("S_dir_")],
                "S_ditm1": [n for n in means if n.startswith("S_ditm1_")],
                "T1 Dir (t1)": [n for n in means if "-t1s" in n],
            }.items()
            if ns
        },
    }
    # A: the picks
    names_core, names_t1 = variant_names(), variant_names() + track_names("t1")
    streams = {
        "CORE": picks_dir(root, None, daylog.reconstruction(root, names_core)),
        "T1": picks_dir(root, "t1", daylog.reconstruction(root, names_t1)),
    }
    res["A"] = {}
    pooled: dict[date, list[tuple[str, float, float]]] = {}
    for key, per_day in streams.items():
        recs = []
        for d, ns in per_day.items():
            for n in ns:
                if (n, d) in delta:
                    a, b = delta[(n, d)]
                    recs.append((d, n, a, b))
                    pooled.setdefault(d, []).append((key, a, b))
        ds = np.array([b - a for _, _, a, b in recs])
        res["A"][key] = {
            "pick_days": len(recs),
            "mean_delta": round(float(ds.mean()), 1) if len(ds) else None,
            "share_positive_pct": round(100 * float(np.mean(ds > 0)), 1) if len(ds) else None,
            "share_changed_pct": round(100 * float(np.mean(ds != 0)), 1) if len(ds) else None,
            "best": round(float(ds.max())) if len(ds) else None,
            "worst": round(float(ds.min())) if len(ds) else None,
            "in_profit_at_1455": {
                "n": int(np.sum([b > 0 for _, _, _, b in recs])),
                "mean_delta": round(float(np.mean([b - a for _, _, a, b in recs if b > 0])), 1),
            }
            if recs
            else None,
            "in_loss_at_1455": {
                "n": int(np.sum([b <= 0 for _, _, _, b in recs])),
                "mean_delta": round(float(np.mean([b - a for _, _, a, b in recs if b <= 0])), 1),
            }
            if recs
            else None,
        }
        if key == "T1":
            ins = [b - a for d, _, a, b in recs if d <= T1_SELECTION_END]
            outs = [b - a for d, _, a, b in recs if d > T1_SELECTION_END]
            res["A"]["T1"]["in_sample_selection_window"] = {
                "n": len(ins),
                "mean_delta": round(float(np.mean(ins)), 1) if ins else None,
            }
            res["A"]["T1"]["after_selection_window"] = {
                "n": len(outs),
                "mean_delta": round(float(np.mean(outs)), 1) if outs else None,
            }
    pdays = sorted(pooled)
    per_day = [(sum(b - a for _, a, b in pooled[d]), len(pooled[d])) for d in pdays]
    point, lo, hi = boot_mean(per_day)
    old = np.array([sum(a for _, a, _ in pooled[d]) for d in pdays])
    new = np.array([sum(b for _, _, b in pooled[d]) for d in pdays])
    res["A_pooled"] = {
        "days": len(pdays),
        "pick_days": int(sum(c for _, c in per_day)),
        "mean_delta_per_trade_day": [round(point, 1), round(lo, 1), round(hi, 1)],
        "total_1528": round(float(old.sum())),
        "total_1455": round(float(new.sum())),
        "max_drawdown_1528": round(max_dd(old)),
        "max_drawdown_1455": round(max_dd(new)),
    }
    cond1 = point > 0 and lo > 0
    cond2 = res["A_pooled"]["max_drawdown_1455"] >= res["A_pooled"]["max_drawdown_1528"]
    cond3 = res["B"]["share_variants_positive_pct"] >= 60
    res["verdict"] = {
        "conditions": {
            "A interval above zero": bool(cond1),
            "drawdown no deeper": bool(cond2),
            "B >= 60% variants positive": bool(cond3),
        },
        "helps": bool(cond1 and cond2 and cond3),
        "hurts": bool(hi < 0),
    }
    # the owner's pattern
    pat_b: dict[str, list[float]] = {}
    pat_a: dict[str, list[float]] = {}
    day_count: dict[str, set] = {}
    for (n, d), (a, b) in delta.items():
        t, p = trend(underlying_of(n), d)
        pat_b.setdefault(f"{t}/{p}", []).append(b - a)
    for per in streams.values():
        for d, ns in per.items():
            for n in ns:
                if (n, d) in delta:
                    a, b = delta[(n, d)]
                    t, p = trend(underlying_of(n), d)
                    pat_a.setdefault(f"{t}/{p}", []).append(b - a)
                    day_count.setdefault(f"{t}/{p}", set()).add(d)
    res["pattern"] = {
        "A_picks": {
            k: {
                "n": len(v),
                "days": len(day_count.get(k, ())),
                "mean_delta": round(float(np.mean(v)), 1),
            }
            for k, v in sorted(pat_a.items())
        },
        "B_all_variants": {
            k: {"n": len(v), "mean_delta": round(float(np.mean(v)), 1)}
            for k, v in sorted(pat_b.items())
        },
        "share_of_NIFTY_days": {},
    }
    nd = [trend("NIFTY", d) for d in days_all]
    for k in ("down/recovery", "up/fade"):
        t, p = k.split("/")
        res["pattern"]["share_of_NIFTY_days"][k] = round(
            100 * float(np.mean([x == (t, p) for x in nd])), 1
        )
    (OUT / "study.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps(res, indent=2, default=float))


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=("sim", "analyse"), required=True)
    stage = ap.parse_args().stage
    stage_sim() if stage == "sim" else stage_analyse()
