"""BL-091 Stage 2: reverse engineering the true top (registered 2026-10-11).

    uv run --with pandas --with tabulate python research/bl091/stage2.py build [--workers 7]
    uv run --with pandas --with tabulate python research/bl091/stage2.py analyse

build   -> out/stage2_candidates.csv: one row per candidate (a new high of the rolling straddle from
           the hold to 15:12), its hindsight labels and every registered parameter at that minute.
analyse -> out/stage2.md: true vs false tops per parameter (medians, AUC, day-block permutation),
           discovery and check sets, and whether any parameter separates.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from episodes import scan_episodes
from periods import M_1512, M_1528, SIZING, assert_learning_day
from r0 import classify, wide_strategy
from series import first_priced, level, load_chain_day, rolling_straddle
from stage1 import CUTS2, category, regime
from stage1b import ROUND, TOL, daily_bars, day_levels, max_oi_strikes
from sustained import DECAY, RISE
from trading_data import lake

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import (
    N_MINUTES,
    _load_bars,
    _minutes,
    load_day,
    minute_label,
)

HERE = Path(__file__).parent
OUT = HERE / "out" / "stage2_candidates.csv"
GIVE = {"NIFTY": 15.0, "SENSEX": 54.0}
OTHERS = ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY")


def _ref():
    sys.path.insert(0, str(HERE.parent / "common"))
    from early_ref import early_reference

    return early_reference()


def _ffill(a: np.ndarray) -> np.ndarray:
    return pd.Series(a).ffill().to_numpy()


def option_arrays(root: Path, und: str, day: date, expiry: date):
    """Per (strike, type): volume and forward-filled OI on the minute grid; chain volume per minute."""
    t = pq.read_table(lake.bars_1m_path(root, "option", und, day),
                      columns=["ts", "expiry", "strike", "option_type", "volume", "oi"])  # fmt: skip
    t = t.filter(pc.equal(t["expiry"], pa.scalar(expiry, pa.date32())))
    m = np.array(_minutes(t))
    df = pd.DataFrame({"m": m, "k": t.column("strike").to_numpy(zero_copy_only=False),
                       "ty": t.column("option_type").to_pylist(),
                       "v": t.column("volume").to_numpy(zero_copy_only=False),
                       "oi": t.column("oi").to_numpy(zero_copy_only=False)})  # fmt: skip
    df = df[(df.m >= 0) & (df.m < N_MINUTES)]
    chain_vol = np.zeros(N_MINUTES)
    np.add.at(chain_vol, df.m.to_numpy(), np.nan_to_num(df.v.to_numpy(dtype=float)))
    vol, oi = {}, {}
    for (k, ty), g in df.groupby(["k", "ty"]):
        v = np.zeros(N_MINUTES)
        v[g.m.to_numpy()] = np.nan_to_num(g.v.to_numpy(dtype=float))
        o = np.full(N_MINUTES, np.nan)
        o[g.m.to_numpy()] = g.oi.to_numpy(dtype=float)
        o[o <= 0] = np.nan
        vol[(float(k), ty)] = v
        oi[(float(k), ty)] = _ffill(o)
    return vol, oi, chain_vol


def _bars(root: Path, sym: str, day: date):
    s = _load_bars(lake.bars_1m_path(root, "index", sym, day))
    if s is None:
        return None
    return {k: np.array([np.nan if v is None else v for v in getattr(s, k)], dtype=float)
            for k in ("open", "high", "low", "close")}  # fmt: skip


def _pct(a: float, b: float) -> float:
    return float("nan") if not (a and b) or math.isnan(a) or math.isnan(b) else (a / b - 1) * 100


def broke(b: dict | None, t: int, up: bool | None) -> float:
    """1 if a 1-minute close in t-2..t broke the previous 10 minutes' low (up) / high (down)."""
    if b is None or up is None or t < 12:
        return float("nan")
    for m in range(t - 2, t + 1):
        if up and b["close"][m] < np.nanmin(b["low"][m - 10 : m]):
            return 1.0
        if not up and b["close"][m] > np.nanmax(b["high"][m - 10 : m]):
            return 1.0
    return 0.0


