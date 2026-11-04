"""BL-208: T1's book stop with the owner's 3:2 trail and a break-even lock after +5k, on the Dir x2
and 3-lot books, against today's stop. As registered in backlog/BL-208 Phase 0 (descriptive,
in-sample). Same reconstruction and replay as research/bl194; writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl208/book_trail.py
"""

from __future__ import annotations

import csv
import json
import math
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import minute_label
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import daylog, expiry, live_lots, pick, portfolio, sl150_cap, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261104, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
FIRST = date(2025, 1, 10)
LAST_YEAR_FROM = date(2025, 11, 4)
PROMPT_DAY = "2026-11-04"
BOOKS = ("dir2", "three")


def _trail(best: float, x: float, y: float) -> float:
    return y * math.floor(best / x)


def _lock(best: float, a: float, b: float) -> float:
    return b if best >= a else -math.inf


# level for the minute from (base stop S, best so far); everything closes at the first minute <= it
ARMS = {
    "base": lambda s, b: -s,
    "trail_3_2": lambda s, b: -s + _trail(b, 3, 2),
    "trail_3_2_stepped": lambda s, b: -s + _trail(b, 3000, 2000),
    "lock_5k_0": lambda s, b: max(-s, _lock(b, 5000, 0)),
    "both": lambda s, b: max(-s + _trail(b, 3, 2), _lock(b, 5000, 0)),
    "n_trail_1_1": lambda s, b: -s + _trail(b, 1, 1),
    "n_trail_3_1": lambda s, b: -s + _trail(b, 3, 1),
    "n_lock_3k_0": lambda s, b: max(-s, _lock(b, 3000, 0)),
    "n_lock_8k_0": lambda s, b: max(-s, _lock(b, 8000, 0)),
    "n_lock_5k_2500": lambda s, b: max(-s, _lock(b, 5000, 2500)),
}
OWNER = ("trail_3_2", "trail_3_2_stepped", "lock_5k_0", "both")
# arms apply_book can replay itself, for the cross-check
CHECK = {
    "base": None,
    "trail_3_2": portfolio.Trail("sl", x=3, y=2),
    "trail_3_2_stepped": portfolio.Trail("sl", x=3000, y=2000),
    "lock_5k_0": portfolio.Trail("lock", a=5000, b=0),
    "n_lock_5k_2500": portfolio.Trail("lock", a=5000, b=2500),
}


def replay(combined: list[float], s: float, level) -> tuple[float, int | None]:
    best = 0.0
    for i, v in enumerate(combined):
        best = max(best, v)
        if v <= level(s, best):
            return v, i
    return combined[-1], None


def read(name: str, root: Path) -> dict[date, int]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                out[date.fromisoformat(r["day"])] = (
                    int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else 0
                )
            except (KeyError, ValueError):
                continue
    return out


def mtmsl(name: str) -> float:
    v = load_legwise(portfolio.strategy_file(name)).overall.stop_loss_inr
    return float(v) if v is not None else NO_MTMSL_ADD


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {"mean": m, "ci90": [lo, hi],
            "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero"}  # fmt: skip


def run(root: Path) -> tuple[dict[str, dict], list[str], int]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, [*variant_names(), *track_names("t1")])
    assert rec.error is None, rec.error
    trades: dict[str, dict[date, int]] = {}
    rows: dict[str, dict] = {}
    skipped: list[str] = []
    checks = 0
    for d in rec.days_available():
        if d < FIRST:
            continue
        a = rec.attrs[d]
        labels = (str(a["dte_n"]), str(a["dte_s"]))
        dte = {"NIFTY": labels[0], "SENSEX": labels[1]}
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        vix = daylog._number(a.get("vix_open"))
        for key, cols, comp, picks in pick._rank(
            hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        ):
            if key != "C":
                continue
            idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(labels[0]) and labels[0] != "0":
                picks = sl150_cap.cap_picks(comp, cols, picks)
            core = list(picks.core)
            lots2 = live_lots.lots_for_day(core, dte)
            four = live_lots.boosted(lots2)
            doubled = next((m for m, n in lots2.items() if n > 1), None)
            try:
                loaded: dict = {}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in core}
                for m in core:
                    if m not in trades:
                        trades[m] = read(m, root)
                if any(d not in trades[m] for m in core):
                    raise portfolio.PortfolioStopError("a stored result is missing")
            except (portfolio.PortfolioStopError, FileNotFoundError) as e:
                skipped.append(f"{d}: {e}")
                continue
            row = {"day": d.isoformat(), "picks": core, "books": {}}
            for book in BOOKS:
                if book == "dir2":
                    lots = lots2
                    s = BASE_STOP + mtmsl(doubled) if four else BASE_STOP
                else:
                    lots = dict.fromkeys(core, 1)
                    s = BASE_STOP
                members = [portfolio.Member(m, n, paths[m]) for m, n in lots.items()]
                brokerage = sum(2 * trades[m][d] * BROKERAGE for m in core)  # per order, as BL-194
                combined = portfolio.apply_book(members, None).combined
                arms = {}
                for name, level in ARMS.items():
                    g, minute = replay(combined, s, level)
                    arms[name] = {"net": g - brokerage, "minute": minute}
                    if name in CHECK:
                        bd = portfolio.apply_book(members, s, CHECK[name])
                        assert abs(bd.gross_with - g) < 1e-6 and bd.stop_minute == minute, (
                            d,
                            book,
                            name,
                        )
                        checks += 1
                base_min = arms["base"]["minute"]
                end = len(combined) if base_min is None else base_min + 1
                row["books"][book] = {
                    "stop": s, "four_lot": four if book == "dir2" else False,
                    "high": float(max(max(combined[:end]), 0.0)), "low": float(min(min(combined[:end]), 0.0)),
                    "arms": arms,
                }  # fmt: skip
            rows[d.isoformat()] = row
    return rows, skipped, checks


