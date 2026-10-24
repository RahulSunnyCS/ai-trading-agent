"""BL-145: T1's breadth (Q2), lag after a regime change (Q3) and the opening-range gate (Q4).
Rules fixed in backlog/BL-145-t1-robustness-lag-opening-range.md before this ran. Reads
research/bl144/out/daily.csv, the stored results and the lake's index bars; writes research/bl145/out/.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl145/run.py [--confirm]

Without --confirm it runs Q2, Q3 and Q4's learning window; --confirm runs Q4's one confirmation pass."""

from __future__ import annotations

import argparse
import csv
import json
import os
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
from trading_data import lake

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import base as base_mod
from option_backtesting.rotation import daylog, store
from option_backtesting.rotation.variants import variant_names

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
DAILY = HERE.parent / "bl144" / "out" / "daily.csv"
SEED, RESAMPLES = 20261021, 2000
BOOKS = ("W3", "BASE", "CORE", "T1")
MONTHS = [(2025, 11), (2025, 12)] + [(2026, m) for m in range(1, 10)]  # the 11 full months
# fixed in BL-144 (terciles of the main window)
R7_LOW, R7_HIGH = 0.7477294022145393, 1.0537194072780418
D_LOW, D_HIGH = 0.6817882564344829, 1.034857463028674
WIDE_VARIANT = "N_wide_0947"


def num(r: dict, k: str) -> float:
    return float(r[k]) if r.get(k) not in (None, "") else float("nan")


def index_bars(root: Path, days: list[date]) -> tuple[dict, dict]:
    """({day: open, high, low, close}, {day: opening range 09:15-09:44 high-low}) of NIFTY."""
    paths = [str(lake.bars_1m_path(root, "index", "NIFTY", d)) for d in days]
    paths = [p for p in paths if Path(p).exists()]
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    q = "FROM read_parquet(?, hive_partitioning=true) GROUP BY date ORDER BY date"
    day = con.execute(
        f"SELECT date, first(open ORDER BY ts), max(high), min(low), last(close ORDER BY ts) {q}",
        [paths],
    ).fetchall()
    orr = con.execute(
        "SELECT date, max(high) - min(low) FROM read_parquet(?, hive_partitioning=true) "
        "WHERE hour(ts) * 60 + minute(ts) BETWEEN 555 AND 584 GROUP BY date",
        [paths],
    ).fetchall()
    con.close()
    return (
        {d: {"open": o, "high": h, "low": lo, "close": c} for d, o, h, lo, c in day},
        {d: pts for d, pts in orr},
    )


def regime_table(root: Path, days: list[date], pad: list[date]) -> dict[date, dict]:
    """R7, D and OR (percent of the previous close) for `days`, with `pad` earlier sessions."""
    seq_all = sorted(set(pad) | set(days))
    bars, orr = index_bars(root, seq_all)
    seq = [d for d in seq_all if d in bars]
    pct = {}
    for i, d in enumerate(seq[1:], 1):
        pct[d] = (bars[d]["high"] - bars[d]["low"]) / bars[seq[i - 1]]["close"] * 100
    out = {}
    for i, d in enumerate(seq):
        if i < 8 or d not in days or d not in pct or d not in orr:
            continue
        prior = seq[i - 7 : i]
        if any(p not in pct for p in prior):
            continue
        prev = bars[seq[i - 1]]["close"]
        out[d] = {
            "r7": float(np.mean([pct[p] for p in prior])),
            "d": pct[d],
            "or": orr[d] / prev * 100,
        }
    return out


def block_boot(values: np.ndarray, stat, block: int = 5) -> tuple[float, float, float]:
    """(point, 5th, 95th percentile) of stat(values) under a circular block bootstrap."""
    n = len(values)
    rng = np.random.default_rng(SEED)
    nb = int(np.ceil(n / block))
    draws = []
    for _ in range(RESAMPLES):
        idx = np.concatenate([(s + np.arange(block)) % n for s in rng.integers(0, n, nb)])[:n]
        v = stat(values[idx])
        if v == v:
            draws.append(v)
    return float(stat(values)), float(np.percentile(draws, 5)), float(np.percentile(draws, 95))


