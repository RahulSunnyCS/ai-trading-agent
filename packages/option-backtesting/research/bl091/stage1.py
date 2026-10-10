"""BL-091 Stage 1a: the trading test with no hindsight (registered in the item before any run).

    uv run --with pandas python research/bl091/stage1.py plan
    uv run --with pandas python research/bl091/stage1.py check
    uv run --with pandas python research/bl091/stage1.py sim [--workers 6]
    uv run --with pandas python research/bl091/stage1.py read

plan  -> out/stage1_plan.csv: every held spike (first of its index-day flagged) and its 10 placebo
         days, with the first-entry minute, VIX regimes and size category.
check -> the ladder rules on a synthetic day, and the Directional template at 11:32 against the
         stored N_/S_dir_1132 results.
sim   -> results/stage1_sims.csv, one row per (index, day, arm, first entry), resumable.
read  -> out/stage1.md, the registered read-out.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
import yaml
from periods import M_1513, SIZING, UNDERLYINGS, assert_learning_day, learning_days
from r0 import attempt_row, classify, wide_strategy
from series import level, load_chain_day, rolling_straddle

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy
from option_backtesting.rotation.variants import STRATEGIES_DIR

HERE = Path(__file__).parent
PLAN = HERE / "out" / "stage1_plan.csv"
SIMS = HERE / "results" / "stage1_sims.csv"
M_1330 = 255
GIVEBACK = {"NIFTY": 15.0, "SENSEX": 54.0}
W_STOPS = (650.0, 1300.0, 1950.0)
RULES = ("R0", "R2", "R3", "R5", "R6")
DIR_STOPS = ((21, 3000.0), (25, 3600.0), (30, 4300.0))
ARMS = [f"W{int(s)}_{r}" for s in W_STOPS for r in RULES] + [f"D1_{p}" for p, _ in DIR_STOPS]
PLACEBO_EACH_SIDE = 5
# frozen cut points (registered): (index, regime) -> (P60, P85) on the level when the hold completes
CUTS2 = {("NIFTY", "lt13"): (31.82, 36.02), ("NIFTY", "ge13"): (35.21, 44.65),
         ("SENSEX", "ge13"): (126.27, 170.55)}  # fmt: skip
CUTS3 = {("NIFTY", "lt11"): (30.74, 34.03), ("NIFTY", "11to13"): (31.82, 37.52),
         ("NIFTY", "ge13"): (35.21, 44.65), ("SENSEX", "ge13"): (126.27, 170.55)}  # fmt: skip
SIM_COLUMNS = ["underlying", "day", "arm", "entry_min", "net0", "net20", "attempts", "held",
               "worst", "n_orders", "legs_short", "notes"]  # fmt: skip

_DIR: dict[str, dict] = {}


def dir_strategy(underlying: str, entry: str, leg_pct: float, overall: float) -> LegwiseStrategy:
    if underlying not in _DIR:
        path = STRATEGIES_DIR / f"{underlying[0]}_dir_1202.yaml"
        _DIR[underlying] = yaml.safe_load(path.read_text())["strategy"]
    d = yaml.safe_load(yaml.safe_dump(_DIR[underlying]))
    d["id"] = f"bl091_{underlying[0]}_dir_{leg_pct}"
    d["entry_time"] = entry
    for leg in d["legs"]:
        leg["stop_loss"] = {"percent": leg_pct}
    d["overall"]["stop_loss_inr"] = overall
    return LegwiseStrategy.model_validate(d)


def next_entry(rule: str, stop_min: int, first: int, x: list[float] | None, und: str) -> int | None:
    """The next attempt's entry minute after an overall stop at stop_min (None = no more)."""
    if rule in ("R0", "R6"):
        return stop_min + 1
    if rule == "R3":
        return max(stop_min + 1, M_1330)
    if rule == "R5":
        return stop_min + 20
    if rule == "R2":
        assert x is not None
        high = max(x[first : stop_min + 1])
        for j in range(stop_min + 1, M_1513 - 1):
            high = max(high, x[j])
            if high - x[j] >= GIVEBACK[und]:
                return j + 1
        return None
    raise ValueError(rule)


