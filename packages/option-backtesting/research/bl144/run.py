"""BL-144: a year of daily results for 3 x Widesl, the base, Core and T1, with day and 7-day ranges,
and the T1 range-bound study. Rules are fixed in backlog/BL-144-t1-range-bound-days.md (committed
before this ran, narrowed on 2026-10-21 to no basket stop); nothing here is tuned. Read-only over the
stored results, the journals and the lake's index bars; writes only under research/bl144/out/
(git-ignored).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl144/run.py"""

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
START = date(2026, 10, 20).replace(year=2025)  # 2025-10-20
WIDE = "N_wide_0917"
DIR = base_mod.DIR_NAME
SEED = 20261021
RESAMPLES = 2000
BLOCK = 5
BOOKS = ("W3", "BASE", "CORE", "T1")


def index_days(root: Path, days: list[date]) -> dict[date, dict]:
    """{day: open, high, low, close} of NIFTY's 1-minute index bars."""
    paths = [str(lake.bars_1m_path(root, "index", "NIFTY", d)) for d in days]
    paths = [p for p in paths if Path(p).exists()]
    con = duckdb.connect()
    rows = con.execute(
        "SELECT date, first(open ORDER BY ts), max(high), min(low), last(close ORDER BY ts) "
        "FROM read_parquet(?, hive_partitioning=true) GROUP BY date ORDER BY date",
        [paths],
    ).fetchall()
    con.close()
    return {d: {"open": o, "high": h, "low": lo, "close": c} for d, o, h, lo, c in rows}


def ranges(root: Path, days: list[date]) -> dict[date, dict]:
    """D (percent of the previous close, and points), R7 (mean of the 7 previous sessions' D) and
    H7 (highest high minus lowest low over those 7 sessions, percent of the previous close)."""
    bars = index_days(root, days)
    seq = [d for d in days if d in bars]
    out: dict[date, dict] = {}
    pct: dict[date, float] = {}
    for i, d in enumerate(seq):
        if i == 0:
            continue
        prev = bars[seq[i - 1]]["close"]
        b = bars[d]
        pct[d] = (b["high"] - b["low"]) / prev * 100
        out[d] = {"d_pts": b["high"] - b["low"], "d_pct": pct[d], "prev_close": prev}
    for i, d in enumerate(seq):
        if i < 8 or d not in out:
            continue
        prior = seq[i - 7 : i]
        if any(p not in pct for p in prior):
            continue
        prev = bars[seq[i - 1]]["close"]
        out[d]["r7_pct"] = float(np.mean([pct[p] for p in prior]))
        out[d]["h7_pct"] = (
            (max(bars[p]["high"] for p in prior) - min(bars[p]["low"] for p in prior)) / prev * 100
        )
        out[d]["h7_pts"] = max(bars[p]["high"] for p in prior) - min(bars[p]["low"] for p in prior)
    return out


def picks_for(root: Path, track: str | None, day: date, rec) -> list[str] | None:
    """Adaptive's core + Buy picks: the journal's entry when there is one, else re-scored."""
    for e in journal.read(store.journal_path(root, track)):
        if e.get("day") == day.isoformat():
            block = e["lists"]["C"]
            return list(block["core"]) + list(block.get("buy") or [])
    got = rec.picks(day)
    if not got:
        return None
    return list(got["C"]["core"]) + list(got["C"].get("buy") or [])


def is_wide(name: str, cache: dict[str, tuple[bool, float]]) -> tuple[bool, float]:
    """(every leg's stop loss is at least 100 percent, mean leg stop percent)."""
    if name not in cache:
        spec = load_legwise(strategy_path(name))
        sl = [leg.stop_loss.percent for leg in spec.legs if leg.stop_loss and leg.stop_loss.percent]
        cache[name] = (bool(sl) and min(sl) >= 100, float(np.mean(sl)) if sl else float("nan"))
    return cache[name]


