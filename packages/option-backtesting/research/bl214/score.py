"""BL-214 Phase 4: score Core Adaptive and Adaptive Tuned (T1), NIFTY-only, against the fixed base and random
baskets, from the results `backfill.py` wrote into the _bl214 root. Registered in backlog/BL-214 Phase 0.

    TRADING_DATA_ROOT=/Volumes/TradingData/_bl214 uv run python research/bl214/score.py \
        --from 2021-11-01 --to 2024-10-08 [--label old] [--json out.json]

List C's core picks are re-derived day by day from earlier rows only (`pick._rank`, the function the 09:16
job calls), with the SL150% cap on a day NIFTY does not expire (the expiry-only rule is vacuous: no SENSEX
variants, `dte_s` unknown), one lot a strategy, Buy left out, as BL-207. Reads the root, writes the JSON asked."""

from __future__ import annotations

import argparse
import json
import os
import sys
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.rotation import base, daylog, expiry, pick, sl150_cap, store
from option_backtesting.rotation.readout import (
    MIN_WIDE_N,
    block_bootstrap_mean,
    max_drawdown,
    random_day,
)
from option_backtesting.rotation.variants import is_buy, is_wide, track_names, variant_names

sys.path.insert(0, str(Path(__file__).parent))
from backfill import _patch_loader  # noqa: E402 - the same lot-size fallback for the base's Dir leg

ROOT = Path(os.environ["TRADING_DATA_ROOT"])
SEED, RESAMPLES, BLOCK = 20261106, 2000, 5
RUNS = 1000
CAPITAL = 1_700_000.0
IN_SAMPLE_GAP = 254.0  # BL-213: Tuned minus the fixed base, per lot-day, two years, the Books table
NOW_DD = 29_546.0  # T1's paper drawdown on 6 Nov 2026 (net, 0.5% slippage, one lot a strategy)
DEEPEST_DD = 32_386.0  # its deepest in the stored 442 days (5 Oct 2026)


def book_picks(names: list[str], start: date, end: date) -> dict[date, list[str]]:
    daylog._recon_cache.clear()  # noqa: SLF001
    rec = daylog.reconstruction(ROOT, names)
    assert rec.error is None, rec.error
    out: dict[date, list[str]] = {}
    for d in rec.days_available():
        if d < start or d > end:
            continue
        a = rec.attrs[d]
        labels = (str(a["dte_n"]), str(a["dte_s"]))
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        vix = daylog._number(a.get("vix_open"))  # noqa: SLF001
        for key, cols, comp, picks in pick._rank(  # noqa: SLF001
            hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        ):
            if key != "C":
                continue
            idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(labels[0]) and labels[0] != "0":  # noqa: SLF001
                picks = sl150_cap.cap_picks(comp, cols, picks)
            out[d] = list(picks.core)
    return out


def series(names: list[str], slip: float) -> dict[str, dict[date, float]]:
    with store.slipped(slip):
        return {m: store.read_net(m, ROOT) for m in names}


def gross_of(names: list[str]) -> dict[str, dict[date, float]]:
    return {m: base.read_column(store.result_path(m, ROOT), "gross") for m in names}


def stats(x: np.ndarray, lots: float = 3.0) -> dict:
    if not len(x):
        return {}
    wins, losses = x[x > 0], x[x < 0]
    return {
        "days": len(x), "net_per_day": float(x.mean()), "per_lot_day": float(x.mean() / lots),
        "win": float((x > 0).mean()), "worst_day": float(x.min()), "best_day": float(x.max()),
        "max_dd": max_drawdown(x), "profit_factor": float(wins.sum() / -losses.sum()) if len(losses) else None,
        "avg_win": float(wins.mean()) if len(wins) else None, "avg_loss": float(losses.mean()) if len(losses) else None,
        "median": float(np.median(x)), "total": float(x.sum()),
    }  # fmt: skip


def episodes(days: list[date], x: np.ndarray, min_depth: float) -> list[dict]:
    """Drawdown episodes (peak to recovery, or the last day when open) at least `min_depth` deep."""
    eq = np.cumsum(x)
    peak = np.maximum.accumulate(np.maximum(eq, 0.0))
    dd = peak - eq
    out, i, n = [], 0, len(x)
    while i < n:
        if dd[i] > 0:
            s = i
            while i < n and dd[i] > 0:
                i += 1
            e = i - 1
            depth = float(dd[s : e + 1].max())
            if depth >= min_depth:
                t = s + int(np.argmax(dd[s : e + 1]))
                out.append({"start": days[s].isoformat(), "trough": days[t].isoformat(),
                            "end": days[e].isoformat(), "recovered": bool(i < n or dd[-1] == 0),
                            "depth": depth, "sessions": e - s + 1, "to_trough": t - s + 1})  # fmt: skip
        else:
            i += 1
    return out


