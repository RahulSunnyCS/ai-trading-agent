"""BL-241: portfolio-stop variants (trail, lock, lock-and-trail; 33 arms) on T1's Dir x2 and 3-lot books.
Chosen on the fit window, confirmed once on the confirmation window. As registered in backlog/BL-241 Phase 0.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl241/sweep.py F   # fit window, picks the finalists
    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl241/sweep.py K   # confirmation window, once

Picks: research/bl238/picks_by_day.csv (fresh ranking). Paths replayed from the lake, the book by
`portfolio.apply_book`. Writes only beside itself.
"""

from __future__ import annotations

import csv
import json
import os
import sys
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
WINDOWS = {
    "F": (date(2025, 1, 10), date(2025, 10, 8)),
    "K": (date(2025, 10, 9), date(2026, 11, 19)),
}
BOOKS = ("dir2", "three")
COST_BOUND = -25.0  # mean change vs base, per lot-day
DD_SHALLOWER_ON_K = 0.15
TOP_N = 3


def build_arms() -> dict[str, portfolio.Trail | None]:
    arms: dict[str, portfolio.Trail | None] = {"base": None}
    for x in (1000, 2000, 3000, 5000):
        for k, ratio in (("q", 0.25), ("h", 0.5), ("1", 1.0)):
            arms[f"sl_{x}_{int(x * ratio)}"] = portfolio.Trail("sl", x=float(x), y=x * ratio)
    for a in (3000, 5000, 8000):
        for b in (0, 1000, 2500):
            arms[f"lock_{a}_{b}"] = portfolio.Trail("lock", a=float(a), b=float(b))
    for a in (3000, 5000):
        for b in (0, 1000):
            for x, y in ((1000, 500), (2000, 1000), (3000, 1500)):
                arms[f"lt_{a}_{b}_{x}_{y}"] = portfolio.Trail(
                    "locktrail", a=float(a), b=float(b), x=float(x), y=float(y)
                )
    return arms


ARMS = build_arms()
assert len(ARMS) == 34, len(ARMS)  # 33 arms and the base


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


def run(root: Path, lo: date, hi: date) -> tuple[dict[str, dict], list[str]]:
    trades: dict[str, dict[date, int]] = {}
    rows, skipped = {}, []
    for r in csv.DictReader(PICKS.open()):
        d = date.fromisoformat(r["day"])
        if not lo <= d <= hi:
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
        brokerage = sum(2 * trades[m][d] * BROKERAGE for m in core)
        row = {"day": d.isoformat(), "books": {}}
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
            row["books"][book] = arms
        rows[d.isoformat()] = row
    return rows, skipped


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {"mean": m, "ci90": [lo, hi]}


def metrics(net: np.ndarray, base: np.ndarray) -> dict:
    k = max(1, round(len(net) * 0.05))
    out = {
        "per_day": float(net.mean()),
        "total": float(net.sum()),
        "max_drawdown": float(max_drawdown(net)),
        "worst_day": float(net.min()),
        "worst_5pct_mean": float(np.sort(net)[:k].mean()),
    }
    out["vs_base"] = interval(net - base)
    return out


def summarise(rows: dict[str, dict]) -> dict:
    out = {}
    for book in BOOKS:
        days = sorted(rows)
        base = np.array([rows[d]["books"][book]["base"]["net"] for d in days])
        out[book] = {"days": len(days)}
        for a in ARMS:
            net = np.array([rows[d]["books"][book][a]["net"] for d in days])
            out[book][a] = metrics(net, base)
    return out


def dd_reduction(arm: dict, base: dict) -> float:
    """How much shallower the arm's deepest drawdown is than the base's (positive: shallower)."""
    b = abs(base["max_drawdown"])
    return (b - abs(arm["max_drawdown"])) / b if b else 0.0


def select(fit: dict) -> dict[str, list[str]]:
    chosen = {}
    for book in BOOKS:
        base = fit[book]["base"]
        ok = [
            (dd_reduction(v, base), a)
            for a, v in fit[book].items()
            if a not in ("base", "days")
            and v["vs_base"]["mean"] >= COST_BOUND
            and dd_reduction(v, base) > 0
        ]
        ok.sort(key=lambda t: (-t[0], t[1]))
        chosen[book] = [a for _, a in ok[:TOP_N]]
    return chosen