def broke5(b: dict | None, t: int, up: bool | None) -> float:
    if b is None or up is None:
        return float("nan")
    e = t - ((t - 4) % 5)
    if e < 14:
        return float("nan")
    c, prev = b["close"][e], b["low"][e - 14 : e - 4] if up else b["high"][e - 14 : e - 4]
    return float(c < np.nanmin(prev)) if up else float(c > np.nanmax(prev))


def day_work(task) -> list[dict]:
    period, und, day_s, vix_open, spikes, daily = task
    day = date.fromisoformat(day_s)
    assert_learning_day(und, day)
    root, ref = data_dir(), _ref()
    chain = load_chain_day(root, und, day)
    ro = rolling_straddle(chain)
    start0 = first_priced(ro)
    x = level(ro).x
    eps = {
        i: e for i, e in enumerate(scan_episodes(x, start=start0, rise=RISE[und], decay=DECAY[und]))
    }
    data = load_day(root, und, day)
    own, bank, vix = (
        _bars(root, und, day),
        _bars(root, "BANKNIFTY", day),
        _bars(root, "INDIAVIX", day),
    )
    others = {o: _bars(root, o, day) for o in OTHERS}
    vol, oi, chain_vol = option_arrays(root, und, day, chain.expiry)
    step, rnd, g = chain.step, ROUND[und], GIVE[und]
    lv_fixed = day_levels(daily, day, step)
    oi_max = max_oi_strikes(root, und, day, chain.expiry)
    rows = []
    for idx, held_min, at_held in spikes:
        ep = eps.get(idx)
        if ep is None:
            continue
        start, end = ep.start_min, min(ep.end_min, M_1512)
        atm0 = ro.atm[start]
        far = {"far8_ce": (atm0 + 8 * step, "CE"), "far8_pe": (atm0 - 8 * step, "PE"),
               "round_ce": (math.ceil((atm0 + 8 * step) / rnd) * rnd, "CE"),
               "round_pe": (math.floor((atm0 - 8 * step) / rnd) * rnd, "PE")}  # fmt: skip
        reg2 = regime(vix_open, False)
        cat = category(und, reg2, at_held, CUTS2)
        high, deepest = x[start], 0.0
        for m in range(start, held_min):
            high = max(high, x[m])
            deepest = max(deepest, high - x[m])
        n_high = 0
        for t in range(held_min, end + 1):
            deepest = max(deepest, high - x[t])
            if x[t] <= high:
                continue
            high = x[t]
            n_high += 1
            # labels
            label_a = 0
            for m in range(t + 1, M_1528 + 1):
                if x[m] > x[t]:
                    break
                if x[m] <= x[t] - g:
                    label_a = 1
                    break
            res = simulate_day(wide_strategy(und, minute_label(t + 1), 650.0), data, ref, SIZING)
            label_b = int(classify(res) != "OVERALL_SL")
            s_t, s_0 = chain.spot[t], chain.spot[start]
            up = None if s_t is None or s_0 is None or s_t == s_0 else s_t > s_0
            d1 = [x[m] - x[m - 1] for m in range(t - 5, t + 1)]
            slow = 0
            for i in range(len(d1) - 1, 0, -1):
                if d1[i] < d1[i - 1]:
                    slow += 1
                else:
                    break
            k = ro.atm[t]
            c, p_ = (
                (chain.close.get((k, "CE")) or [None] * N_MINUTES)[t],
                (chain.close.get((k, "PE")) or [None] * N_MINUTES)[t],
            )
            T = max((chain.expiry - day).days + (930 - (555 + t)) / 1440, 1 / 1440) / 365
            iv = (
                (ro.s[t] / (0.8 * (k + c - p_) * math.sqrt(T)))
                if (c and p_ and ro.s[t])
                else float("nan")
            )
            k5 = ro.atm[t - 5]
            c5, p5 = (
                (chain.close.get((k5, "CE")) or [None] * N_MINUTES)[t - 5],
                (chain.close.get((k5, "PE")) or [None] * N_MINUTES)[t - 5],
            )
            T5 = T + 5 / 1440 / 365
            iv5 = (
                (ro.s[t - 5] / (0.8 * (k5 + c5 - p5) * math.sqrt(T5)))
                if (c5 and p5 and ro.s[t - 5])
                else float("nan")
            )
            nb = 0
            for kk in (k - step, k + step):
                a, b_ = chain.close.get((kk, "CE")), chain.close.get((kk, "PE"))
                if (
                    a
                    and b_
                    and None not in (a[t], b_[t], a[t - 3], b_[t - 3])
                    and (a[t] + b_[t]) - (a[t - 3] + b_[t - 3]) >= 0
                ):
                    nb += 1
            row = {"period": period, "underlying": und, "day": day_s, "episode_idx": idx, "t": t,
                   "label_a": label_a, "label_b": label_b, "true_top": int(label_a and label_b),
                   "vel3": (x[t] - x[t - 3]) / 3, "acc3": (x[t] - x[t - 3]) - (x[t - 3] - x[t - 6]),
                   "slowing_minutes": slow, "rise_so_far": x[t] - ep.low_x, "deepest_pullback": deepest,
                   "minutes_since_low": t - start, "n_new_highs": n_high,
                   "brk_own_1m": broke(own, t, up), "brk_own_5m": broke5(own, t, up),
                   "brk_bank_1m": broke(bank, t, up), "brk_vix_1m": broke(vix, t, False) if vix else float("nan"),
                   "iv_change5": (iv / iv5 - 1) * 100 if iv5 and not math.isnan(iv5) else float("nan"),
                   "neighbours_rising": nb, "minute": t, "dte": (chain.expiry - day).days,
                   "vix_open": vix_open, "size_cat": cat}  # fmt: skip
            for name, (kk, ty) in far.items():
                arr = chain.close.get((kk, ty))
                row[f"{name}_chg"] = (
                    _pct(arr[t], arr[start]) if arr and arr[t] and arr[start] else float("nan")
                )
                row[f"{name}_vel3"] = (
                    _pct(arr[t], arr[t - 3]) if arr and arr[t] and arr[t - 3] else float("nan")
                )

            def oi_chg(keys, t=t):
                now = sum(oi[q][t] for q in keys if q in oi)
                before = sum(oi[q][t - 6] for q in keys if q in oi)
                return (
                    _pct(now, before)
                    if len([q for q in keys if q in oi]) == len(keys)
                    else float("nan")
                )

            row["oi_atm_chg6"] = oi_chg([(k, "CE"), (k, "PE")])
            row["oi_far8_chg6"] = oi_chg([far["far8_ce"], far["far8_pe"]])
            base = np.mean(chain_vol[start : t + 1]) if t > start else float("nan")
            row["chain_vol_ratio"] = (
                chain_vol[t - 2 : t + 1].sum() / (3 * base) if base else float("nan")
            )
            av = vol.get((k, "CE"), np.zeros(N_MINUTES)) + vol.get((k, "PE"), np.zeros(N_MINUTES))
            abase = np.mean(av[start : t + 1]) if t > start else float("nan")
            row["atm_vol_ratio"] = av[t - 2 : t + 1].sum() / (3 * abase) if abase else float("nan")
            sign = float("nan") if up is None else (1 if up else -1)
            for o, b in others.items():
                row[f"{o.lower()}_move3"] = (
                    sign * _pct(b["close"][t], b["close"][t - 3]) if b is not None else float("nan")
                )
            lv = dict(lv_fixed)
            if t >= 30:
                lv["orh"], lv["orl"] = (
                    float(np.nanmax(own["high"][:30])),
                    float(np.nanmin(own["low"][:30])),
                )
            if t - 1 in oi_max:
                lv["oic"], lv["oip"] = oi_max[t - 1]
            px = own["close"][t]
            lv["rnd_a"], lv["rnd_b"] = math.ceil(px / rnd) * rnd, math.floor(px / rnd) * rnd
            row["at_level"] = int(any(abs(px / v - 1) <= TOL for v in lv.values() if v))
            rows.append(row)
    return rows


