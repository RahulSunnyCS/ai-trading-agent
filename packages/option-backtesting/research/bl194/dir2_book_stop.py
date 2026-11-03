"""BL-194: T1's book stop on Dir x2 days, levels 9k-20k and none against today's rule (9k + the
Dir's own MTM SL). As registered in backlog/BL-194 Phase 0 (descriptive, in-sample). Reads the live
store, replays one-lot paths through `rotation/portfolio.py` (its disk cache); writes only beside
itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl194/dir2_book_stop.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import daylog, expiry, live_lots, pick, portfolio, sl150_cap, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261102, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
LEVELS = (9000, 10000, 11000, 12000, 13000, 14000, 15000, 16000, 18000, 20000)
ARMS = ("rule", *(f"{v // 1000}k" for v in LEVELS), "none")
FIRST = date(2025, 1, 10)
LAST = date(2026, 10, 30)  # the first run's newest day; a re-run keeps the same days
LAST_YEAR_FROM = date(2025, 11, 3)


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


def stop_for(arm: str, dir_name: str) -> float | None:
    if arm == "none":
        return None
    if arm == "rule":
        return BASE_STOP + mtmsl(dir_name)
    return float(arm[:-1]) * 1000


def run(root: Path) -> tuple[dict[str, dict], list[str]]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, [*variant_names(), *track_names("t1")])
    assert rec.error is None, rec.error
    trades: dict[str, dict[date, int]] = {}
    rows: dict[str, dict] = {}
    skipped: list[str] = []
    for d in rec.days_available():
        if d < FIRST or d > LAST:
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
            capped = False
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(labels[0]) and labels[0] != "0":
                new = sl150_cap.cap_picks(comp, cols, picks)
                capped = new is not picks
                picks = new
            core = list(picks.core)
            # live's own rule (rotation/live_lots.py): an unknown label counts as an expiry day,
            # so nothing is doubled on a day that cannot be shown to be a normal one
            lots = live_lots.lots_for_day(core, dte)
            is_expiry = live_lots.summary(core, dte) == "expiry day"
            four = live_lots.boosted(lots)
            doubled = next((m for m, n in lots.items() if n > 1), None)
            members_spec = list(lots.items())
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
            members = [portfolio.Member(m, lots, paths[m]) for m, lots in members_spec]
            brokerage = sum(2 * trades[m][d] * BROKERAGE for m in core)
            row = {"day": d.isoformat(), "expiry": is_expiry, "four_lot": four, "doubled": doubled,
                   "sl150_capped": capped, "brokerage": brokerage, "arms": {}}  # fmt: skip
            if four:
                for arm in ARMS:
                    bd = portfolio.apply_book(members, stop_for(arm, doubled))
                    row["arms"][arm] = {"gross": bd.gross_with, "fired": bd.stop_minute is not None,
                                        "stop": stop_for(arm, doubled)}  # fmt: skip
                    if arm == "none":
                        row["low_nostop"] = float(min(min(bd.combined), 0.0))
            else:
                bd = portfolio.apply_book(members, BASE_STOP)
                for arm in ARMS:
                    row["arms"][arm] = {"gross": bd.gross_with, "fired": bd.stop_minute is not None,
                                        "stop": BASE_STOP}  # fmt: skip
            rows[d.isoformat()] = row
    return rows, skipped


def metrics(net: np.ndarray) -> dict:
    k = max(1, int(round(len(net) * 0.05)))
    return {"per_day": float(net.mean()), "total": float(net.sum()), "max_drawdown": max_drawdown(net),
            "worst_day": float(net.min()), "worst_5pct_mean": float(np.sort(net)[:k].mean())}  # fmt: skip


def summarise(rows: dict[str, dict]) -> dict:
    newest = max(rows)
    out = {}
    for wname, lo in (("all", FIRST), ("last_year", LAST_YEAR_FROM)):
        sub = [r for k, r in sorted(rows.items()) if k >= lo.isoformat()]
        four = [r for r in sub if r["four_lot"]]
        net = {a: np.array([r["arms"][a]["gross"] - r["brokerage"] for r in sub]) for a in ARMS}
        lows = np.array([r["low_nostop"] for r in four])
        w: dict = {"from": sub[0]["day"], "to": newest, "days": len(sub), "four_lot_days": len(four),
                   "expiry_days": sum(r["expiry"] for r in sub),
                   "rule_stop_values": sorted({r["arms"]["rule"]["stop"] for r in four}),
                   "four_lot_low_nostop": {"p50": float(np.percentile(lows, 50)), "p10": float(np.percentile(lows, 10)),
                                           "p1": float(np.percentile(lows, 1)), "min": float(lows.min())}}  # fmt: skip
        for a in ARMS:
            e = metrics(net[a]) | {"fired_four_lot_days": sum(r["arms"][a]["fired"] for r in four)}
            if a != "rule":
                e["vs_rule"] = interval(net[a] - net["rule"])
            if a != "none":
                diff = [
                    (r["arms"][a]["gross"] - r["arms"]["none"]["gross"])
                    for r in four
                    if r["arms"][a]["fired"]
                ]
                e["cost_days"] = sum(x < 0 for x in diff)
                e["cost_sum"] = float(sum(x for x in diff if x < 0))
                e["saved_days"] = sum(x > 0 for x in diff)
                e["saved_sum"] = float(sum(x for x in diff if x > 0))
            w[a] = e
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    rows, skipped = run(root)
    report = {"summary": summarise(rows), "skipped": skipped,
              "note": "T1 list C, expiry rule + SL150 cap as if live throughout; Dir x2 on non-expiry days with a Dir pick; 3-lot days at 9k in every arm; net = gross - brokerage"}  # fmt: skip
    (HERE / "dir2_book_stop_2026-11-02.json").write_text(json.dumps(report, indent=1) + "\n")
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / "rows_2026-11-02.json").write_text(json.dumps(rows) + "\n")
    print(f"{len(rows)} days, {len(skipped)} skipped", *skipped[:10], sep="\n  ")
    for wname, w in report["summary"].items():
        print(f"== {wname} {w['from']}..{w['to']} {w['days']}d, 4-lot {w['four_lot_days']}, expiry {w['expiry_days']}, "
              f"rule stops {w['rule_stop_values']}, 4-lot low no stop {w['four_lot_low_nostop']}")  # fmt: skip
        for a in ARMS:
            x = w[a]
            line = (f"  {a:5} {x['per_day']:+7.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} "
                    f"w5% {x['worst_5pct_mean']:>7,.0f} fired {x['fired_four_lot_days']:3}")  # fmt: skip
            if "cost_days" in x:
                line += f" cost {x['cost_days']:2}d {x['cost_sum']:>8,.0f} saved {x['saved_days']:2}d {x['saved_sum']:>8,.0f}"
            if "vs_rule" in x:
                v = x["vs_rule"]
                line += f" | vs rule {v['mean']:+5.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}]"
            print(line)


if __name__ == "__main__":
    main()
