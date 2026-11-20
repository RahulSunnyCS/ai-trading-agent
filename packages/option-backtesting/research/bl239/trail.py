"""BL-239: T1's portfolio stop with a stepped 1:1 trail (every 3,000 of profit moves the stop up 3,000),
on the Dir x2 and 3-lot books, against today's stop. As registered in backlog/BL-239 Phase 0.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl239/trail.py

Picks: research/bl238/picks_by_day.csv (a fresh ranking, no stale stored result). Paths replayed from the lake
(`portfolio.one_lot_path`), the book by `portfolio.apply_book`. Writes only beside itself.
"""

from __future__ import annotations

import csv
import json
import os
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import live_lots, portfolio, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown

HERE = Path(__file__).parent
PICKS = HERE.parent / "bl238" / "picks_by_day.csv"
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261120, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
FIRST = date(2025, 1, 10)
LAST_YEAR_FROM = date(2025, 11, 20)
BOOKS = ("dir2", "three")
ARMS = {
    "base": None,
    "trail_1_1_stepped": portfolio.Trail(
        "sl", x=3000, y=3000
    ),  # the owner's rule, the only adoptable arm
    "trail_3_2_stepped": portfolio.Trail("sl", x=3000, y=2000),
    "trail_3_1_stepped": portfolio.Trail("sl", x=3000, y=1000),
    "trail_1_1_continuous": portfolio.Trail("sl", x=1, y=1),
}


def read_trades(name: str, root: Path) -> dict[date, int]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                out[date.fromisoformat(r["day"])] = int(float(r.get("n_trades") or 0))
            except (KeyError, ValueError):
                continue
    return out


def mtmsl(name: str) -> float:
    from option_backtesting.legwise.schema import load_legwise

    v = load_legwise(portfolio.strategy_file(name)).overall.stop_loss_inr
    return float(v) if v is not None else NO_MTMSL_ADD


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def metrics(net: np.ndarray) -> dict:
    k = max(1, round(len(net) * 0.05))
    return {
        "per_day": float(net.mean()),
        "total": float(net.sum()),
        "max_drawdown": max_drawdown(net),
        "worst_day": float(net.min()),
        "worst_5pct_mean": float(np.sort(net)[:k].mean()),
    }


def run(root: Path) -> tuple[dict[str, dict], list[str]]:
    picks = list(csv.DictReader(PICKS.open()))
    trades: dict[str, dict[date, int]] = {}
    rows, skipped = {}, []
    for r in picks:
        d = date.fromisoformat(r["day"])
        if d < FIRST:
            continue
        core = r["picks"].split()
        dte = {"NIFTY": r["dte_n"], "SENSEX": r["dte_s"]}
        lots2 = live_lots.lots_for_day(core, dte)
        four = live_lots.boosted(lots2)
        doubled = next((m for m, n in lots2.items() if n > 1), None)
        try:
            loaded: dict = {}
            paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in core}
            for m in core:
                trades.setdefault(m, read_trades(m, root))
            if any(d not in trades[m] for m in core):
                raise portfolio.PortfolioStopError("a stored trade count is missing")
        except (portfolio.PortfolioStopError, FileNotFoundError) as e:
            skipped.append(f"{d}: {e}")
            continue
        row = {"day": d.isoformat(), "picks": core, "books": {}}
        brokerage = sum(2 * trades[m][d] * BROKERAGE for m in core)
        for book in BOOKS:
            if book == "dir2":
                lots, s = lots2, (BASE_STOP + mtmsl(doubled) if four else BASE_STOP)
            else:
                lots, s = dict.fromkeys(core, 1), BASE_STOP
            members = [portfolio.Member(m, n, paths[m]) for m, n in lots.items()]
            arms = {}
            for name, trail in ARMS.items():
                bd = portfolio.apply_book(members, s, trail)
                arms[name] = {"net": bd.gross_with - brokerage, "minute": bd.stop_minute}
            row["books"][book] = {
                "stop": s,
                "four_lot": four if book == "dir2" else False,
                "arms": arms,
            }
        rows[d.isoformat()] = row
    return rows, skipped


def summarise(rows: dict[str, dict]) -> dict:
    out = {}
    newest = max(rows)
    for book in BOOKS:
        out[book] = {}
        for wname, lo in (("all", FIRST), ("last_year", LAST_YEAR_FROM)):
            sub = [r["books"][book] for k, r in sorted(rows.items()) if k >= lo.isoformat()]
            base = np.array([r["arms"]["base"]["net"] for r in sub])
            w: dict = {
                "from": lo.isoformat(),
                "to": newest,
                "days": len(sub),
                "four_lot_days": sum(r["four_lot"] for r in sub),
            }
            for a in ARMS:
                net = np.array([r["arms"][a]["net"] for r in sub])
                e = metrics(net)
                if a != "base":
                    e["vs_base"] = interval(net - base)
                    early = [
                        r["arms"][a]["net"] - r["arms"]["base"]["net"]
                        for r in sub
                        if r["arms"][a]["minute"] is not None
                        and (
                            r["arms"]["base"]["minute"] is None
                            or r["arms"][a]["minute"] < r["arms"]["base"]["minute"]
                        )
                    ]
                    e["fired_early_days"] = len(early)
                    e["given_up"] = {
                        "days": sum(x < 0 for x in early),
                        "sum": float(sum(x for x in early if x < 0)),
                    }
                    e["saved"] = {
                        "days": sum(x > 0 for x in early),
                        "sum": float(sum(x for x in early if x > 0)),
                    }
                w[a] = e
            out[book][wname] = w
    return out


def verdict(summary: dict) -> dict:
    out = {}
    for book in BOOKS:
        a, ly = (
            summary[book]["all"]["trail_1_1_stepped"],
            summary[book]["last_year"]["trail_1_1_stepped"],
        )
        base_dd = summary[book]["all"]["base"]["max_drawdown"]
        beats = (
            a["vs_base"]["ci90"][0] > 0
            and ly["vs_base"]["ci90"][0] > 0
            and a["max_drawdown"] <= base_dd
        )
        out[book] = "beats base" if beats else "killed"
    return out


def main() -> None:
    root = data_dir()
    report = {}
    for slip in (0.0, 0.5):
        with store.slipped(slip):
            rows, skipped = run(root)
        s = summarise(rows)
        report[f"slip{slip:g}"] = {
            "summary": s,
            "skipped": skipped,
            "verdict": verdict(s) if slip == 0.0 else None,
        }
        print(
            f"\n######## slippage {slip:g}%  ({len(rows)} days, {len(skipped)} skipped) verdict: {report[f'slip{slip:g}']['verdict']}"
        )
        for book, ws in s.items():
            for wname, w in ws.items():
                print(
                    f"== {book} {wname} {w['from']}..{w['to']} {w['days']}d 4-lot {w['four_lot_days']}"
                )
                for a in ARMS:
                    x = w[a]
                    line = f"  {a:22} {x['per_day']:+7.0f}/d total {x['total']:>9,.0f} DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} w5% {x['worst_5pct_mean']:>7,.0f}"
                    if "vs_base" in x:
                        v = x["vs_base"]
                        line += f" | vs base {v['mean']:+5.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}] early {x['fired_early_days']:3}d given {x['given_up']['days']}d {x['given_up']['sum']:,.0f} saved {x['saved']['days']}d {x['saved']['sum']:,.0f}"
                    print(line)
    (HERE / "trail_2026-11-20.json").write_text(json.dumps(report, indent=1, default=float) + "\n")


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    main()