def build(workers: int) -> None:
    s = pd.read_csv(HERE / "out" / "sustained.csv")
    days = (
        pd.read_csv(HERE / "out" / "days.csv")
        .set_index(["period", "underlying", "day"])
        .vix_open.to_dict()
    )
    h = s[s.held_min.notna()]
    tasks = []
    daily = {u: daily_bars(data_dir(), u) for u in h.underlying.unique()}
    for (per, und, day), g in h.groupby(["period", "underlying", "day"]):
        tasks.append((per, und, day, days[(per, und, day)],
                      [(int(r.episode_idx), int(r.held_min), float(r.at_held)) for r in g.itertuples()], daily[und]))  # fmt: skip
    rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for i, r in enumerate(pool.map(day_work, tasks, chunksize=2)):
            rows += r
            if (i + 1) % 50 == 0:
                print(f"  {i + 1}/{len(tasks)} days, {len(rows)} candidates", file=sys.stderr)
    pd.DataFrame(rows).to_csv(OUT, index=False)
    print(f"{len(rows)} candidates on {len(tasks)} index-days")


FEATURES = ["vel3", "acc3", "slowing_minutes", "rise_so_far", "deepest_pullback", "minutes_since_low",
            "n_new_highs", "brk_own_1m", "brk_own_5m", "brk_bank_1m", "brk_vix_1m", "iv_change5",
            "neighbours_rising", "far8_ce_chg", "far8_pe_chg", "far8_ce_vel3", "far8_pe_vel3",
            "round_ce_chg", "round_pe_chg", "round_ce_vel3", "round_pe_vel3", "oi_atm_chg6",
            "oi_far8_chg6", "chain_vol_ratio", "atm_vol_ratio", "banknifty_move3", "finnifty_move3",
            "midcpnifty_move3", "minute", "dte", "vix_open", "at_level"]  # fmt: skip