def run_wide(data, und: str, first: int, ref, stop: float, rule: str, x) -> list[dict]:
    rows: list[dict] = []
    entry: int | None = first
    for k in range(1, (3 if rule == "R6" else 5) + 1):
        if entry is None or entry >= M_1513:
            break
        res = simulate_day(wide_strategy(und, minute_label(entry), stop), data, ref, SIZING)
        row = attempt_row(k, entry, res)
        rows.append(row)
        if row["outcome"] != "OVERALL_SL" or row["exit_min"] is None:
            break
        entry = next_entry(rule, row["exit_min"], first, x, und)
    return rows


def summarise(und: str, day: str, arm: str, first: int, rows: list[dict]) -> dict:
    return {
        "underlying": und, "day": day, "arm": arm, "entry_min": first,
        "net0": round(sum(r["net0"] for r in rows), 2), "net20": round(sum(r["net20"] for r in rows), 2),
        "attempts": len(rows), "held": int(any(r["outcome"] == "HELD" for r in rows)),
        "worst": round(min((r["worst_mtm"] for r in rows), default=0.0), 2),
        "n_orders": sum(r["n_orders"] for r in rows),
        "legs_short": int(any(r["legs_entered"] < 2 for r in rows)),
        "notes": " | ".join(r["notes"] for r in rows if r["notes"])[:300],
    }  # fmt: skip


def _ref():
    sys.path.insert(0, str(HERE.parent / "common"))
    from early_ref import early_reference

    return early_reference()


def sim_day(task: tuple[str, str, list[tuple[str, int]]]) -> list[dict]:
    und, day_s, units = task
    day = date.fromisoformat(day_s)
    assert_learning_day(und, day)
    root, ref = data_dir(), _ref()
    data = load_day(root, und, day)
    x = None
    if any(a.endswith("_R2") for a, _ in units):
        x = level(rolling_straddle(load_chain_day(root, und, day))).x
    out = []
    for arm, first in units:
        try:
            if arm.startswith("W"):
                stop, rule = arm[1:].split("_")
                rows = run_wide(data, und, first, ref, float(stop), rule, x)
            else:
                pct = int(arm.split("_")[1])
                overall = dict(DIR_STOPS)[pct]
                res = simulate_day(
                    dir_strategy(und, minute_label(first), pct, overall), data, ref, SIZING
                )
                row = attempt_row(1, first, res)
                row["outcome"] = "HELD" if classify(res) != "OVERALL_SL" else "OVERALL_SL"
                rows = [row]
            out.append(summarise(und, day_s, arm, first, rows))
        except Exception as e:  # noqa: BLE001 -- recorded and re-run next time
            out.append({"underlying": und, "day": day_s, "arm": arm, "entry_min": first,
                        "notes": f"ERR {type(e).__name__}: {e}"[:300]})  # fmt: skip
    return out


def regime(v: float, three: bool) -> str:
    if v < 11 and three:
        return "lt11"
    if v < 13:
        return "11to13" if three else "lt13"
    return "ge13"


def category(und: str, reg: str, at_held: float, cuts: dict) -> str:
    c = cuts.get((und, reg))
    if c is None:
        return "pooled_low_vix"
    return "below_p60" if at_held < c[0] else ("p60_p85" if at_held < c[1] else "p85_plus")


