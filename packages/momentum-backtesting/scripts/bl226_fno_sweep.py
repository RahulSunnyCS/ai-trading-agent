"""BL-226 Phase 2: Momentum's stock strategy on the point-in-time F&O stock universe.

Registered in backlog/BL-226-fno-momentum-stock-options.md (Phase 0): 18 grid cells (look-back 3, 6
or 12 months x top N 5, 8, 10 x weekly or monthly) plus every saved favourite group run unchanged
except for the universe, ranked on the learning period (2020-01 -> 2024-06) by after-tax CAGR /
max drawdown; the three kept must differ in look-back or N. `confirm` runs the three (and keeps
their weekly holdings for Phase 3) only after the learning read is written in the item.

Runs against a scratch copy of the Momentum data (MOMENTUM_DATA_DIR / MOMENTUM_STATE_DIR), never
the live data folder.

    MOMENTUM_DATA_DIR=<copy> MOMENTUM_STATE_DIR=<state> uv run python scripts/bl226_fno_sweep.py \\
        learn --favourites <favourite-strategies.json> --out <dir>
    ... confirm --out <dir> --pick <id> --pick <id> --pick <id>
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path
from typing import Any

import pandas as pd

LEARN = ("2020-01-01", "2024-06-28")
CONFIRM_START = "2024-07-01"
#: Look-back sets: Broad's own horizons (weeks) up to 3, 6 and 12 months.
LOOKBACKS = {"3m": [1, 4, 13], "6m": [1, 4, 13, 26], "12m": [1, 4, 13, 26, 52]}
TOP_N = (5, 8, 10)
CADENCE = {
    "weekly": {"rebalance": "weekly", "rebalance_every": 1},
    "monthly": {"rebalance": "monthly"},
}
#: Realism for the grid: the invested favourite's fill, costs, circuits and liquidity gate; the
#: options book's ₹10 lakh capital; no share-price cap (the stock is not bought in Phase 3).
GRID_BASE = {
    "dataset": "broad",
    "universe": ["broad_momentum"],
    "portfolio": "buffer",
    "broad_category_mode": "off",
    "broad_universe": "fno",
    "broad_liquidity_filter": True,
    "execution": "fri_close",
    "signal_delay": 1,
    "cost_model": "itemised",
    "slippage_bps": 15.0,
    "capital": 1_000_000.0,
    "broad_respect_circuits": True,
    "max_stock_price": 0.0,
    "score": "ranksum",
    "weights": None,
    "voladj_skip_recent_month": True,
    "broad_liq_min_turnover_cr": 2.0,
    "broad_liq_floor_ratio": 0.25,
    "broad_liq_min_price": 30.0,
    "max_position": 0.25,
    "broad_pool_top_n": 336,
    "broad_pool_exit_rank": 340,
}


def grid() -> list[dict[str, Any]]:
    cells = []
    for lb_name, lbs in LOOKBACKS.items():
        for n in TOP_N:
            for cad, cad_fields in CADENCE.items():
                cfg = {**GRID_BASE, "lookbacks": lbs, "broad_off_top_n": n,
                       "broad_off_exit_rank": 2 * n, **cad_fields}  # fmt: skip
                cells.append({"id": f"grid-{lb_name}-top{n}-{cad}", "lookback": lb_name, "n": n,
                              "members": [cfg]})  # fmt: skip
    return cells


def favourite_groups(path: Path) -> list[dict[str, Any]]:
    out = []
    for fav in json.loads(path.read_text()):
        if not fav.get("status") or not fav.get("members"):
            continue
        members = [{**m["config"], "broad_universe": "fno"} for m in fav["members"]]
        lbs = members[0].get("lookbacks")
        out.append({"id": "fav-" + fav["id"][:12], "name": fav["name"], "status": fav["status"],
                    "lookback": f"{max(lbs)}w", "n": members[0].get("broad_category_top_n"),
                    "members": members})  # fmt: skip
    return out


def run_member(cfg: dict[str, Any], start: str, end: str | None):
    from momentum_backtesting import api
    from momentum_backtesting.tax import TaxRules

    req = api.BacktestRequest(**{**cfg, "start": start, "end": end})
    ranking = api._broad_ranking(req)
    return api._run_broad(req, ranking, api.DATA.get(), tax=TaxRules()).result


def blend(equities: list[pd.Series]) -> pd.Series:
    """Equal capital in each sleeve, never rebalanced between them."""
    frame = pd.concat([e / e.iloc[0] for e in equities], axis=1).ffill()
    return frame.mean(axis=1)


def measures(eq: pd.Series, bench: pd.Series) -> dict[str, float]:
    from momentum_backtesting import metrics

    cg = metrics.cagr(eq)
    mdd = metrics.max_drawdown(eq)[0]
    weekly = eq.pct_change().dropna()
    return {
        "cagr_after_tax": round(float(cg), 5),
        "mdd": round(float(mdd), 5),
        "calmar": round(float(cg / abs(mdd)), 4) if mdd < 0 else math.nan,
        "sharpe_raw": round(float(weekly.mean() / weekly.std() * math.sqrt(52)), 4),
        "bench_cagr": round(float(metrics.cagr(bench)), 5),
        "weeks": len(eq),
        "first": str(eq.index[0].date()),
        "last": str(eq.index[-1].date()),
    }


def run_entry(entry: dict[str, Any], start: str, end: str | None) -> tuple:
    t0 = time.time()
    results = [run_member(m, start, end) for m in entry["members"]]
    eq = blend([r.equity for r in results])
    row = {k: v for k, v in entry.items() if k != "members"}
    row["metrics"] = measures(eq, results[0].benchmark)
    row["buys_per_yr"] = round(
        sum(int((r.trades["action"] == "BUY").sum()) for r in results if len(r.trades))
        / len(results) / (len(eq) / 52), 1)  # fmt: skip
    row["secs"] = round(time.time() - t0, 1)
    return row, results, eq


def learn(args: argparse.Namespace) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sink = out / "learn.jsonl"
    done = {json.loads(line)["id"] for line in sink.open()} if sink.exists() else set()
    entries = grid() + favourite_groups(Path(args.favourites))
    for entry in entries:
        if entry["id"] in done:
            continue
        try:
            row, _, eq = run_entry(entry, *LEARN)
            eq.to_frame("equity").to_csv(out / f"equity-learn-{entry['id']}.csv")
        except Exception as error:  # noqa: BLE001 - recorded, the sweep goes on
            row = {k: v for k, v in entry.items() if k != "members"}
            row["error"] = f"{type(error).__name__}: {error}"[:400]
        with sink.open("a") as f:
            f.write(json.dumps(row, default=str) + "\n")
        print(row["id"], row.get("metrics", row.get("error")), flush=True)
    rank(out)


def _calmar(row: dict[str, Any]) -> float:
    c = row["metrics"]["calmar"]
    return c if c == c else -9.0


def rank(out: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in (out / "learn.jsonl").open()]
    ok = sorted((r for r in rows if "metrics" in r),
                key=lambda r: -_calmar(r))  # fmt: skip
    picked, seen = [], set()
    for r in ok:
        key = (r["lookback"], r["n"])
        if key in seen:
            continue
        picked.append(r)
        seen.add(key)
        if len(picked) == 3:
            break
    (out / "learn_ranked.json").write_text(json.dumps({"ranked": ok, "picked": picked}, indent=1))
    for r in ok:
        mark = "*" if r in picked else " "
        m = r["metrics"]
        print(f"{mark} {r['id']:<34} calmar {m['calmar']:>6}  cagr {m['cagr_after_tax']:>8}  "
              f"mdd {m['mdd']:>8}  buys/yr {r.get('buys_per_yr')}")  # fmt: skip
    return picked


def confirm(args: argparse.Namespace) -> None:
    out = Path(args.out)
    entries = {e["id"]: e for e in grid() + favourite_groups(Path(args.favourites))}
    rows = []
    for pid in args.pick:
        entry = entries[pid]
        # the confirmation read and, for Phase 3, the whole period's weekly holdings
        row, _, eq = run_entry(entry, CONFIRM_START, None)
        eq.to_frame("equity").to_csv(out / f"equity-confirm-{pid}.csv")
        rows.append(row)
        _, results, full = run_entry(entry, LEARN[0], None)
        full.to_frame("equity").to_csv(out / f"equity-full-{pid}.csv")
        for i, r in enumerate(results):
            r.weights.to_csv(out / f"weights-{pid}-m{i}.csv")
            r.trades.to_csv(out / f"trades-{pid}-m{i}.csv")
            r.ranks.to_csv(out / f"ranks-{pid}-m{i}.csv")
        print(pid, row["metrics"], flush=True)
    (out / "confirm.json").write_text(json.dumps(rows, indent=1, default=str))


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("learn")
    a.add_argument("--favourites", required=True)
    a.add_argument("--out", required=True)
    b = sub.add_parser("rank")
    b.add_argument("--out", required=True)
    c = sub.add_parser("confirm")
    c.add_argument("--favourites", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--pick", action="append", required=True)
    args = p.parse_args()
    {"learn": learn, "rank": lambda a: rank(Path(a.out)), "confirm": confirm}[args.cmd](args)


if __name__ == "__main__":
    main()