def auc(v: np.ndarray, y: np.ndarray) -> float:
    ok = ~np.isnan(v)
    v, y = v[ok], y[ok]
    n1, n0 = y.sum(), len(y) - y.sum()
    if n1 < 5 or n0 < 5:
        return float("nan")
    r = pd.Series(v).rank().to_numpy()
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def perm_p(df: pd.DataFrame, f: str, a0: float, n: int = 200, seed: int = 91) -> float:
    """Day-block shuffle: days' label vectors re-assigned in random day order (cyclic fill)."""
    rng = random.Random(seed)
    v = df[f].to_numpy(dtype=float)
    blocks = [g.true_top.to_numpy() for _, g in df.groupby("day", sort=True)]
    hits = 0
    for _ in range(n):
        order = blocks[:]
        rng.shuffle(order)
        lab = np.concatenate(order)
        if abs(auc(v, lab) - 0.5) >= abs(a0 - 0.5):
            hits += 1
    return (hits + 1) / (n + 1)


def analyse() -> None:
    c = pd.read_csv(OUT).sort_values(["day", "t"])
    lines = ["# BL-091 Stage 2: true tops against false tops (P2 + P3)", ""]
    lab = c.groupby(["period", "underlying"]).agg(candidates=("t", "size"), spikes=("episode_idx", lambda s: s.size),
                                                  true_top=("true_top", "mean"), label_a=("label_a", "mean"),
                                                  label_b=("label_b", "mean"))  # fmt: skip
    lines += ["## Candidates and labels", "", lab.round(3).to_markdown(), ""]
    sets = {
        "NIFTY discover 2022–24": c[(c.underlying == "NIFTY") & (c.period == "P3")],
        "NIFTY check 2025": c[(c.underlying == "NIFTY") & (c.period == "P2")],
        "SENSEX discover Jan–Apr 2025": c[(c.underlying == "SENSEX") & (c.day < "2025-05-01")],
        "SENSEX check May–Aug 2025": c[(c.underlying == "SENSEX") & (c.day >= "2025-05-01")],
    }
    res = []
    for f in FEATURES:
        row = {"parameter": f}
        for name, df in sets.items():
            y = df.true_top.to_numpy()
            v = df[f].to_numpy(dtype=float)
            a = auc(v, y)
            row[f"{name} AUC"] = a
            row[f"{name} median true/false"] = (
                f"{np.nanmedian(v[y == 1]):.2f} / {np.nanmedian(v[y == 0]):.2f}" if len(v) else ""
            )
            if "discover" in name:
                row[f"{name} p"] = perm_p(df, f, a) if not math.isnan(a) else float("nan")
        res.append(row)
    r = pd.DataFrame(res)

    def separates(row, d, k):
        a, p, b = row[f"{d} AUC"], row[f"{d} p"], row[f"{k} AUC"]
        if any(math.isnan(z) for z in (a, p, b)):
            return False
        return (
            (a >= 0.6 or a <= 0.4)
            and p < 0.05
            and (b - 0.5) * (a - 0.5) > 0
            and abs(b - 0.5) >= 0.05
        )

    r["NIFTY separates"] = [
        separates(x, "NIFTY discover 2022–24", "NIFTY check 2025") for _, x in r.iterrows()
    ]
    r["SENSEX separates"] = [
        separates(x, "SENSEX discover Jan–Apr 2025", "SENSEX check May–Aug 2025")
        for _, x in r.iterrows()
    ]
    r.to_csv(HERE / "out" / "stage2_auc.csv", index=False)
    show = r[["parameter", "NIFTY discover 2022–24 AUC", "NIFTY discover 2022–24 p", "NIFTY check 2025 AUC",
              "NIFTY discover 2022–24 median true/false", "NIFTY check 2025 median true/false", "NIFTY separates",
              "SENSEX discover Jan–Apr 2025 AUC", "SENSEX discover Jan–Apr 2025 p", "SENSEX check May–Aug 2025 AUC",
              "SENSEX separates"]]  # fmt: skip
    lines += ["## Every parameter: AUC (0.5 = no information), permutation p, medians", "",
              show.round(3).to_markdown(index=False), ""]  # fmt: skip
    lines += [
        f"NIFTY parameters that separate: {', '.join(r[r['NIFTY separates']].parameter) or 'none'}",
        f"SENSEX parameters that separate: {', '.join(r[r['SENSEX separates']].parameter) or 'none'}",
        "",
    ]
    (HERE / "out" / "stage2.md").write_text("\n".join(lines))
    print("\n".join(lines[-3:]))