def q2(rows: list[dict]) -> dict:
    res: dict = {}
    dates = [r["date"] for r in rows]
    per = {b: np.array([num(r, f"{b}_gross") / num(r, f"{b}_lots") for r in rows]) for b in BOOKS}
    gross = {b: np.array([num(r, f"{b}_gross") for r in rows]) for b in BOOKS}
    for b in BOOKS:
        g = gross[b]
        order = np.argsort(-g)
        month_pos = 0
        for y, m in MONTHS:
            tot = sum(g[i] for i, d in enumerate(dates) if d.startswith(f"{y}-{m:02d}"))
            month_pos += tot > 0
        mean, lo, hi = block_boot(per[b], np.nanmean)
        res[b] = {
            "total": round(float(g.sum())),
            "ex_best5": round(float(g.sum() - g[order[:5]].sum())),
            "ex_best10": round(float(g.sum() - g[order[:10]].sum())),
            "ex_best10_share_pct": round(100 * float((g.sum() - g[order[:10]].sum()) / g.sum()), 1),
            "months_positive_of_11": int(month_pos),
            "mean_per_lot_day": [round(mean), round(lo), round(hi)],
            "best5_days": [dates[i] for i in order[:5]],
        }
    diff = per["T1"] - per["CORE"]
    m, lo, hi = block_boot(diff, np.nanmean)
    res["t1_minus_core_per_lot_day"] = [round(m), round(lo), round(hi)]
    t1 = res["T1"]
    res["verdict_broad"] = bool(
        t1["ex_best10_share_pct"] >= 50 and t1["months_positive_of_11"] >= 8 and lo > 0
    )
    res["failed"] = [
        n
        for n, ok in (
            ("ex-best-10 share >= 50%", t1["ex_best10_share_pct"] >= 50),
            (">= 8 of 11 months positive", t1["months_positive_of_11"] >= 8),
            ("T1 - Core interval above zero", lo > 0),
        )
        if not ok
    ]
    return res


def q3(rows: list[dict]) -> dict:
    r7 = np.array([num(r, "r7_pct") for r in rows])
    d = np.array([num(r, "d_pct") for r in rows])
    per = {b: np.array([num(r, f"{b}_gross") / num(r, f"{b}_lots") for r in rows]) for b in BOOKS}
    kinds = {
        "surprise_wide": (r7 <= R7_LOW) & (d >= D_HIGH),
        "calm_down": (r7 >= R7_HIGH) & (d <= D_LOW),
    }
    res: dict = {}
    for kind, mask in kinds.items():
        ev = np.where(mask)[0]
        res[kind] = {"events": int(len(ev)), "days": [rows[i]["date"] for i in ev]}
        for b in BOOKS:
            allmean = float(np.nanmean(per[b]))
            day0 = [per[b][i] for i in ev]
            nxt = [per[b][i + k] for i in ev for k in range(1, 6) if i + k < len(rows)]
            res[kind][b] = {
                "all_day_mean": round(allmean),
                "event_day": round(float(np.mean(day0))) if day0 else None,
                "next_1_5": round(float(np.mean(nxt))) if nxt else None,
            }
        # T1: mean over +1..+5 minus its all-day mean, events resampled one by one
        if len(ev) >= 8:
            per_event = np.array(
                [np.mean([per["T1"][i + k] for k in range(1, 6) if i + k < len(rows)]) for i in ev]
            )
            allm = float(np.nanmean(per["T1"]))
            rng = np.random.default_rng(SEED)
            draws = [
                float(np.mean(per_event[rng.integers(0, len(ev), len(ev))]) - allm)
                for _ in range(RESAMPLES)
            ]
            lo, hi = float(np.percentile(draws, 5)), float(np.percentile(draws, 95))
            diff = float(np.mean(per_event) - allm)
            res[kind]["t1_next_1_5_minus_all"] = [round(diff), round(lo), round(hi)]
            res[kind]["t1_lags"] = bool(diff < -300 and hi < 0)
        else:
            res[kind]["t1_lags"] = "too few events"
    return res