def stage_f() -> None:
    root = data_dir()
    report = {}
    for slip in (0.0, 0.5):
        with store.slipped(slip):
            rows, skipped = run(root, *WINDOWS["F"])
        report[f"slip{slip:g}"] = {"summary": summarise(rows), "skipped": skipped}
    fit = report["slip0"]["summary"]
    selected = select(fit)
    report["selected"] = selected
    (HERE / "result_F.json").write_text(json.dumps(report, indent=1, default=float) + "\n")
    (HERE / "selected.json").write_text(json.dumps(selected, indent=1) + "\n")
    for book in BOOKS:
        base = fit[book]["base"]
        print(
            f"\n== F {book} {fit[book]['days']} days, base {base['per_day']:+.0f}/d DD {base['max_drawdown']:,.0f}"
        )
        for a in ARMS:
            if a == "base":
                continue
            v = fit[book][a]
            mark = " <- advances" if a in selected[book] else ""
            print(
                f"  {a:16} {v['vs_base']['mean']:+6.0f}/d [{v['vs_base']['ci90'][0]:+.0f},{v['vs_base']['ci90'][1]:+.0f}]"
                f" DD {v['max_drawdown']:>8,.0f} ({dd_reduction(v, base):+.0%}) w5% {v['worst_5pct_mean']:>7,.0f}{mark}"
            )
    print("\nselected:", selected)


def stage_k() -> None:
    assert (HERE / "result_F.json").exists(), "read F first (registered order)"
    out_path = HERE / "result_K.json"
    if out_path.exists() and "--override" not in sys.argv:
        sys.exit("K was read already: the registration reads it once")
    selected = json.loads((HERE / "selected.json").read_text())
    root = data_dir()
    report = {"selected": selected}
    for slip in (0.0, 0.5):
        with store.slipped(slip):
            rows_k, skipped = run(root, *WINDOWS["K"])
            rows_all, _ = run(root, WINDOWS["F"][0], WINDOWS["K"][1]) if slip == 0.0 else ({}, [])
        entry = {"summary": summarise(rows_k), "skipped": skipped}
        if rows_all:
            entry["all_days_descriptive"] = summarise(rows_all)
        report[f"slip{slip:g}"] = entry
    k = report["slip0"]["summary"]
    verdict = {}
    for book in BOOKS:
        base = k[book]["base"]
        for a in selected[book]:
            v = k[book][a]
            checks = {
                "cost_ok": v["vs_base"]["mean"] >= COST_BOUND,
                "dd_15pct_shallower": dd_reduction(v, base) >= DD_SHALLOWER_ON_K,
                "worst5_no_worse": v["worst_5pct_mean"] >= base["worst_5pct_mean"],
            }
            verdict[f"{book}:{a}"] = {"checks": checks, "pass": all(checks.values())}
    report["verdict"] = verdict
    out_path.write_text(json.dumps(report, indent=1, default=float) + "\n")
    for book in BOOKS:
        base = k[book]["base"]
        print(
            f"\n== K {book} {k[book]['days']} days, base {base['per_day']:+.0f}/d DD {base['max_drawdown']:,.0f} w5% {base['worst_5pct_mean']:,.0f}"
        )
        for a in selected[book]:
            v = k[book][a]
            print(
                f"  {a:16} {v['vs_base']['mean']:+6.0f}/d [{v['vs_base']['ci90'][0]:+.0f},{v['vs_base']['ci90'][1]:+.0f}]"
                f" DD {v['max_drawdown']:>8,.0f} ({dd_reduction(v, base):+.0%}) w5% {v['worst_5pct_mean']:>7,.0f}"
                f" -> {verdict[f'{book}:{a}']}"
            )


if __name__ == "__main__":
    os.environ.setdefault("TRADING_DATA_ROOT", "/Volumes/TradingData")
    {"F": stage_f, "K": stage_k}[sys.argv[1]]()