def plan() -> None:
    root = data_dir()
    s = pd.read_csv(HERE / "out" / "sustained.csv")
    days = pd.read_csv(HERE / "out" / "days.csv")
    vix = days.set_index(["period", "underlying", "day"]).vix_open.to_dict()
    held = s[s.held_min.notna()].copy()
    held["entry_min"] = (held.held_min + 1).astype(int)
    held = held[held.entry_min < M_1513].sort_values(["period", "underlying", "day", "held_min"])
    held["first_of_day"] = ~held.duplicated(["period", "underlying", "day"])
    spike_days = set(zip(held.underlying, held.day, strict=True))
    rows = []
    for period, unds in UNDERLYINGS.items():
        for und in unds:
            ds = [d.isoformat() for d in learning_days(root, und, period)[0] if d.weekday() < 5]
            quiet = [d for d in ds if (und, d) not in spike_days]
            ev = held[(held.period == period) & (held.underlying == und)]
            for r in ev.itertuples(index=False):
                v = vix[(period, und, r.day)]
                r2, r3 = regime(v, False), regime(v, True)
                base = {"period": period, "underlying": und, "event_day": r.day,
                        "episode_idx": r.episode_idx, "first_of_day": bool(r.first_of_day),
                        "entry_min": int(r.entry_min), "dte": int(r.dte), "vix_open": v,
                        "regime2": r2, "regime3": r3, "at_held": r.at_held,
                        "cat2": category(und, r2, r.at_held, CUTS2),
                        "cat3": category(und, r3, r.at_held, CUTS3)}  # fmt: skip
                rows.append({**base, "role": "event", "day": r.day})
                i = sum(1 for d in quiet if d < r.day)
                for d in (
                    quiet[max(0, i - PLACEBO_EACH_SIDE) : i] + quiet[i : i + PLACEBO_EACH_SIDE]
                ):
                    rows.append({**base, "role": "placebo", "day": d})
    pd.DataFrame(rows).to_csv(PLAN, index=False)
    p = pd.DataFrame(rows)
    print(p.groupby(["period", "underlying", "role"]).size().to_string())


def sim(workers: int) -> int:
    p = pd.read_csv(PLAN)
    units = p[["underlying", "day", "entry_min"]].drop_duplicates()
    done: set[tuple] = set()
    if SIMS.exists():
        prev = pd.read_csv(SIMS)
        prev = prev[~prev.notes.fillna("").str.startswith("ERR")]
        done = set(zip(prev.underlying, prev.day, prev.arm, prev.entry_min, strict=True))
    by_day: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for r in units.itertuples(index=False):
        for arm in ARMS:
            if (r.underlying, r.day, arm, r.entry_min) not in done:
                by_day.setdefault((r.underlying, r.day), []).append((arm, int(r.entry_min)))
    todo = [(u, d, us) for (u, d), us in sorted(by_day.items())]
    print(
        f"{sum(len(t[2]) for t in todo)} runs on {len(todo)} index-days ({len(done)} done)",
        file=sys.stderr,
    )
    SIMS.parent.mkdir(exist_ok=True)
    new = not SIMS.exists()
    with open(SIMS, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SIM_COLUMNS, extrasaction="ignore")
        if new:
            w.writeheader()
        with ProcessPoolExecutor(max_workers=workers) as pool:
            for i, rows in enumerate(pool.map(sim_day, todo, chunksize=2)):
                w.writerows(rows)
                if (i + 1) % 50 == 0:
                    f.flush()
                    print(f"  {i + 1}/{len(todo)} days", file=sys.stderr)
    s = pd.read_csv(SIMS)
    ok = set(zip(s.underlying, s.day, s.arm, s.entry_min, strict=True)) - {
        k for k, n in zip(zip(s.underlying, s.day, s.arm, s.entry_min, strict=True),
                          s.notes.fillna(""), strict=True) if n.startswith("ERR")}  # fmt: skip
    missing = sum(1 for r in units.itertuples(index=False) for a in ARMS
                  if (r.underlying, r.day, a, r.entry_min) not in ok)  # fmt: skip
    print(f"done; {missing} runs missing or in error")
    return 0 if missing == 0 else 1