def ladder(dd: np.ndarray) -> dict:
    s = np.sort(dd)[::-1]
    return {f"{p}%": float(s[max(0, int(np.ceil(len(s) * p / 100)) - 1)]) for p in (25, 10, 5, 1)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--label", default="old")
    ap.add_argument("--json")
    a = ap.parse_args()
    _patch_loader()
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    core_n = [n for n in variant_names() if n.startswith("N_")]
    t1_n = [*core_n, *[n for n in track_names("t1") if n.startswith("N_")]]
    picks = {"core": book_picks(core_n, start, end), "t1": book_picks(t1_n, start, end)}
    days = sorted(set(picks["core"]) & set(picks["t1"]))
    # the base's Dir leg on every scored day, into the root's own base folder
    got = base.score_days(days, ROOT, log=lambda _m: None)
    if got["skipped"]:
        print("base Dir leg skipped:", len(got["skipped"]), got["skipped"][:2])
    nets = {s: series(t1_n, s) for s in (0, 0.5)}
    gross = gross_of(t1_n)
    dir_net = {
        s: base.read_column(
            store.slip_path(base._path(ROOT), 0.5) if s else base._path(ROOT), "net"
        )
        for s in (0, 0.5)
    }  # noqa: SLF001
    dir_gross = base.read_column(base._path(ROOT), "gross")  # noqa: SLF001
    attrs = store.read_days(ROOT)
    left = {"no_result": [], "no_base": []}
    rows = []
    for d in days:
        row = {"day": d, "dte_n": str(attrs[d]["dte_n"])}
        ok = True
        for b in ("core", "t1"):
            m = picks[b][d]
            if any(d not in nets[0][x] or d not in nets[0.5][x] for x in m):
                ok = False
                left["no_result"].append(f"{d} {b}")
                break
            for s in (0, 0.5):
                row[f"{b}_{s}"] = sum(nets[s][x][d] for x in m)
            row[f"{b}_gross"] = sum(gross[x][d] for x in m)
        if not ok:
            continue
        if (
            d not in dir_net[0]
            or d not in dir_net[0.5]
            or d not in nets[0]["N_wide_0917"]
            or d not in nets[0.5]["N_wide_0917"]
        ):
            left["no_base"].append(str(d))
            continue
        for s in (0, 0.5):
            row[f"base_{s}"] = 2 * nets[s]["N_wide_0917"][d] + dir_net[s][d]
        row["base_gross"] = 2 * gross["N_wide_0917"][d] + dir_gross[d]
        # random same-shape baskets from this day's NIFTY pool (gross, as the registered read-out)
        avail = [x for x in t1_n if d in gross[x]]
        pool_names = [x for x in avail if not is_buy(x)]
        pool = np.array([gross[x][d] for x in pool_names])
        wide = np.array([is_wide(x) for x in pool_names])
        core_r, _buy = random_day(d, pool, wide, np.zeros(0), runs=RUNS, min_wide=MIN_WIDE_N)
        row["random"] = core_r
        rows.append(row)
    D = [r["day"] for r in rows]
    col = lambda k: np.array([r[k] for r in rows])  # noqa: E731
    rand = np.array([r["random"] for r in rows])
    segments = {
        "all": (start, end),
        "A_2021-11_to_2022-03": (start, date(2022, 3, 31)),
        "B_2022-04_to_2024-10": (date(2022, 4, 1), end),
        **{str(y): (date(y, 1, 1), date(y, 12, 31)) for y in range(start.year, end.year + 1)},
    }
    report: dict = {"label": a.label, "from": a.start, "to": a.end, "scored_days": len(rows),
                    "left_out": {k: v[:20] for k, v in left.items()}, "left_out_counts": {k: len(v) for k, v in left.items()},
                    "segments": {}}  # fmt: skip
    for sname, (lo, hi) in segments.items():
        ix = np.array([i for i, d in enumerate(D) if lo <= d <= hi])
        if not len(ix):
            continue
        seg: dict = {
            "days": int(len(ix)),
            "from": D[ix[0]].isoformat(),
            "to": D[ix[-1]].isoformat(),
            "books": {},
            "gaps": {},
        }
        for s in (0, 0.5):
            for b in ("core", "t1", "base"):
                seg["books"].setdefault(b, {})[f"net_{s}"] = stats(col(f"{b}_{s}")[ix])
            for x, y in (("t1", "base"), ("core", "base"), ("t1", "core")):
                diff = (col(f"{x}_{s}") - col(f"{y}_{s}"))[ix] / 3.0
                m, lo_, hi_ = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED)
                srt = np.sort(diff)[::-1]
                seg["gaps"].setdefault(f"{x}_minus_{y}", {})[f"net_{s}"] = {
                    "mean_per_lot_day": m, "lo90": lo_, "hi90": hi_, "better_days": float((diff > 0).mean()),
                    "mean_without_best5": float(srt[5:].mean()) if len(srt) > 10 else None,
                    "mean_without_best10": float(srt[10:].mean()) if len(srt) > 20 else None,
                }  # fmt: skip
        for b in ("core", "t1", "base"):
            r = rand[ix].sum(axis=0)
            tot = float(col(f"{b}_gross")[ix].sum())
            seg["books"][b]["gross_total"] = tot
            seg["books"][b]["beats_random_pct"] = float((r < tot).mean() * 100)
            seg["books"][b]["random_median"] = float(np.median(r))
        report["segments"][sname] = seg
    # drawdown placement, T1 (net, 0.5% slippage, the series today's -29.5k is quoted on)
    t1x = col("t1_0.5")
    eq = np.cumsum(t1x)
    dd = np.maximum.accumulate(np.maximum(eq, 0.0)) - eq
    report["t1_drawdown"] = {"ladder": ladder(dd), "deepest": float(dd.max()),
                             "deepest_day": D[int(dd.argmax())].isoformat(),
                             "share_ge_now": float((dd >= NOW_DD).mean()), "share_ge_deepest": float((dd >= DEEPEST_DD).mean()),
                             "share_under_water": float((dd > 0).mean()),
                             "episodes_ge_15k": episodes(D, t1x, 15_000)}  # fmt: skip
    for b in ("core", "base"):
        xb = col(f"{b}_0.5")
        e2 = np.cumsum(xb)
        d2 = np.maximum.accumulate(np.maximum(e2, 0.0)) - e2
        report[f"{b}_drawdown"] = {
            "ladder": ladder(d2),
            "deepest": float(d2.max()),
            "episodes_ge_15k": episodes(D, xb, 15_000),
        }
    # stages: T1's three deepest episodes, with the base and the random baskets over the same days
    stages = []
    for ep in sorted(report["t1_drawdown"]["episodes_ge_15k"], key=lambda e: -e["depth"])[:3]:
        s_i, t_i = (
            D.index(date.fromisoformat(ep["start"])),
            D.index(date.fromisoformat(ep["trough"])),
        )
        pk = max(0, s_i - 1)
        w = list(range(max(0, pk - 9), pk + 1))
        dr = list(range(pk + 1, t_i + 1))

        def part(ix):
            if not ix:
                return None
            return {"from": D[ix[0]].isoformat(), "to": D[ix[-1]].isoformat(), "days": len(ix),
                    **{b: {"gross": float(col(f"{b}_gross")[ix].sum()),
                           "beats_random_pct": float((rand[ix].sum(axis=0) < col(f"{b}_gross")[ix].sum()).mean() * 100)} for b in ("t1", "core", "base")}}  # fmt: skip

        stages.append(
            {"episode": ep, "ten_sessions_before_the_high": part(w), "peak_to_trough": part(dr)}
        )
    report["t1_worst_stages"] = stages
    # NIFTY-expiry days and the three combinations
    nx = np.array([r["dte_n"] == "0" for r in rows])
    combos = {}
    for tag, mask in (
        ("all_days", np.ones(len(rows), bool)),
        ("nifty_expiry", nx),
        ("other_days", ~nx),
    ):
        for s in (0, 0.5):
            c, t = col(f"core_{s}")[mask], col(f"t1_{s}")[mask]
            if not len(c):
                continue
            for name, x in (("2xT1", 2 * t), ("2xCore", 2 * c), ("Core+T1", c + t)):
                st = stats(x, 6.0)
                st["return_on_17L"] = float(x.sum() / CAPITAL)
                st["corr_core_t1"] = float(np.corrcoef(c, t)[0, 1]) if len(c) > 2 else None
                combos.setdefault(tag, {}).setdefault(f"slip_{s}", {})[name] = st
    report["combos"] = combos
    # strike coverage: share of N variant-days with no trade, by year
    cover: dict = {}
    for n in t1_n:
        p = store.result_path(n, ROOT)
        if not p.exists():
            continue
        import csv

        with p.open() as f:
            for r in csv.DictReader(f):
                dday = date.fromisoformat(r["day"])
                if start <= dday <= end:
                    y = str(dday.year)
                    c = cover.setdefault(y, [0, 0])
                    c[0] += 1
                    c[1] += int(r["n_trades"]) == 0
    report["no_trade_share_by_year"] = {y: v[1] / v[0] for y, v in sorted(cover.items())}
    report["variant_days_by_year"] = {y: v[0] for y, v in sorted(cover.items())}
    # the registered pass / kill reading on T1 minus base, after 0.5% slippage, all scored days
    g = report["segments"]["all"]["gaps"]["t1_minus_base"]["net_0.5"]
    verdict = ("pass" if g["lo90"] > 0 and g["mean_per_lot_day"] >= IN_SAMPLE_GAP / 2
               else "kill" if g["lo90"] <= 0 <= g["hi90"] and g["mean_per_lot_day"] < IN_SAMPLE_GAP / 4 else "no evidence either way")  # fmt: skip
    report["registered_reading"] = {
        "gap_t1_minus_base_net_0.5": g,
        "in_sample_gap": IN_SAMPLE_GAP,
        "verdict": verdict,
    }
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=1, default=str) + "\n")
    print(
        json.dumps(
            {k: report[k] for k in ("scored_days", "left_out_counts", "registered_reading")},
            indent=1,
            default=str,
        )
    )


if __name__ == "__main__":
    main()
