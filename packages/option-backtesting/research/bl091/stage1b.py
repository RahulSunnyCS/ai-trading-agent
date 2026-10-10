"""BL-091 Stage 1b: Directional D2 at support and resistance (registered 2026-10-11).

    uv run --with pandas --with tabulate python research/bl091/stage1b.py check
    uv run --with pandas --with tabulate python research/bl091/stage1b.py entries
    uv run --with pandas --with tabulate python research/bl091/stage1b.py sim [--workers 7]
    uv run --with pandas --with tabulate python research/bl091/stage1b.py read

A D2 trade is the Stage 1a Directional (`D1_<leg %>`) entered at a different minute, so the trades
reuse stage1.sim_day and its results file; this script only finds the entry minute.

Trend = sign of the index move from the spike's low minute to the hold minute. Levels on the trend
side at the hold minute (resistance at or above the index when rising, support at or below when
falling), all known before the minute they are used:
  pivots P R1 R2 S1 S2 (previous day), previous 1/2/3-day high and low, 20/50/100/200-day simple
  moving averages of daily closes, the 09:15–09:45 range (from 09:45), round numbers (NIFTY 500s,
  SENSEX 1,000s), the call / put strike with the most open interest (last snapshot at or before the
  minute), and today's open ± the 09:20 rolling ATM straddle (from 09:21).
Rejection: the index comes within 0.1 % of a level and a 1-minute close is back on the near side
within 3 minutes of the touch; entry the next minute. Break: a completed 5-minute bar closes beyond
the level; entry the next minute. Window: the minute after the hold to 15:12.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from datetime import date
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
from periods import M_1512, M_1513, assert_learning_day
from series import load_chain_day, rolling_straddle
from trading_data import lake

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import N_MINUTES, _load_bars, _minutes

HERE = Path(__file__).parent
TOL = 0.001
LAST_READABLE = date(2025, 8, 29)  # nothing after P2's end is read (P1 and the gap stay unread)
ROUND = {"NIFTY": 500.0, "SENSEX": 1000.0}
PCTS = (21, 25, 30)
ENTRIES = HERE / "out" / "stage1b_entries.csv"
UNITS = HERE / "out" / "stage1b_plan.csv"


def daily_bars(root: Path, und: str) -> pd.DataFrame:
    """Daily O/H/L/C from the 1-minute index bars, every day up to LAST_READABLE."""
    days = [d for d in lake.available_days(root, "index", und) if d <= LAST_READABLE]
    rows = []
    for d in days:
        t = pq.read_table(
            lake.bars_1m_path(root, "index", und, d), columns=["ts", "open", "high", "low", "close"]
        )
        mins = _minutes(t)
        keep = [i for i, m in enumerate(mins) if 0 <= m < N_MINUTES]
        if len(keep) < 300:
            continue
        o, h, lo, c = (t.column(n).to_pylist() for n in ("open", "high", "low", "close"))
        first, last = min(keep, key=lambda i: mins[i]), max(keep, key=lambda i: mins[i])
        rows.append({"day": d, "open": o[first], "high": max(h[i] for i in keep),
                     "low": min(lo[i] for i in keep), "close": c[last]})  # fmt: skip
    return pd.DataFrame(rows).set_index("day").sort_index()


def day_levels(daily: pd.DataFrame, day: date, step: float) -> dict[str, float]:
    """Levels fixed before the session: pivots, previous highs / lows, moving averages."""
    prior = daily[daily.index < day]
    if len(prior) < 3:
        return {}
    y = prior.iloc[-1]
    p = (y.high + y.low + y.close) / 3
    lv = {"pivot_P": p, "pivot_R1": 2 * p - y.low, "pivot_S1": 2 * p - y.high,
          "pivot_R2": p + (y.high - y.low), "pivot_S2": p - (y.high - y.low)}  # fmt: skip
    for k in (1, 2, 3):
        lv[f"prev{k}d_high"] = prior.high.iloc[-k:].max()
        lv[f"prev{k}d_low"] = prior.low.iloc[-k:].min()
    for n in (20, 50, 100, 200):
        if len(prior) >= n:
            lv[f"sma{n}"] = prior.close.iloc[-n:].mean()
    return lv


def max_oi_strikes(root: Path, und: str, day: date, expiry: date) -> dict[int, tuple[float, float]]:
    """minute -> (call strike with the most OI, put strike with the most OI), last snapshot <= minute."""
    t = pq.read_table(
        lake.bars_1m_path(root, "option", und, day),
        columns=["ts", "expiry", "strike", "option_type", "oi"],
    )
    df = t.to_pandas()
    df["m"] = _minutes(t)
    df = df[(df.expiry == expiry) & (df.m >= 0) & (df.m < N_MINUTES) & (df.oi > 0)]
    out: dict[int, tuple[float, float]] = {}
    piv = {k: g.pivot_table(index="m", columns="strike", values="oi", aggfunc="last")
              .reindex(range(N_MINUTES)).ffill() for k, g in df.groupby("option_type")}  # fmt: skip
    if "CE" not in piv or "PE" not in piv:
        return out
    ce = piv["CE"].dropna(how="all").idxmax(axis=1).reindex(range(N_MINUTES))
    pe = piv["PE"].dropna(how="all").idxmax(axis=1).reindex(range(N_MINUTES))
    for m in range(N_MINUTES):
        if (
            isinstance(ce.iloc[m], float)
            and isinstance(pe.iloc[m], float)
            and not (math.isnan(ce.iloc[m]) or math.isnan(pe.iloc[m]))
        ):
            out[m] = (float(ce.iloc[m]), float(pe.iloc[m]))
    return out


def find_entries(ev: dict, root: Path, daily: pd.DataFrame) -> dict:
    """The rejection and break entry minutes for one event, and which level fired."""
    und, day = ev["underlying"], date.fromisoformat(ev["event_day"])
    assert_learning_day(und, day)
    spot = _load_bars(lake.bars_1m_path(root, "index", und, day))
    hi, lo, cl = spot.high, spot.low, spot.close
    start, held = int(ev["start_min"]), int(ev["held_min"])
    move = cl[held] - cl[start]
    out = {"trend": "up" if move > 0 else ("down" if move < 0 else "flat"), "rej_min": None,
           "rej_level": "", "brk_min": None, "brk_level": "", "n_levels": 0, "touches": 0}  # fmt: skip
    if move == 0:
        return out
    up = move > 0
    chain = load_chain_day(root, und, day)
    s0920 = rolling_straddle(chain).s[5]  # the 09:20 straddle itself; None if unpriced
    fixed = day_levels(daily, day, chain.step)
    oi = max_oi_strikes(root, und, day, chain.expiry)
    or_hi, or_lo = max(hi[0:30]), min(lo[0:30])
    rnd = ROUND[und]

    def levels_at(m: int) -> dict[str, float]:
        lv = dict(fixed)
        if m >= 30:
            lv["open_range_high"], lv["open_range_low"] = or_hi, or_lo
        base = cl[m - 1] if m > 0 else cl[0]
        lv["round_above"] = math.ceil(base / rnd) * rnd
        lv["round_below"] = math.floor(base / rnd) * rnd
        if m - 1 in oi:
            lv["max_oi_call"], lv["max_oi_put"] = oi[m - 1]
        if m >= 6 and s0920 is not None:
            lv["expected_up"], lv["expected_down"] = spot.open[0] + s0920, spot.open[0] - s0920
        return lv

    ref = cl[held]
    side = (lambda v: v >= ref * (1 - TOL)) if up else (lambda v: v <= ref * (1 + TOL))
    out["n_levels"] = sum(1 for v in levels_at(held + 1).values() if side(v))
    pending: dict[str, int] = {}
    for t in range(held + 1, M_1512 + 1):
        lv = {k: v for k, v in levels_at(t).items() if side(v)}
        for k, v in lv.items():
            touched = hi[t] >= v * (1 - TOL) if up else lo[t] <= v * (1 + TOL)
            if touched and k not in pending:
                pending[k] = t
                out["touches"] += 1
        if out["rej_min"] is None:
            for k, t0 in list(pending.items()):
                v = lv.get(k)
                if v is None or t - t0 > 3:
                    pending.pop(k, None)
                    continue
                if (cl[t] < v) if up else (cl[t] > v):
                    out["rej_min"], out["rej_level"] = t + 1, k
                    break
        if out["brk_min"] is None and t % 5 == 4 and t >= 9:
            c5, c5p = cl[t], cl[t - 5]
            for k, v in lv.items():
                if (c5 > v >= c5p) if up else (c5 < v <= c5p):
                    out["brk_min"], out["brk_level"] = t + 1, k
                    break
    for key in ("rej_min", "brk_min"):
        if out[key] is not None and out[key] >= M_1513:
            out[key] = None
    return out


def entries() -> None:
    root = data_dir()
    plan = pd.read_csv(HERE / "out" / "stage1_plan.csv")
    sus = pd.read_csv(HERE / "out" / "sustained.csv")
    ev = plan[plan.role == "event"].merge(
        sus[["period", "underlying", "day", "episode_idx", "start_min", "held_min"]].rename(columns={"day": "event_day"}),
        on=["period", "underlying", "event_day", "episode_idx"])  # fmt: skip
    daily = {u: daily_bars(root, u) for u in ev.underlying.unique()}
    rows = []
    for r in ev.to_dict("records"):
        rows.append({**{k: r[k] for k in ("period", "underlying", "event_day", "episode_idx", "first_of_day",
                                           "entry_min", "start_min", "held_min")},
                     **find_entries(r, root, daily[r["underlying"]])})  # fmt: skip
    df = pd.DataFrame(rows)
    df.to_csv(ENTRIES, index=False)
    # trade units: each D2 entry on the event day and on the event's comparison days
    pl = plan[["period", "underlying", "event_day", "episode_idx", "role", "day"]]
    units = []
    for kind in ("rej", "brk"):
        e = df[df[f"{kind}_min"].notna()]
        u = pl.merge(e[["period", "underlying", "event_day", "episode_idx", f"{kind}_min"]],
                     on=["period", "underlying", "event_day", "episode_idx"])  # fmt: skip
        u = u.rename(columns={f"{kind}_min": "entry_min"}).assign(kind=kind)
        units.append(u)
    pd.concat(units).astype({"entry_min": int}).to_csv(UNITS, index=False)
    print(df.groupby(["period", "underlying"]).agg(events=("trend", "size"),
          rejections=("rej_min", "count"), breaks=("brk_min", "count"),
          levels_on_side=("n_levels", "median"), touches=("touches", "median")).to_string())  # fmt: skip
    print(df.rej_level.value_counts().head(20).to_string())
    print(df.brk_level.value_counts().head(20).to_string())


def sim(workers: int) -> int:
    from concurrent.futures import ProcessPoolExecutor

    from stage1 import SIM_COLUMNS, SIMS, sim_day

    u = pd.read_csv(UNITS)[["underlying", "day", "entry_min"]].drop_duplicates()
    done: set[tuple] = set()
    if SIMS.exists():
        prev = pd.read_csv(SIMS)
        prev = prev[~prev.notes.fillna("").str.startswith("ERR")]
        done = set(zip(prev.underlying, prev.day, prev.arm, prev.entry_min, strict=True))
    by_day: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for r in u.itertuples(index=False):
        for p in PCTS:
            arm = f"D1_{p}"
            if (r.underlying, r.day, arm, r.entry_min) not in done:
                by_day.setdefault((r.underlying, r.day), []).append((arm, int(r.entry_min)))
    todo = [(a, b, c) for (a, b), c in sorted(by_day.items())]
    print(f"{sum(len(t[2]) for t in todo)} runs on {len(todo)} index-days", file=sys.stderr)
    with open(SIMS, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SIM_COLUMNS, extrasaction="ignore")
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for rows in pool.map(sim_day, todo, chunksize=2):
                w.writerows(rows)
    return 0


def check() -> int:
    fails = []
    d = pd.DataFrame({"open": [100, 110, 120], "high": [105, 115, 130], "low": [95, 105, 110],
                      "close": [102, 112, 125]}, index=[date(2025, 3, 3), date(2025, 3, 4), date(2025, 3, 5)])  # fmt: skip
    lv = day_levels(d, date(2025, 3, 6), 50.0)
    p = (130 + 110 + 125) / 3
    if abs(lv["pivot_P"] - p) > 1e-9 or abs(lv["pivot_R1"] - (2 * p - 110)) > 1e-9:
        fails.append("pivots")
    if lv["prev3d_high"] != 130 or lv["prev3d_low"] != 95 or lv["prev1d_low"] != 110:
        fails.append("previous highs / lows")
    if day_levels(d, date(2025, 3, 5), 50.0):
        fails.append("levels used with fewer than 3 prior days")
    lv5 = day_levels(d, date(2025, 3, 5), 50.0) or {}
    if "pivot_P" in lv5:
        fails.append("same-day bar leaked into levels")
    root = data_dir()
    daily = daily_bars(root, "NIFTY")
    if daily.index.max() > LAST_READABLE:
        fails.append("daily bars read past P2")
    print("ALL PASS" if not fails else "FAILED: " + "; ".join(fails))
    return 1 if fails else 0


def tstat(v: pd.Series) -> float:
    v = v.dropna()
    return (
        float("nan")
        if len(v) < 3 or v.std(ddof=1) == 0
        else v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))
    )


def read() -> None:
    from stage1 import SIMS

    e = pd.read_csv(ENTRIES)
    u = pd.read_csv(UNITS)
    s = pd.read_csv(SIMS)
    s = s[~s.notes.fillna("").str.startswith("ERR")]
    m = u.merge(s[s.arm.str.startswith("D1_")], on=["underlying", "day", "entry_min"])
    key = ["period", "underlying", "event_day", "episode_idx", "kind", "arm"]
    ev = m[m.role == "event"].set_index(key)[["net0", "net20", "held", "worst"]]
    pl = m[m.role == "placebo"].groupby(key).agg(pl_net0=("net0", "mean"), pl_n=("net0", "size"))
    t = ev.join(pl).reset_index()
    t["diff0"] = t.net0 - t.pl_net0
    t = t.merge(e[["period", "underlying", "event_day", "episode_idx", "first_of_day"]],
                on=["period", "underlying", "event_day", "episode_idx"])  # fmt: skip
    t.to_csv(HERE / "out" / "stage1b_events.csv", index=False)
    lines = ["# BL-091 Stage 1b read-out: Directional D2 at support / resistance", ""]
    prim = t[t.first_of_day]
    g = prim.groupby(["period", "underlying", "kind", "arm"])
    tab = g.agg(events=("net0", "size"), event_mean=("net0", "mean"), placebo_mean=("pl_net0", "mean"),
                diff=("diff0", "mean"), held=("held", "mean"), mean20=("net20", "mean"))  # fmt: skip
    tab["t"] = g.diff0.apply(tstat)
    lines += [tab.round(2).to_markdown(), ""]
    (HERE / "out" / "stage1b.md").write_text("\n".join(lines))
    print("wrote out/stage1b.md")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["check", "entries", "sim", "read"])
    ap.add_argument("--workers", type=int, default=7)
    a = ap.parse_args()
    return {"check": check, "entries": lambda: entries() or 0, "sim": lambda: sim(a.workers),
            "read": lambda: read() or 0}[a.step]()  # fmt: skip


if __name__ == "__main__":
    sys.exit(main())