def q4_sample(
    root: Path, days: list[date], pad: list[date], or_cuts: tuple[float, float] | None
) -> dict:
    tab = regime_table(root, days, pad)
    g = base_mod.read_column(store.result_path(WIDE_VARIANT, root), "gross")
    ds = [d for d in days if d in tab and d in g]
    ors = np.array([tab[d]["or"] for d in ds])
    cuts = or_cuts or (float(np.percentile(ors, 100 / 3)), float(np.percentile(ors, 200 / 3)))
    quiet = [d for d in ds if tab[d]["r7"] <= R7_LOW]
    lo = np.array([g[d] for d in quiet if tab[d]["or"] <= cuts[0]])
    hi = np.array([g[d] for d in quiet if tab[d]["or"] >= cuts[1]])
    seq = np.array([(tab[d]["or"] <= cuts[0]) * 1 + (tab[d]["or"] >= cuts[1]) * 2 for d in quiet])
    vals = np.array([g[d] for d in quiet])

    def stat(idx_vals: np.ndarray) -> float:  # rows are (group, value)
        a, b = idx_vals[idx_vals[:, 0] == 1, 1], idx_vals[idx_vals[:, 0] == 2, 1]
        return float(np.mean(a) - np.mean(b)) if len(a) and len(b) else float("nan")

    point, blo, bhi = block_boot(np.column_stack([seq, vals]), stat)
    wide_share = {
        name: round(
            100 * float(np.mean([tab[d]["d"] >= D_HIGH for d in quiet if sel(tab[d]["or"], cuts)])),
            1,
        )
        for name, sel in (("low_OR", lambda x, c: x <= c[0]), ("high_OR", lambda x, c: x >= c[1]))
    }
    return {
        "days": len(ds),
        "quiet_week_days": len(quiet),
        "or_cuts": [round(c, 4) for c in cuts],
        "n_low_or": int(len(lo)),
        "n_high_or": int(len(hi)),
        "wide_variant_per_lot_day": {
            "low_OR": round(float(lo.mean())),
            "high_OR": round(float(hi.mean())),
        },
        "low_minus_high": [round(point), round(blo), round(bhi)],
        "share_of_quiet_week_days_wide_pct": wide_share,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--confirm", action="store_true")
    args = ap.parse_args()
    root = data_dir()
    if not str(root).startswith("/Volumes/TradingData"):
        raise SystemExit(f"TRADING_DATA_ROOT is {root}: set it to /Volumes/TradingData")
    OUT.mkdir(parents=True, exist_ok=True)
    rows = list(csv.DictReader(DAILY.open()))
    rec = daylog.reconstruction(root, variant_names())
    attrs = sorted(d for d in rec.attrs if d.weekday() < 5)
    if not args.confirm:
        res = {"q2": q2(rows), "q3": q3(rows)}
        days = [date.fromisoformat(r["date"]) for r in rows]
        res["q4_learning"] = q4_sample(root, days, [d for d in attrs if d < days[0]][-12:], None)
        (OUT / "learning.json").write_text(json.dumps(res, indent=2))
    else:
        learning = json.loads((OUT / "learning.json").read_text())
        cuts = tuple(learning["q4_learning"]["or_cuts"])
        lo, hi = date(2024, 10, 9), date(2025, 10, 17)
        days = [d for d in attrs if lo <= d <= hi]
        pad = [d for d in attrs if d < lo][-12:]
        res = {"q4_confirmation": q4_sample(root, days, pad, cuts)}
        (OUT / "confirmation.json").write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    main()
