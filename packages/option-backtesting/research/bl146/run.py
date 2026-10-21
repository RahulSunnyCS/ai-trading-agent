"""BL-146: Budget, election-result, RBI-policy and high-premium days. Rules fixed in
backlog/BL-146-special-days.md before this ran. Read-only over the stored results, the journals, days.csv
and the lake's index bars; writes research/bl146/out/.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl146/run.py"""

from __future__ import annotations

import csv
import json
import os
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
from trading_data import lake

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import base as base_mod
from option_backtesting.rotation import daylog, journal, store
from option_backtesting.rotation.variants import strategy_path, track_names, variant_names

OUT = Path(__file__).resolve().parent / "out"
SEED, RESAMPLES, BLOCK = 20261021, 2000, 5
WIDE, DIR = "N_wide_0917", base_mod.DIR_NAME
T1_SELECTION_END = date(2025, 10, 8)
D = date.fromisoformat

NAMED = {
    "budget": ["2025-02-01", "2026-02-01"],
    "election": ["2024-11-25", "2025-02-10", "2025-11-14", "2026-05-04"],
    "rbi": [
        "2024-10-09",
        "2024-12-06",
        "2025-02-07",
        "2025-04-09",
        "2025-06-06",
        "2025-10-01",
        "2025-12-05",
        "2026-02-06",
        "2026-04-08",
        "2026-06-05",
        "2026-08-05",
        "2026-10-07",
    ],
}


def day_ranges(root: Path, days: list[date]) -> dict[date, float]:
    """D = (high - low) as a percent of the previous session's close, NIFTY 1-minute index bars."""
    paths = [str(lake.bars_1m_path(root, "index", "NIFTY", d)) for d in days]
    paths = [p for p in paths if Path(p).exists()]
    con = duckdb.connect()
    rows = con.execute(
        "SELECT date, max(high), min(low), last(close ORDER BY ts) "
        "FROM read_parquet(?, hive_partitioning=true) GROUP BY date ORDER BY date",
        [paths],
    ).fetchall()
    con.close()
    out, prev = {}, None
    for d, hi, lo, close in rows:
        if prev:
            out[d] = (hi - lo) / prev * 100
        prev = close
    return out


def picks_for(root: Path, track: str | None, day: date, rec) -> list[str] | None:
    for e in journal.read(store.journal_path(root, track)):
        if e.get("day") == day.isoformat():
            blk = e["lists"]["C"]
            return list(blk["core"]) + list(blk.get("buy") or [])
    got = rec.picks(day)
    return list(got["C"]["core"]) + list(got["C"].get("buy") or []) if got else None


def wide_flag(name: str, cache: dict) -> tuple[bool, int]:
    if name not in cache:
        sl = [x.stop_loss.percent for x in load_legwise(strategy_path(name)).legs if x.stop_loss]
        cache[name] = (
            bool(sl) and min(sl) >= 100,
            int(name.split("_")[-1][:2]) * 60 + int(name.split("_")[-1][2:]),
        )
    return cache[name]


def gross(root: Path, name: str, day: date, memo: dict) -> float | None:
    if name not in memo:
        path = base_mod._path(root) if name == DIR else store.result_path(name, root)
        memo[name] = base_mod.read_column(path, "gross")
    return memo[name].get(day)


def boot_diff(flag: np.ndarray, val: np.ndarray) -> list[int]:
    """mean(val | flag) - mean(val | not flag), circular 5-day blocks: [point, 5th, 95th]."""
    n = len(val)
    rng = np.random.default_rng(SEED)

    def stat(f: np.ndarray, v: np.ndarray) -> float:
        return float(v[f].mean() - v[~f].mean()) if f.any() and (~f).any() else float("nan")

    draws = []
    nb = int(np.ceil(n / BLOCK))
    for _ in range(RESAMPLES):
        idx = np.concatenate([(s + np.arange(BLOCK)) % n for s in rng.integers(0, n, nb)])[:n]
        x = stat(flag[idx], val[idx])
        if x == x:
            draws.append(x)
    return [
        round(stat(flag, val)),
        round(float(np.percentile(draws, 5))),
        round(float(np.percentile(draws, 95))),
    ]