def gross_of(root: Path, name: str, day: date, memo: dict) -> float | None:
    if name not in memo:
        path = base_mod._path(root) if name == DIR else store.result_path(name, root)
        memo[name] = base_mod.read_column(path, "gross")
    return memo[name].get(day)


def bootstrap_diff(groups: np.ndarray, wide: np.ndarray, npick: np.ndarray) -> dict:
    """Share(low) - share(high) of wide-stop picks, with a 90% circular 5-day block bootstrap."""
    n = len(groups)
    rng = np.random.default_rng(SEED)

    def stat(idx: np.ndarray) -> float:
        g, w, k = groups[idx], wide[idx], npick[idx]
        lo, hi = g == "low", g == "high"
        if k[lo].sum() == 0 or k[hi].sum() == 0:
            return float("nan")
        return 100 * (w[lo].sum() / k[lo].sum() - w[hi].sum() / k[hi].sum())

    point = stat(np.arange(n))
    draws = []
    nblocks = int(np.ceil(n / BLOCK))
    for _ in range(RESAMPLES):
        starts = rng.integers(0, n, nblocks)
        idx = np.concatenate([(s + np.arange(BLOCK)) % n for s in starts])[:n]
        draws.append(stat(idx))
    d = np.array([x for x in draws if x == x])
    return {"point": point, "lo90": float(np.percentile(d, 5)), "hi90": float(np.percentile(d, 95))}


