"""BL-068 group 3: stability of the BL-067 weight rows (no new rotation runs) + the group-2 read-out.

    uv run --with pandas --with numpy python research/bl068/analyse.py

- halves (2025-12-03 -> 2026-04-30 / 2026-05-01 -> 2026-10-08) for rows 0, 1, 6, 7
- block bootstrap (5-day blocks, 2,000 resamples) of daily baseline - no-recent and baseline - no-VIX
- CSCV / PBO over the 16 rows' daily P&L via option_backtesting.analytics.overfit.run_cscv
- the true baseline against the 20 label shuffles of research/bl068/out/summary.csv
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

from option_backtesting.analytics.overfit import run_cscv
from option_backtesting.analytics.sweep import SweepReport

HERE = Path(__file__).parent
PICKS = HERE.parent / "bl057"
sys.path.insert(0, str(HERE.parent / "bl067"))
from combos import COMBOS  # noqa: E402

ROWS = {"baseline": (33, 25, 25, 17), "recent-only": (100, 0, 0, 0), "no-recent": (0, 33, 33, 34), "no-vix": (40, 30, 30, 0)}
SPLIT = pd.Timestamp("2026-05-01")


def daily(w) -> pd.Series:
    f = PICKS / f"daily_picks_min3_core6_buy2L2_whole_day_w{'_'.join(map(str, w))}.csv"
    return pd.read_csv(f, parse_dates=["day"]).set_index("day").pnl_A


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def block_bootstrap(diff: np.ndarray, block: int = 5, n: int = 2000, seed: int = 68) -> tuple[float, float, float]:
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(len(diff) / block))
    starts = np.arange(0, len(diff) - block + 1)
    tots = np.empty(n)
    for r in range(n):
        ix = np.concatenate([np.arange(s, s + block) for s in rng.choice(starts, nb)])[: len(diff)]
        tots[r] = diff[ix].sum()
    return float(np.percentile(tots, 5)), float(np.percentile(tots, 95)), float((tots <= 0).mean())


def main() -> None:
    series = {k: daily(w) for k, w in ROWS.items()}
    print("=== halves: gross | max drawdown ===")
    print(f"{'row':12s} {'H1 (Dec-Apr)':>22s} {'H2 (May-Oct)':>22s}")
    for k, s in series.items():
        h1, h2 = s[s.index < SPLIT], s[s.index >= SPLIT]
        print(f"{k:12s} {h1.sum():>11,.0f} {mdd(h1):>10,.0f} {h2.sum():>11,.0f} {mdd(h2):>10,.0f}")
    print("\n=== block bootstrap of the daily gap (5-day blocks, 2000 resamples): total gap, 90% interval, P(gap <= 0) ===")
    for other in ("no-recent", "no-vix", "recent-only"):
        d = (series["baseline"] - series[other]).to_numpy()
        lo, hi, p0 = block_bootstrap(d)
        print(f"baseline - {other:12s} {d.sum():>10,.0f}   [{lo:>10,.0f}, {hi:>10,.0f}]   P<=0 {p0:.3f}")

    # CSCV / PBO over the 16 BL-067 rows (duck-typed SweepReport: label + result.sessions[].net)
    configs = []
    for name, w in COMBOS:
        s = daily(w)
        configs.append(SimpleNamespace(label=name, result=SimpleNamespace(sessions=[SimpleNamespace(net=float(v)) for v in s])))
    report = SweepReport(date_from=date(2025, 12, 3), date_to=date(2026, 10, 8), configs=configs)
    for nb in (8, 16):
        r = run_cscv(report, n_blocks=nb)
        print(f"\nCSCV over {r.n_configs} weight rows, {nb} blocks ({r.n_combinations} IS/OOS splits): PBO = {r.pbo:.2f}")

    # group 2: the true baseline against the 20 shuffles
    summ = pd.read_csv(HERE / "out" / "summary.csv").set_index("name")
    sh = summ[summ.index.str.startswith("shuffle-")].gross
    base = summ.loc["baseline", "gross"]
    rank = int((sh >= base).sum())
    print(
        f"\n=== label placebo: 20 shuffles gross min {sh.min():,.0f} / mean {sh.mean():,.0f} / sd {sh.std(ddof=1):,.0f} / max {sh.max():,.0f}; "
        f"true baseline {base:,.0f} is beaten by {rank} of 20 (percentile {100 * (sh < base).mean():.0f}); plain 10-day recent {summ.loc['recent-window-10', 'gross']:,.0f} ==="
    )
    print(f"shuffle rows above recent-only's BL-067 gross (315,861): {int((sh > 315_861).sum())} of 20; noise yardstick (1 sd) = {sh.std(ddof=1):,.0f}")
    out = pd.DataFrame(dict(shuffle_gross=sh))
    out.to_csv(HERE / "out" / "placebo.csv")


if __name__ == "__main__":
    main()