def check() -> int:
    from option_backtesting.legwise.market import N_MINUTES, DayData, Series
    from option_backtesting.rotation.store import read_net

    fails = []
    # rule arithmetic
    x = [100.0] * N_MINUTES
    for m in range(120, 140):
        x[m] = 120.0 - (m - 120)  # peak 120 at 120, falls 1 a minute
    assert next_entry("R0", 100, 90, None, "NIFTY") == 101
    assert next_entry("R3", 100, 90, None, "NIFTY") == M_1330
    assert next_entry("R3", 300, 90, None, "NIFTY") == 301
    assert next_entry("R5", 100, 90, None, "NIFTY") == 120
    r2 = next_entry("R2", 125, 90, x, "NIFTY")  # high 120 at 120; 105 reached at m=135
    if r2 != 136:
        fails.append(f"R2 entry {r2} != 136")
    if next_entry("R2", 125, 90, x, "SENSEX") is not None and max(x) - min(x[125:357]) < 54:
        fails.append("R2 SENSEX fired without a 54-point give-back")
    # ladders on a synthetic day where every attempt is stopped on its entry bar
    ref = _ref()
    exp, d0 = date(2025, 3, 6), date(2025, 3, 3)

    def ser(v):
        return Series(list(v), list(v), list(v), list(v))

    ce = [50.0 + 0.0 * m for m in range(N_MINUTES)]
    jump = [50.0 + 6.0 * (m // 1) for m in range(N_MINUTES)]  # +6 every minute: stops every bar
    data = DayData(d0, "NIFTY", ser([24000.0] * N_MINUTES),
                   {(exp, 24050.0, "CE"): ser(jump), (exp, 23950.0, "PE"): ser(ce)}, [exp], None)  # fmt: skip
    n = {
        rule: len(run_wide(data, "NIFTY", 100, ref, 650.0, rule, [0.0] * N_MINUTES))
        for rule in RULES
    }
    if n["R0"] != 5 or n["R6"] != 3 or n["R5"] != 5:
        fails.append(f"attempt counts {n}")
    entries = [r["entry_min"] for r in run_wide(data, "NIFTY", 100, ref, 650.0, "R5", None)]
    if any(b - a < 20 for a, b in zip(entries, entries[1:], strict=False)):
        fails.append(f"R5 entries {entries}")
    entries = [r["entry_min"] for r in run_wide(data, "NIFTY", 100, ref, 650.0, "R3", None)]
    if any(e < M_1330 for e in entries[1:]):
        fails.append(f"R3 entries {entries}")
    # Directional at 11:32 reproduces the stored 11:32 results (21 %, ₹3,000)
    root = data_dir()
    bad, cnt = [], 0
    for und, name in (("NIFTY", "N_dir_1132"), ("SENSEX", "S_dir_1132")):
        stored = read_net(name, root)
        for d in [d for d in sorted(stored) if date(2025, 3, 3) <= d <= date(2025, 3, 28)][:12]:
            assert_learning_day(und, d)
            res = simulate_day(
                dir_strategy(und, "11:32", 21, 3000.0), load_day(root, und, d), ref, SIZING
            )
            cnt += 1
            if abs(res.gross - res.costs - stored[d]) > 0.01:
                bad.append((und, d, round(res.gross - res.costs, 2), stored[d]))
    if cnt < 24 or bad:
        fails.append(f"Directional 11:32: {cnt} days, differ {bad[:3]}")
    print("ALL PASS" if not fails else "FAILED: " + "; ".join(fails))
    return 1 if fails else 0


def tstat(v: pd.Series) -> float:
    v = v.dropna()
    if len(v) < 3 or v.std(ddof=1) == 0:
        return float("nan")
    return v.mean() / (v.std(ddof=1) / math.sqrt(len(v)))


def read() -> None:
    p = pd.read_csv(PLAN)
    s = pd.read_csv(SIMS)
    s = s[~s.notes.fillna("").str.startswith("ERR")]
    m = p.merge(s, on=["underlying", "day", "entry_min"], how="left")
    key = ["period", "underlying", "event_day", "episode_idx", "arm"]
    ev = m[m.role == "event"].set_index(key)
    pl = m[m.role == "placebo"].groupby(key).agg(pl_net0=("net0", "mean"), pl_net20=("net20", "mean"),
                                                 pl_n=("net0", "size"), pl_held=("held", "mean"))  # fmt: skip
    t = ev.join(pl, how="left").reset_index()
    t["diff0"] = t.net0 - t.pl_net0
    t["diff20"] = t.net20 - t.pl_net20
    t.to_csv(HERE / "out" / "stage1_events.csv", index=False)
    lab = {
        ("P2", "NIFTY"): "NIFTY 2025",
        ("P3", "NIFTY"): "NIFTY 2022–24",
        ("P2", "SENSEX"): "SENSEX 2025",
    }

    def table(df: pd.DataFrame, by: list[str]) -> pd.DataFrame:
        g = df.groupby(by)
        out = g.agg(events=("net0", "size"), event_mean=("net0", "mean"), placebo_mean=("pl_net0", "mean"),
                    diff=("diff0", "mean"), held=("held", "mean"), attempts=("attempts", "mean"),
                    worst=("net0", "min"), mean20=("net20", "mean"), diff20=("diff20", "mean"))  # fmt: skip
        out["t"] = g.diff0.apply(tstat)
        out["note"] = ["inconclusive" if n < 20 else "" for n in out.events]
        return out.round(2)

    lines = ["# BL-091 Stage 1a read-out (P2 + P3; registered 2026-10-11)", ""]
    prim = t[t.first_of_day]
    for (per, und), g in prim.groupby(["period", "underlying"]):
        lines += [
            f"## {lab[(per, und)]}: first held spike of each day",
            "",
            table(g, ["arm"]).to_markdown(),
            "",
        ]
    lines += [
        "## Screening bar (registered): diff > 0 with t ≥ 2 in NIFTY 2025, same sign in 2022–24, mean at ₹20 > 0",
        "",
    ]
    a = table(prim[(prim.period == "P2") & (prim.underlying == "NIFTY")], ["arm"])
    b = table(prim[prim.period == "P3"], ["arm"])
    passing = [arm for arm in a.index if a.loc[arm, "diff"] > 0 and a.loc[arm, "t"] >= 2
               and b.loc[arm, "diff"] > 0 and a.loc[arm, "mean20"] > 0]  # fmt: skip
    lines += [f"Arms passing: {', '.join(passing) if passing else 'none'}", ""]
    for col, cat in (("regime2", "cat2"), ("regime3", "cat3")):
        for (per, und), g in prim.groupby(["period", "underlying"]):
            lines += [f"## {lab[(per, und)]} by {col} × size category", "",
                      table(g, [col, cat, "arm"]).to_markdown(), ""]  # fmt: skip
    for (per, und), g in prim.groupby(["period", "underlying"]):
        lines += [f"## {lab[(per, und)]}: expiry day or not", "",
                  table(g.assign(expiry=g.dte == 0), ["expiry", "arm"]).to_markdown(), ""]  # fmt: skip
    for (per, und), g in t.groupby(["period", "underlying"]):
        dm = g.groupby(["event_day", "arm"]).diff0.mean().reset_index()
        sec = dm.groupby("arm").agg(days=("diff0", "size"), diff=("diff0", "mean"))
        sec["t_days"] = dm.groupby("arm").diff0.apply(tstat)
        lines += [f"## {lab[(per, und)]}: every held spike (secondary, t over day means)", "",
                  sec.round(2).to_markdown(), ""]  # fmt: skip
    (HERE / "out" / "stage1.md").write_text("\n".join(lines))
    print("wrote out/stage1.md")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["plan", "check", "sim", "read"])
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    if a.step == "plan":
        plan()
        return 0
    if a.step == "check":
        return check()
    if a.step == "sim":
        return sim(a.workers)
    read()
    return 0


if __name__ == "__main__":
    sys.exit(main())