def bootstrap_mean_diff(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> dict:
    """Mean of (a - b) over `mask` days, with a 90% circular 5-day block bootstrap."""
    n = len(a)
    diff = a - b
    rng = np.random.default_rng(SEED)
    point = float(np.nanmean(diff[mask]))
    draws = []
    nblocks = int(np.ceil(n / BLOCK))
    for _ in range(RESAMPLES):
        starts = rng.integers(0, n, nblocks)
        idx = np.concatenate([(s + np.arange(BLOCK)) % n for s in starts])[:n]
        m = mask[idx]
        if m.sum():
            draws.append(float(np.nanmean(diff[idx][m])))
    d = np.array(draws)
    return {"point": point, "lo90": float(np.percentile(d, 5)), "hi90": float(np.percentile(d, 95))}


def terciles(values: np.ndarray) -> tuple[float, float]:
    ok = values[~np.isnan(values)]
    return float(np.percentile(ok, 100 / 3)), float(np.percentile(ok, 200 / 3))


def analyse(rows: list[dict]) -> None:
    """The registered study: H1 (wide-stop share by R7 regime) and H2 (T1 vs BASE on range-bound days)."""
    f = lambda k: np.array([np.nan if r.get(k) in (None, "") else float(r[k]) for r in rows])  # noqa: E731
    r7, dpct = f("r7_pct"), f("d_pct")
    have = ~np.isnan(r7)
    c1, c2 = terciles(r7)
    d1, d2 = terciles(dpct)
    group = np.array(["low" if v <= c1 else "high" if v >= c2 else "mid" for v in r7])
    dgroup = np.array(["low" if v <= d1 else "high" if v >= d2 else "mid" for v in dpct])
    out: dict = {"days": len(rows), "r7_cuts": [c1, c2], "d_cuts": [d1, d2], "h1": {}, "h2": {}}
    for key in ("T1", "CORE"):
        wide, npick, sl = f(f"{key}_wide"), f(f"{key}_n"), f(f"{key}_sl")
        ok = have & ~np.isnan(npick)
        res = {}
        for g in ("low", "mid", "high"):
            m = ok & (group == g)
            res[g] = {
                "days": int(m.sum()),
                "wide_share": float(wide[m].sum() / npick[m].sum()) if m.sum() else None,
                "mean_sl": float(np.nanmean(sl[m])) if m.sum() else None,
            }
        sel = np.where(ok)[0]
        res["low_minus_high_pp"] = bootstrap_diff(
            group[sel], np.nan_to_num(wide[sel]), np.nan_to_num(npick[sel])
        )
        out["h1"][key] = res
    # H2 and context: per lot-day net by the day's own range tercile
    pl = {k: f(f"{k}_gross") / f(f"{k}_lots") for k in BOOKS}
    for k in BOOKS:
        out.setdefault("per_lot_day_by_d", {})[k] = {
            g: float(np.nanmean(pl[k][dgroup == g])) for g in ("low", "mid", "high")
        }
        out.setdefault("per_lot_day_by_r7", {})[k] = {
            g: float(np.nanmean(pl[k][have & (group == g)])) for g in ("low", "mid", "high")
        }
        out.setdefault("total", {})[k] = float(np.nansum(f(f"{k}_gross")))
    low_d = dgroup == "low"
    out["h2"] = bootstrap_mean_diff(
        pl["T1"], pl["BASE"], low_d & ~np.isnan(pl["T1"]) & ~np.isnan(pl["BASE"])
    )
    out["h2"]["t1_mean"] = out["per_lot_day_by_d"]["T1"]["low"]
    out["h2"]["base_mean"] = out["per_lot_day_by_d"]["BASE"]["low"]
    (OUT / "study.json").write_text(json.dumps(out, indent=2, default=float) + "\n")
    print(json.dumps(out, indent=2, default=float))


def main() -> None:
    root = data_dir()
    if not str(root).startswith("/Volumes/TradingData"):
        raise SystemExit(f"TRADING_DATA_ROOT is {root}: set it to /Volumes/TradingData")
    OUT.mkdir(parents=True, exist_ok=True)

    names_core = variant_names()
    names_t1 = names_core + track_names("t1")
    rec_core = daylog.reconstruction(root, names_core)
    rec_t1 = daylog.reconstruction(root, names_t1)
    attrs = sorted(d for d in rec_core.attrs if d.weekday() < 5)
    window = [d for d in attrs if d >= START]
    rng = ranges(root, attrs[max(0, attrs.index(window[0]) - 12) :])

    memo: dict[str, dict] = {}
    sl_cache: dict[str, tuple[bool, float]] = {}
    rows: list[dict] = []
    left_out: list[str] = []
    for d in window:
        r = rng.get(d, {})
        row: dict = {
            "date": d.isoformat(),
            "weekday": d.strftime("%a"),
            **{k: r.get(k) for k in ("d_pct", "d_pts", "r7_pct", "h7_pct", "h7_pts")},
        }
        books: dict[str, list[tuple[str, int]]] = {
            "W3": [(WIDE, 3)],
            "BASE": [(WIDE, 2), (DIR, 1)],
        }
        for key, track, rec in (("CORE", None, rec_core), ("T1", "t1", rec_t1)):
            names = picks_for(root, track, d, rec)
            books[key] = [(n, 1) for n in names] if names else []
            if names:
                flags = [is_wide(n, sl_cache) for n in names]
                row[f"{key}_picks"] = " ".join(names)
                row[f"{key}_wide"] = sum(1 for w, _ in flags if w)
                row[f"{key}_n"] = len(names)
                row[f"{key}_sl"] = float(np.mean([s for _, s in flags]))
        for key, picks in books.items():
            g = [gross_of(root, n, d, memo) for n, _ in picks]
            if not picks or any(v is None for v in g):
                row[f"{key}_gross"] = None
                row[f"{key}_lots"] = sum(n_lots for _, n_lots in picks)
                left_out.append(f"{d} {key}")
                continue
            lots = sum(n_lots for _, n_lots in picks)
            row[f"{key}_gross"] = round(
                sum(v * n_lots for v, (_, n_lots) in zip(g, picks, strict=True)), 2
            )
            row[f"{key}_lots"] = lots
        rows.append(row)

    cols = list(dict.fromkeys(k for r in rows for k in r))
    name = "daily.csv"
    with (OUT / name).open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)
    (OUT / "left_out.txt").write_text("\n".join(left_out) + "\n")
    print(f"{len(rows)} days -> {OUT / name}; {len(left_out)} book-days left out")
    analyse(rows)


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    main()
