"""BL-214 follow-up (owner, 2026-11-07): a hybrid book. On Wednesdays and on SENSEX-expiry days the books trade
SENSEX (T1 and Core ranked among the SENSEX variants only; the fixed base becomes 2 x S_wide_0917 + a SENSEX copy
of the base Dir ATM 09:24); on every other day they trade NIFTY only (as score.py: the NIFTY variants, no SENSEX
expiry rule). Read-only on the live rotation store; the SENSEX Dir leg is simulated here, in memory.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl214/hybrid.py \
        --from 2025-01-01 --to 2026-11-06 [--json out.json]

Exploratory, NOT pre-registered: the day rule was the owner's idea after seeing the NIFTY-only results.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import score  # noqa: E402 - the registered scorer's helpers (stats, series, episodes)
from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation import base, daylog, expiry, pick, sl150_cap, slip_store, store  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.readout import (  # noqa: E402
    MIN_WIDE_N,
    block_bootstrap_mean,
    random_day,
)
from option_backtesting.rotation.variants import is_buy, is_wide, track_names, variant_names  # noqa: E402

ROOT = Path(os.environ["TRADING_DATA_ROOT"])
S_BASE_YAML = Path(__file__).parent / "sensex_base_dir_atm_0924.yaml"


def picks_for(names, start, end, only_days, *, index):
    """List C core picks per day. index 'N': as score.book_picks on a NIFTY-only universe (the SENSEX expiry label
    is hidden, so the rule is vacuous exactly as in the 2021-2026 comparator). index 'S': SENSEX-only universe,
    real labels, no expiry filter (a SENSEX-only universe is its own filter) and no SL150 cap (a NIFTY variant)."""
    daylog._recon_cache.clear()  # noqa: SLF001
    rec = daylog.reconstruction(ROOT, names)
    assert rec.error is None, rec.error
    out = {}
    for d in rec.days_available():
        if d < start or d > end or (only_days is not None and d not in only_days):
            continue
        a = rec.attrs[d]
        dte_s = "unknown" if index == "N" else a["dte_s"]  # "L": both indices ranked together, as live
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        vix = daylog._number(a.get("vix_open"))  # noqa: SLF001
        for key, cols, comp, picks in pick._rank(hist, d, vix, {"dte_n": a["dte_n"], "dte_s": dte_s}):  # noqa: SLF001
            if key != "C":
                continue
            if index in ("N", "L"):
                idx = expiry.expiring_index(a["dte_n"], dte_s)
                if idx:
                    picks = expiry.filter_picks(comp, cols, picks, idx)
                elif expiry._known(str(a["dte_n"])) and str(a["dte_n"]) != "0":  # noqa: SLF001
                    picks = sl150_cap.cap_picks(comp, cols, picks)
            out[d] = list(picks.core)
    return out


def sensex_dir(days):
    """{slip: {day: (net, gross)}} for the SENSEX copy of the base Dir leg, simulated here."""
    spec = load_legwise(S_BASE_YAML)
    reference, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    out = {0: {}, 0.5: {}}
    for d in days:
        try:
            data = load_day(ROOT, "SENSEX", d)
            r = simulate_day(spec, data, reference, sizing)
        except Exception as error:  # noqa: BLE001 - counted, never zero-filled
            print(f"S Dir {d}: {type(error).__name__}: {error}", file=sys.stderr)
            continue
        row = {"day": d.isoformat(), "net": round(r.gross - r.costs, 2), "gross": round(r.gross, 2),
               "costs": round(r.costs, 2), "worst_mtm": round(r.worst_mtm, 2),
               "stopped_by": r.stopped_by or "", "n_trades": len(r.trades)}  # fmt: skip
        s = slip_store.slipped_row(row, spec, data, 0.5)
        out[0][d] = (float(row["net"]), float(row["gross"]))
        out[0.5][d] = (float(s["net"]), float(s["gross"]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    attrs = store.read_days(ROOT)
    sday = {d for d, r in attrs.items() if start <= d <= end and (d.weekday() == 2 or str(r["dte_s"]) == "0")}
    core_n = [n for n in variant_names() if n.startswith("N_")]
    t1_n = [*core_n, *[n for n in track_names("t1") if n.startswith("N_")]]
    core_s = [n for n in variant_names() if n.startswith("S_")]
    t1_s = [*core_s, *[n for n in track_names("t1") if n.startswith("S_")]]
    P = {
        "core_N": picks_for(core_n, start, end, None, index="N"),
        "t1_N": picks_for(t1_n, start, end, None, index="N"),
        "core_S": picks_for(core_s, start, end, None, index="S"),
        "t1_S": picks_for(t1_s, start, end, None, index="S"),
        "core_L": picks_for([*core_n, *core_s], start, end, None, index="L"),
        "t1_L": picks_for([*t1_n, *t1_s], start, end, None, index="L"),
    }
    days = sorted(set.intersection(*[set(v) for v in P.values()]))
    print(f"ranked on all four universes: {len(days)} days, {days[0]} -> {days[-1]}", flush=True)
    sd = sensex_dir(days)
    nets = {s: score.series([*t1_n, *t1_s], s) for s in (0, 0.5)}
    gross = score.gross_of([*t1_n, *t1_s])
    n_dir = {s: base.read_column(store.slip_path(base._path(ROOT), 0.5) if s else base._path(ROOT), "net")  # noqa: SLF001
             for s in (0, 0.5)}
    n_dir_g = base.read_column(base._path(ROOT), "gross")  # noqa: SLF001
    rows = []
    left = []
    for d in days:
        r = {"day": d, "s_day": d in sday, "wed": d.weekday() == 2, "dte_n": str(attrs[d]["dte_n"]), "dte_s": str(attrs[d]["dte_s"])}
        try:
            for key in P:
                for s in (0, 0.5):
                    r[f"{key}_{s}"] = sum(nets[s][x][d] for x in P[key][d])
                r[f"{key}_gross"] = sum(gross[x][d] for x in P[key][d])
            for s in (0, 0.5):
                r[f"base_N_{s}"] = 2 * nets[s]["N_wide_0917"][d] + n_dir[s][d]
                r[f"base_S_{s}"] = 2 * nets[s]["S_wide_0917"][d] + sd[s][d][0]
            r["base_N_gross"] = 2 * gross["N_wide_0917"][d] + n_dir_g[d]
            r["base_S_gross"] = 2 * gross["S_wide_0917"][d] + sd[0][d][1]
        except KeyError as error:
            left.append(f"{d}: {error}")
            continue
        # random same-shape baskets from the day's pool of the index the hybrid trades that day
        pools = {}
        for ix, names_ in (("N", t1_n), ("S", t1_s)):
            nm = [x for x in names_ if d in gross[x] and not is_buy(x)]
            pools[ix] = (np.array([gross[x][d] for x in nm]), np.array([is_wide(x) for x in nm]))
        try:
            for ix in ("N", "S"):
                r[f"rand_{ix}"] = random_day(d, pools[ix][0], pools[ix][1], np.zeros(0), runs=score.RUNS, min_wide=MIN_WIDE_N)[0]
        except ValueError as error:
            left.append(f"{d}: {error}")
            continue
        rows.append(r)
    print(f"scored {len(rows)} days; left out {len(left)}: {left[:3]}", flush=True)
    col = lambda k: np.array([r[k] for r in rows])  # noqa: E731
    sflag = np.array([r["s_day"] for r in rows])
    D = [r["day"] for r in rows]

    def hyb(book: str, s) -> np.ndarray:  # book: core | t1 | base
        n, sx = (col(f"{book}_N_{s}"), col(f"{book}_S_{s}")) if book != "base" else (col(f"base_N_{s}"), col(f"base_S_{s}"))
        if book != "base":
            n, sx = col(f"{book}_N_{s}"), col(f"{book}_S_{s}")
        return np.where(sflag, sx, n)

    def book(kind: str, b: str, s) -> np.ndarray:
        if b == "base":
            return {"nifty": col(f"base_N_{s}"), "sensex": col(f"base_S_{s}"), "hybrid": hyb("base", s)}[kind]
        return {"nifty": col(f"{b}_N_{s}"), "sensex": col(f"{b}_S_{s}"), "hybrid": hyb(b, s),
                "live": col(f"{b}_L_{s}") if f"{b}_L_{s}" in rows[0] else None}[kind]

    segs = {"all": (start, end), "2025": (date(2025, 1, 1), date(2025, 12, 31)), "2026": (date(2026, 1, 1), end),
            "after_tuning": (date(2025, 10, 9), end)}  # fmt: skip
    report: dict = {"from": a.start, "to": a.end, "scored_days": len(rows), "s_days": int(sflag.sum()),
                    "s_days_wed": int(sum(r["s_day"] and r["wed"] for r in rows)),
                    "s_days_expiry": int(sum(r["s_day"] and not r["wed"] for r in rows)), "left_out": left[:20],
                    "segments": {}}  # fmt: skip
    for sname, (lo, hi) in segs.items():
        ix = np.array([i for i, d in enumerate(D) if lo <= d <= hi])
        if not len(ix):
            continue
        seg = {"days": int(len(ix)), "s_days": int(sflag[ix].sum()), "books": {}, "gaps": {}, "on_s_days": {}, "on_n_days": {}, "on_wed": {}, "on_sexpiry": {}}
        for kind in ("nifty", "sensex", "hybrid", "live"):
            for b in ("core", "t1", "base"):
                if kind == "live" and b == "base":
                    continue
                seg["books"][f"{kind}_{b}"] = score.stats(book(kind, b, 0.5)[ix])
        for x, y in (("hybrid_t1", "hybrid_base"), ("hybrid_t1", "nifty_t1"), ("hybrid_base", "nifty_base"),
                     ("hybrid_t1", "nifty_base"), ("hybrid_core", "hybrid_base"), ("nifty_t1", "nifty_base"),
                     ("sensex_t1", "sensex_base"), ("hybrid_t1", "live_t1"), ("live_t1", "nifty_t1"),
                     ("hybrid_core", "live_core"), ("live_t1", "nifty_base")):  # fmt: skip
            def pick_(name):
                kind, b = name.split("_")
                return book(kind, b, 0.5)
            diff = (pick_(x) - pick_(y))[ix] / 3.0
            m, lo_, hi_ = block_bootstrap_mean(diff, score.RESAMPLES, score.BLOCK, score.SEED)
            srt = np.sort(diff)[::-1]
            seg["gaps"][f"{x}_minus_{y}"] = {"mean_per_lot_day": m, "lo90": lo_, "hi90": hi_,
                                             "ahead": float((diff > 0).mean()),
                                             "without_best5": float(srt[5:].mean()) if len(srt) > 10 else None}  # fmt: skip
        sx_ix = np.array([i for i in ix if sflag[i]])
        nx_ix = np.array([i for i in ix if not sflag[i]])
        wed_ix = np.array([i for i in sx_ix if rows[i]["wed"]])
        se_ix = np.array([i for i in sx_ix if not rows[i]["wed"]])
        for tag, jx, dest in (("s", sx_ix, "on_s_days"), ("n", nx_ix, "on_n_days"), ("w", wed_ix, "on_wed"), ("e", se_ix, "on_sexpiry")):
            if not len(jx):
                continue
            for kind in ("nifty", "sensex", "live"):
                for b in ("core", "t1", "base"):
                    if kind == "live" and b == "base":
                        continue
                    x = book(kind, b, 0.5)[jx]
                    seg[dest][f"{kind}_{b}"] = {"days": len(jx), "per_lot_day": float(x.mean() / 3.0), "total": float(x.sum()),
                                                "win": float((x > 0).mean())}  # fmt: skip
        # random baskets: the hybrid's own pool each day, 'k' draws summed over the window
        for b in ("core", "t1", "base"):
            rr = np.stack([r[f"rand_{'S' if r['s_day'] else 'N'}"] for r in (rows[i] for i in ix)]).sum(axis=0)
            gk = {"core": "core", "t1": "t1", "base": "base"}[b]
            gtot = float(sum((rows[i][f"{gk}_S_gross"] if rows[i]["s_day"] else rows[i][f"{gk}_N_gross"]) if gk != "base"
                             else (rows[i]["base_S_gross"] if rows[i]["s_day"] else rows[i]["base_N_gross"]) for i in ix))
            seg["books"][f"hybrid_{b}"]["beats_random_pct"] = float((rr < gtot).mean() * 100)
        report["segments"][sname] = seg
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=1, default=str) + "\n")
    print(json.dumps({k: report[k] for k in ("scored_days", "s_days", "s_days_wed", "s_days_expiry")}))


if __name__ == "__main__":
    main()