def main() -> None:
    root = data_dir()
    if not str(root).startswith("/Volumes/TradingData"):
        raise SystemExit(f"TRADING_DATA_ROOT is {root}: set it to /Volumes/TradingData")
    OUT.mkdir(parents=True, exist_ok=True)
    days_csv = {
        D(r["day"]): r for r in csv.DictReader((Path(root) / "rotation" / "days.csv").open())
    }
    days = sorted(days_csv)
    vix = {d: float(days_csv[d]["vix_open"]) for d in days if days_csv[d]["vix_open"]}
    p90, p95 = (float(np.percentile(list(vix.values()), q)) for q in (90, 95))
    rng = day_ranges(root, days)
    rec_core = daylog.reconstruction(root, variant_names())
    rec_t1 = daylog.reconstruction(root, variant_names() + track_names("t1"))
    memo: dict = {}
    sl: dict = {}
    table = []
    for d in days:
        row: dict = {
            "date": d.isoformat(),
            "weekday": d.strftime("%a"),
            "vix_open": vix.get(d),
            "d_pct": rng.get(d),
        }
        w, dr = gross(root, WIDE, d, memo), gross(root, DIR, d, memo)
        row["W3"] = None if w is None else w  # per lot-day: 3 lots / 3 = one-lot gross
        row["BASE"] = None if w is None or dr is None else (2 * w + dr) / 3
        for key, track, rec in (("CORE", None, rec_core), ("T1", "t1", rec_t1)):
            names = picks_for(root, track, d, rec)
            g = [gross(root, n, d, memo) for n in names] if names else []
            if names and all(v is not None for v in g):
                row[key] = sum(g) / len(g)
                fl = [wide_flag(n, sl) for n in names]
                row[f"{key}_wide_share"] = sum(1 for f, _ in fl if f) / len(fl)
                row[f"{key}_mean_start"] = float(np.mean([s for _, s in fl]))
            else:
                row[key] = None
        table.append(row)
    by_day = {r["date"]: r for r in table}
    seq = [r["date"] for r in table if D(r["date"]).weekday() < 5]

    named: dict[str, list[str]] = {k: [x for x in v if x in by_day] for k, v in NAMED.items()}
    week = []
    for b in NAMED["budget"]:
        nxt = [s for s in seq if s > b][:2]
        prv = [s for s in seq if s < b][-2:]
        week += prv + nxt
    groups = {
        "budget_day": named["budget"],
        "budget_week": week,
        "election": named["election"],
        "rbi": named["rbi"],
        "vix_p90": [r["date"] for r in table if r["vix_open"] and r["vix_open"] >= p90],
        "vix_p95": [r["date"] for r in table if r["vix_open"] and r["vix_open"] >= p95],
    }
    special = sorted(set(named["budget"] + named["election"] + named["rbi"] + groups["vix_p90"]))
    books = ("W3", "BASE", "CORE", "T1")

    def stats(dates: list[str], book: str) -> dict:
        v = [by_day[x][book] for x in dates if by_day[x].get(book) is not None]
        return {
            "n": len(v),
            "mean": round(float(np.mean(v))) if v else None,
            "win_pct": round(100 * float(np.mean([x > 0 for x in v])), 1) if v else None,
            "worst": round(min(v)) if v else None,
        }

    res: dict = {
        "vix_p90": p90,
        "vix_p95": p95,
        "days": len(table),
        "groups": {g: {b: stats(ds, b) for b in books} | {"dates": ds} for g, ds in groups.items()},
    }
    res["all_days"] = {b: stats([r["date"] for r in table], b) for b in books}
    # E1 and E2: over special sessions with T1 picks
    have = [
        x for x in special if by_day[x].get("T1") is not None and by_day[x].get("BASE") is not None
    ]
    e = {b: [by_day[x][b] for x in have] for b in books}
    mean = {b: float(np.mean(e[b])) for b in books}
    res["e1"] = {
        "sessions": len(have),
        "means": {b: round(m) for b, m in mean.items()},
        "met": bool(mean["T1"] >= 0 and mean["T1"] >= mean["BASE"] - 250),
    }
    worst = {b: min(e[b]) for b in books}
    res["e2"] = {
        "worst": {b: round(v) for b, v in worst.items()},
        "met": bool(worst["T1"] >= min(worst["CORE"], worst["BASE"], worst["W3"]) - 1000),
    }
    # E3: premium days vs the rest, per book
    res["e3"] = {}
    for b in books:
        ds = [r for r in table if r.get(b) is not None and r["vix_open"] is not None]
        flag = np.array([r["vix_open"] >= p90 for r in ds])
        val = np.array([r[b] for r in ds])
        res["e3"][b] = {
            "premium_days": int(flag.sum()),
            "diff_premium_minus_rest": boot_diff(flag, val),
        }
    t = res["e3"]["T1"]["diff_premium_minus_rest"]
    res["e3"]["worth_testing"] = bool(t[0] < -300 and t[2] < 0)
    # event rows
    rows = []
    for g in ("budget_day", "election", "rbi"):
        for x in groups[g]:
            r = by_day[x]
            rows.append(
                {
                    "group": g,
                    "date": x,
                    "weekday": r["weekday"],
                    "vix_open": r["vix_open"],
                    "day_range_pct": None if r["d_pct"] is None else round(r["d_pct"], 2),
                    **{b: None if r.get(b) is None else round(r[b]) for b in books},
                    "t1_in_sample": D(x) <= T1_SELECTION_END,
                }
            )
    keys = list(rows[0])
    with (OUT / "events.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    with (OUT / "all_days.csv").open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=list(table[0])
            + ["CORE_wide_share", "CORE_mean_start", "T1_wide_share", "T1_mean_start"],
            extrasaction="ignore",
        )
        w.writeheader()
        w.writerows(table)
    # behaviour of the picks on premium days
    for key in ("CORE", "T1"):
        for _name, ds in (("vix_p90", groups["vix_p90"]),):
            sh = [
                by_day[x][f"{key}_wide_share"]
                for x in ds
                if by_day[x].get(f"{key}_wide_share") is not None
            ]
            ot = [
                r[f"{key}_wide_share"]
                for r in table
                if r.get(f"{key}_wide_share") is not None and r["date"] not in set(ds)
            ]
            res.setdefault("picks", {})[key] = {
                "wide_share_premium": round(100 * float(np.mean(sh)), 1) if sh else None,
                "wide_share_other": round(100 * float(np.mean(ot)), 1),
            }
    (OUT / "study.json").write_text(json.dumps(res, indent=2, default=float))
    print(json.dumps(res, indent=2, default=float))
    for r in rows:
        print(r)


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    main()
