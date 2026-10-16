"""BL-107 check: charges for every Core-298 pick on its pick day (the stored Core results are
uncharged), so each list's per-lot-day can be compared after charges. Added variants already carry
their simulated net. Writes results/replay_net.csv and prints the Adaptive comparison net of charges.

    uv run python research/bl107/net_check.py
"""

from __future__ import annotations

import csv
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402
from run_grid import trade_charges  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402

RES = HERE / "results"


def main() -> None:
    rows = list(csv.DictReader((RES / "replay_daily.csv").open()))
    core_needed: dict[tuple[str, date], set[str]] = defaultdict(set)
    for r in rows:
        d = date.fromisoformat(r["day"])
        for p in r["picks"].split("|"):
            if p.split("_")[1] in ("wide", "dir", "ditm1", "buy") or p.split("_")[1].startswith("p"):
                u = "NIFTY" if p.startswith("N_") else "SENSEX"
                core_needed[(u, d)].add(p)
    root = Path(data_dir())
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    charges: dict[tuple[str, date], float] = {}
    cache: dict[str, object] = {}
    for (u, d), names in sorted(core_needed.items(), key=lambda x: x[0][1]):
        data = load_day(root, u, d)
        for n in names:
            st = cache.setdefault(n, load_legwise(grid.ROTATION / f"{n}.yaml"))
            res = simulate_day(st, data, ref, sizing)
            charges[(n, d)] = sum(trade_charges(u, d, t)[0] for t in res.trades)
    out = defaultdict(lambda: {"gross": [], "net": []})
    for r in rows:
        d = date.fromisoformat(r["day"])
        picks = r["picks"].split("|")
        g = float(r["gross_per_lot"])
        mixed = float(r["net_per_lot"])  # added variants' net, core variants' gross
        core_ch = np.mean([charges.get((p, d), 0.0) for p in picks])
        out[(r["universe"], r["list"])]["gross"].append(g)
        out[(r["universe"], r["list"])]["net"].append(mixed - core_ch)
    with (RES / "replay_net.csv").open("w", newline="") as h:
        w = csv.writer(h)
        w.writerow(["universe", "list", "days", "gross_per_lot_day", "net_per_lot_day", "charges_per_lot_day",
                    "net_max_drawdown", "net_diff_vs_core", "lo90", "hi90"])
        for (uni, lst), v in out.items():
            base = np.array(out[("Core-298", lst)]["net"])
            n = np.array(v["net"])
            mean, lo, hi = block_bootstrap_mean(n - base) if uni != "Core-298" else (0.0, 0.0, 0.0)
            w.writerow([uni, lst, len(n), np.mean(v["gross"]), n.mean(), np.mean(v["gross"]) - n.mean(),
                        max_drawdown(n), mean, lo, hi])
            if lst == "Adaptive":
                print(f"{uni:14s} gross {np.mean(v['gross']):6.1f}  net {n.mean():6.1f}  charges {np.mean(v['gross']) - n.mean():5.1f}"
                      f"  net maxDD {max_drawdown(n):8.0f}" + ("" if uni == "Core-298" else f"  net diff {mean:+6.1f} [{lo:+6.1f},{hi:+6.1f}]"))


if __name__ == "__main__":
    main()