def metrics(net: np.ndarray) -> dict:
    k = max(1, int(round(len(net) * 0.05)))
    return {"per_day": float(net.mean()), "total": float(net.sum()), "max_drawdown": max_drawdown(net),
            "worst_day": float(net.min()), "worst_5pct_mean": float(np.sort(net)[:k].mean())}  # fmt: skip


def summarise(rows: dict[str, dict]) -> dict:
    out = {}
    newest = max(rows)
    windows = (("all", FIRST, False), ("all_without_prompt_day", FIRST, True),
               ("last_year", LAST_YEAR_FROM, False), ("last_year_without_prompt_day", LAST_YEAR_FROM, True))  # fmt: skip
    for book in BOOKS:
        out[book] = {}
        for wname, lo, drop in windows:
            sub = [r["books"][book] for k, r in sorted(rows.items())
                   if k >= lo.isoformat() and not (drop and k == PROMPT_DAY)]  # fmt: skip
            base = np.array([r["arms"]["base"]["net"] for r in sub])
            ctx = {}
            for t in (3000, 5000, 8000):
                hit = [(r, f) for r, f in zip(sub, base, strict=True) if r["high"] >= t]
                ctx[f"reach_{t}"] = {"days": len(hit), "share": len(hit) / len(sub),
                                     "end_below_0": sum(f < 0 for _, f in hit),
                                     "end_below_-5000": sum(f < -5000 for _, f in hit)}  # fmt: skip
            w: dict = {"from": lo.isoformat(), "to": newest, "days": len(sub),
                       "four_lot_days": sum(r["four_lot"] for r in sub), "context": ctx}  # fmt: skip
            for a in ARMS:
                net = np.array([r["arms"][a]["net"] for r in sub])
                e = metrics(net)
                if a != "base":
                    e["vs_base"] = interval(net - base)
                    early = [
                        r["arms"][a]["net"] - r["arms"]["base"]["net"]
                        for r in sub
                        if r["arms"][a]["minute"] is not None
                        and (r["arms"]["base"]["minute"] is None or r["arms"][a]["minute"] < r["arms"]["base"]["minute"])
                    ]  # fmt: skip
                    e["fired_early_days"] = len(early)
                    e["given_up"] = {
                        "days": sum(x < 0 for x in early),
                        "sum": float(sum(x for x in early if x < 0)),
                    }
                    e["saved"] = {
                        "days": sum(x > 0 for x in early),
                        "sum": float(sum(x for x in early if x > 0)),
                    }
                else:
                    e["fired_days"] = sum(r["arms"][a]["minute"] is not None for r in sub)
                w[a] = e
            out[book][wname] = w
    return out


def main() -> None:
    root = data_dir()
    rows, skipped, checks = run(root)
    report = {"summary": summarise(rows), "skipped": skipped, "apply_book_checks": checks,
              "prompt_day": {b: {"stop": rows[PROMPT_DAY]["books"][b]["stop"], "high": rows[PROMPT_DAY]["books"][b]["high"],
                                 "low": rows[PROMPT_DAY]["books"][b]["low"], "picks": rows[PROMPT_DAY]["picks"],
                                 "arms": {a: {"net": v["net"], "at": None if v["minute"] is None else minute_label(v["minute"])}
                                          for a, v in rows[PROMPT_DAY]["books"][b]["arms"].items()}}
                             for b in BOOKS} if PROMPT_DAY in rows else None,
              "note": "T1 list C as BL-194; dir2 = Shoonya (Dir x2 on non-expiry days, stop 9k + Dir's stop on 4-lot days), three = Angel One (1 lot each, 9k); net = gross - brokerage, no slippage"}  # fmt: skip
    (HERE / "book_trail_2026-11-04.json").write_text(
        json.dumps(report, indent=1, default=float) + "\n"
    )
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / "rows_2026-11-04.json").write_text(json.dumps(rows, default=float) + "\n")
    print(
        f"{len(rows)} days, {len(skipped)} skipped, {checks} apply_book checks",
        *skipped[:10],
        sep="\n  ",
    )
    for book, ws in report["summary"].items():
        for wname, w in ws.items():
            print(
                f"== {book} {wname} {w['from']}..{w['to']} {w['days']}d 4-lot {w['four_lot_days']} ctx {w['context']}"
            )
            for a in ARMS:
                x = w[a]
                line = (f"  {a:18} {x['per_day']:+7.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} "
                        f"w5% {x['worst_5pct_mean']:>7,.0f}")  # fmt: skip
                if "vs_base" in x:
                    v = x["vs_base"]
                    line += (f" | vs base {v['mean']:+5.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}] early {x['fired_early_days']:3}d "
                             f"given {x['given_up']['days']}d {x['given_up']['sum']:,.0f} saved {x['saved']['days']}d {x['saved']['sum']:,.0f}")  # fmt: skip
                else:
                    line += f" fired {x['fired_days']}d"
                print(line)
    print(json.dumps(report["prompt_day"], indent=1, default=float))


if __name__ == "__main__":
    main()