# --- R1: the rule Stage 2 produces, run through the Stage 1 machinery (registered) -----------------


def youden(v: np.ndarray, y: np.ndarray, higher: bool) -> float:
    best, thr = -1.0, float("nan")
    ok = ~np.isnan(v)
    v, y = v[ok], y[ok]
    for x in np.unique(v):
        k = v >= x if higher else v <= x
        j = (k & (y == 1)).sum() / max((y == 1).sum(), 1) - (k & (y == 0)).sum() / max(
            (y == 0).sum(), 1
        )
        if j > best:
            best, thr = j, float(x)
    return thr


def r1_rule() -> dict:
    """Thresholds from NIFTY 2022–24 only: first parameter, then a second among the kept candidates."""
    c = pd.read_csv(OUT)
    a = pd.read_csv(HERE / "out" / "stage2_auc.csv")
    sep = a[a["NIFTY separates"]].copy()
    sep["dist"] = (sep["NIFTY discover 2022–24 AUC"] - 0.5).abs()
    f1 = sep.sort_values("dist", ascending=False).iloc[0]
    dis = c[(c.underlying == "NIFTY") & (c.period == "P3")]
    chk = c[(c.underlying == "NIFTY") & (c.period == "P2")]
    hi1 = f1["NIFTY discover 2022–24 AUC"] > 0.5
    t1 = youden(dis[f1.parameter].to_numpy(float), dis.true_top.to_numpy(), hi1)
    keep = (lambda df: df[f1.parameter] >= t1) if hi1 else (lambda df: df[f1.parameter] <= t1)
    kd, kc = dis[keep(dis)], chk[keep(chk)]
    rule = {"p1": f1.parameter, "higher1": bool(hi1), "t1": t1, "p2": None}
    best = 0.0
    for g in FEATURES:
        if g == f1.parameter:
            continue
        ad = auc(kd[g].to_numpy(float), kd.true_top.to_numpy())
        ac = auc(kc[g].to_numpy(float), kc.true_top.to_numpy())
        if math.isnan(ad) or math.isnan(ac) or not (ad >= 0.6 or ad <= 0.4):
            continue
        if perm_p(kd, g, ad) >= 0.05 or (ac - 0.5) * (ad - 0.5) <= 0 or abs(ac - 0.5) < 0.05:
            continue
        if abs(ad - 0.5) > best:
            best = abs(ad - 0.5)
            rule.update(p2=g, higher2=bool(ad > 0.5), auc2=ad, auc2_check=ac)
    if rule["p2"]:
        rule["t2"] = youden(kd[rule["p2"]].to_numpy(float), kd.true_top.to_numpy(), rule["higher2"])
    return rule


def fires(df: pd.DataFrame, rule: dict) -> pd.Series:
    k = (df[rule["p1"]] >= rule["t1"]) if rule["higher1"] else (df[rule["p1"]] <= rule["t1"])
    if rule["p2"]:
        k &= (df[rule["p2"]] >= rule["t2"]) if rule["higher2"] else (df[rule["p2"]] <= rule["t2"])
    return k.fillna(False)


def r1_day(task) -> list[dict]:
    und, day_s, events = task  # events: [(key, [fire minutes])]
    from r0 import attempt_row
    from stage1 import summarise

    day = date.fromisoformat(day_s)
    assert_learning_day(und, day)
    root, ref = data_dir(), _ref()
    data = load_day(root, und, day)
    out = []
    for key, ts in events:
        for stop in (650.0, 1300.0, 1950.0):
            rows, i = [], 0
            while i < len(ts) and len(rows) < 5:
                entry = ts[i] + 1
                if entry >= 358:
                    break
                res = simulate_day(wide_strategy(und, minute_label(entry), stop), data, ref, SIZING)
                row = attempt_row(len(rows) + 1, entry, res)
                rows.append(row)
                if row["outcome"] != "OVERALL_SL" or row["exit_min"] is None:
                    break
                i = next((j for j, t in enumerate(ts) if t >= row["exit_min"]), len(ts))
            r = summarise(und, day_s, f"W{int(stop)}_R1", ts[0] + 1 if ts else -1, rows)
            out.append({**r, "key": key})
    return out


def r1(workers: int) -> None:
    from stage1 import PLAN, SIMS, sim_day, tstat

    rule = r1_rule()
    c = pd.read_csv(OUT)
    c = c[c.underlying == "NIFTY"]
    c["fire"] = fires(c, rule)
    plan = pd.read_csv(PLAN)
    ev = plan[(plan.role == "event") & (plan.underlying == "NIFTY")]
    tasks: dict[tuple[str, str], list] = {}
    for r in ev.itertuples(index=False):
        ts = sorted(
            c[
                (c.period == r.period)
                & (c.day == r.event_day)
                & (c.episode_idx == r.episode_idx)
                & c.fire
            ].t.tolist()
        )
        tasks.setdefault((r.underlying, r.event_day), []).append(
            ((r.period, r.event_day, r.episode_idx), ts)
        )
    rows: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for rr in pool.map(r1_day, [(u, d, e) for (u, d), e in tasks.items()], chunksize=2):
            rows += rr
    evr = pd.DataFrame(rows)
    evr[["period", "event_day", "episode_idx"]] = pd.DataFrame(evr.key.tolist(), index=evr.index)
    # comparator: the same stop with R0 from R1's first entry on each event's comparison days
    need = []
    for r in evr[evr.entry_min > 0].itertuples(index=False):
        days = plan[(plan.role == "placebo") & (plan.period == r.period) & (plan.event_day == r.event_day)
                    & (plan.episode_idx == r.episode_idx)].day  # fmt: skip
        need += [("NIFTY", d, r.arm.replace("_R1", "_R0"), int(r.entry_min)) for d in days]
    have = pd.read_csv(SIMS)
    done = set(zip(have.underlying, have.day, have.arm, have.entry_min, strict=True))
    by_day: dict = {}
    for u, d, a, e in set(need) - done:
        by_day.setdefault((u, d), []).append((a, e))
    if by_day:
        import csv as _csv

        from stage1 import SIM_COLUMNS

        with open(SIMS, "a", newline="") as f, ProcessPoolExecutor(max_workers=workers) as pool:
            w = _csv.DictWriter(f, fieldnames=SIM_COLUMNS, extrasaction="ignore")
            for res in pool.map(sim_day, [(u, d, x) for (u, d), x in by_day.items()], chunksize=2):
                w.writerows(res)
    have = pd.read_csv(SIMS)
    have = have[~have.notes.fillna("").str.startswith("ERR")].drop_duplicates(
        ["underlying", "day", "arm", "entry_min"], keep="last"
    )
    have = have.set_index(["underlying", "day", "arm", "entry_min"]).net0
    pl = []
    for r in evr.itertuples(index=False):
        if r.entry_min <= 0:
            pl.append(float("nan"))
            continue
        days = plan[(plan.role == "placebo") & (plan.period == r.period) & (plan.event_day == r.event_day)
                    & (plan.episode_idx == r.episode_idx)].day  # fmt: skip
        vals = [have.get(("NIFTY", d, r.arm.replace("_R1", "_R0"), int(r.entry_min))) for d in days]
        vals = [v for v in vals if v is not None and not (isinstance(v, float) and math.isnan(v))]
        pl.append(float(np.mean(vals)) if vals else float("nan"))
    evr["pl_net0"] = pl
    evr["diff0"] = evr.net0 - evr.pl_net0
    evr = evr.merge(
        ev[["period", "event_day", "episode_idx", "first_of_day", "dte"]],
        on=["period", "event_day", "episode_idx"],
    )
    evr.drop(columns=["key"]).to_csv(HERE / "out" / "stage2_r1_events.csv", index=False)
    s1 = pd.read_csv(HERE / "out" / "stage1_events.csv")
    s1 = s1[(s1.underlying == "NIFTY") & s1.first_of_day]
    res = {"rule": rule, "rows": []}
    prim = evr[evr.first_of_day]
    for (per, arm), g in prim.groupby(["period", "arm"]):
        traded = g[g.entry_min > 0]
        stop = arm.split("_")[0]
        base = {
            x: s1[(s1.period == per) & (s1.arm == f"{stop}_{x}")].net0.mean() for x in ("R0", "R3")
        }
        res["rows"].append({"period": per, "arm": arm, "events": int(len(g)), "traded": int(len(traded)),
                            "mean_all": float(g.net0.mean()), "mean_traded": float(traded.net0.mean()),
                            "placebo": float(traded.pl_net0.mean()), "diff": float(traded.diff0.mean()),
                            "t": float(tstat(traded.diff0)), "held": float(traded.held.mean()),
                            "attempts": float(traded.attempts.mean()), "worst": float(g.net0.min()),
                            "mean20_all": float(g.net20.mean()), "r0_mean": float(base["R0"]),
                            "r3_mean": float(base["R3"])})  # fmt: skip
    (HERE / "out" / "stage2_r1.json").write_text(json.dumps(res, default=float, indent=1))
    print(json.dumps(res, default=float, indent=1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["build", "analyse", "r1"])
    ap.add_argument("--workers", type=int, default=7)
    a = ap.parse_args()
    if a.step == "build":
        build(a.workers)
    elif a.step == "r1":
        r1(a.workers)
    else:
        analyse()
    return 0


if __name__ == "__main__":
    sys.exit(main())
