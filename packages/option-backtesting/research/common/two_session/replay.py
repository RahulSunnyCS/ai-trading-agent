"""BL-185 Phase 4: Adaptive over the tuned half-day winners on the test year.

Reads the frozen winners file, rebuilds each winner's daily series at every slot of its half from the
recorded paths (overlay + charges), then replays list C's composite (score.composite, as the 09:16
job, ranked on gross) per pool, three picks each (score.select: Widesl minimum two):
  A0 T1 Adaptive as traded (Core-298 + T1, whole day)       A1 whole-day winners of this sweep
  A2 the split: three morning + three afternoon picks        A3 afternoon-only, three picks
Books per margin lot-day = net / 3 (peak three concurrent sets). Test year T = 2025-10-09 on.

    uv run python research/common/two_session/replay.py [--winners PATH] [--out DIR]
"""

from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import stage_b as sb  # noqa: E402
from paths import PATHS_ROOT, load  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import minute_index  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import LISTS, WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.score import (  # noqa: E402
    composite,
    dte_matrix,
    family_index,
    select,
)

ROOT = HERE.parents[1] / "bl185"
SEED = 20261028
N_PICK = 3
GST = 1.18
T_START = date(2025, 10, 9)


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


class Series:
    """One variant's daily results: day -> (gross, net, orders, stopped)."""

    def __init__(self, name: str, u: str, rows: dict[date, tuple[float, float, int, bool]]):
        self.name, self.u, self.rows = name, u, rows


def winner_series(w: dict, slot: str) -> Series | None:
    win = w["winner"]
    co, u = w["cohort"], w["underlying"]
    cell = grid.cells(co)[int(win["cell"][1:])]
    f = PATHS_ROOT / f"{u}_{co}_{slot}" / f"{cell.name(u, slot)}.npz"
    if not f.exists():
        return None
    z = load(f)
    attrs_days = z["days"]
    stt = np.array([sb.ch.stt_rate(d) for d in attrs_days])
    entry = f"{slot[:2]}:{slot[2:]}"
    exit_ = win["exit"]
    if minute_index(exit_) - minute_index(entry) < sb.MIN_HOLD:
        return None
    g, n, s, o = sb.evaluate(z, entry, exit_, u, stt)
    si = sb.STOPS.index(win["stop"])
    code = f"{w['stratum'][0] if w['stratum'] == 'other' else 'x'}{w['band']}"
    name = f"{grid.INDEX_LETTER[u]}_{grid.FAMILY[co]}-{win['cell']}-s{win['stop'] or 0}-e{exit_.replace(':', '')}-{code}_{slot}"
    rows = {
        date.fromisoformat(d): (float(g[si, i]), float(n[si, i]), int(o[si, i]), bool(s[si, i]))
        for i, d in enumerate(attrs_days)
    }
    return Series(name, u, rows)


def pool_from_winners(
    winners: list[dict], mode: str, half: str | None, slots: tuple[str, ...]
) -> list[Series]:
    out = []
    for w in winners:
        if w["winner"] is None or w["mode"] != mode or (half and w["half"] != half):
            continue
        for slot in slots:
            s = winner_series(w, slot)
            if s is not None:
                out.append(s)
    return out


def pool_from_csv(folder: Path, prefix_ok=lambda n: True) -> list[Series]:
    out = []
    for f in sorted(folder.glob("*.csv")):
        if not prefix_ok(f.stem):
            continue
        u = "NIFTY" if f.stem.startswith("N_") else "SENSEX"
        rows = {}
        with open(f) as fh:
            for r in csv.DictReader(fh):
                rows[date.fromisoformat(r["day"])] = (
                    float(r["gross"]),
                    float(r["net"]),
                    int(r["orders"]),
                    bool(r["stopped_by"]),
                )
        out.append(Series(f.stem, u, rows))
    return out


def replay(pool: list[Series], attrs: dict, days_all: list[date]) -> dict:
    """List C's picks per day over `pool`: {day: [Series index]} and the aligned matrices."""
    days = sorted(set.intersection(*(set(s.rows) for s in pool)) & set(attrs) & set(days_all))
    days = [d for d in days if d.weekday() < 5]
    names = [s.name for s in pool]
    G = np.array([[s.rows[d][0] for s in pool] for d in days])
    wd = np.array([attrs[d]["weekday"] for d in days])
    bd = np.array([attrs[d]["vix_band"] for d in days])
    dn = np.array([attrs[d]["dte_n"] for d in days])
    ds = np.array([attrs[d]["dte_s"] for d in days])
    fam = family_index(names)
    picks = {}
    for i in range(WARMUP, len(days)):
        comp = composite(
            G[: i + 1],
            wd[: i + 1],
            bd[: i + 1],
            dte_matrix(dn[: i + 1], ds[: i + 1], names),
            names,
            LISTS["C"],
            fam,
        )
        p = select(comp, names)
        picks[days[i]] = [names.index(n) for n in p.core]
    return {"days": days, "names": names, "picks": picks}


def book(pool: list[Series], rep: dict, field: int, days: list[date]) -> np.ndarray:
    return np.array([sum(pool[v].rows[d][field] for v in rep["picks"][d]) for d in days])


def main() -> None:
    args = sys.argv[1:]
    wpath = (
        Path(args[args.index("--winners") + 1]) if "--winners" in args else ROOT / "winners.json"
    )
    out = Path(args[args.index("--out") + 1]) if "--out" in args else ROOT / "out"
    out.mkdir(exist_ok=True)
    winners = json.loads(wpath.read_text())
    attrs = store.read_days(data_dir(), "weekdays")
    days_all = sorted(attrs)
    a0 = pool_from_csv(ROOT / "a0")
    pools = {
        "A0": a0,
        "A1": pool_from_winners(winners, "whole", None, grid.SLOTS),
        "AM": pool_from_winners(winners, "half", "morning", grid.SLOTS_AM),
        "PM": pool_from_winners(winners, "half", "afternoon", grid.SLOTS_PM),
    }
    reps = {k: replay(p, attrs, days_all) for k, p in pools.items() if p}
    print({k: (len(pools[k]), len(r["picks"])) for k, r in reps.items()}, flush=True)
    common = sorted(set.intersection(*(set(r["picks"]) for r in reps.values())))
    test = [d for d in common if d >= T_START]
    L = ["# BL-185 — Adaptive over two-session winners (test year)", ""]
    L.append(
        f"Test days {test[0]} → {test[-1]} ({len(test)}); pools: "
        + ", ".join(f"{k} {len(pools[k])} variants" for k in reps)
        + f"; {N_PICK} picks per pool; per margin lot-day = book / {N_PICK}; list C's composite on gross; net after ₹13 an order, ₹5 and ₹20 beside."
    )
    L.append("")
    arms = {
        "A0 T1 Adaptive as traded": [("A0", None)],
        "A1 whole-day winners (control)": [("A1", None)],
        "A2 split: 3 morning + 3 afternoon": [("AM", None), ("PM", None)],
        "A3 afternoon-only: 3 picks": [("PM", None)],
    }
    daily = {}
    for name, parts_ in arms.items():
        g = sum(book(pools[k], reps[k], 0, test) for k, _ in parts_) / N_PICK
        n = sum(book(pools[k], reps[k], 1, test) for k, _ in parts_) / N_PICK
        o = sum(book(pools[k], reps[k], 2, test) for k, _ in parts_) / N_PICK
        daily[name] = {
            "gross": g,
            "net": n,
            "net5": n + (13.0 - 5.0) * o * GST,
            "net20": n + (13.0 - 20.0) * o * GST,
        }
    L.append(
        "| Arm | Net / margin lot-day | Gross | Net at ₹5 | Net at ₹20 | Days in profit | Max DD (net) | Total net |"
    )
    L.append("|---|---|---|---|---|---|---|---|")
    for name, d in daily.items():
        L.append(
            f"| {name} | {fmt(d['net'].mean())} | {fmt(d['gross'].mean())} | {fmt(d['net5'].mean())} | {fmt(d['net20'].mean())} | {100 * (d['net'] > 0).mean():.0f} % | {fmt(max_drawdown(d['net']))} | {fmt(d['net'].sum())} |"
        )
    L.append("")
    keys = list(daily)
    a0n, a1n, a2n, a3n = (daily[k] for k in keys)
    verdicts = {}
    for label, x, y in (
        ("A2 − A0", a2n, a0n),
        ("A2 − A1", a2n, a1n),
        ("A3 − A0", a3n, a0n),
        ("A1 − A0", a1n, a0n),
    ):
        row = []
        for f in ("net", "gross", "net5", "net20"):
            m, lo, hi = block_bootstrap_mean(x[f] - y[f], seed=SEED)
            row.append((m, lo, hi))
        verdicts[label] = row
        L.append(
            f"**{label}** per margin lot-day: net {fmt(row[0][0])} [{fmt(row[0][1])}, {fmt(row[0][2])}]; gross {fmt(row[1][0])} [{fmt(row[1][1])}, {fmt(row[1][2])}]; ₹5 {fmt(row[2][0])} [{fmt(row[2][1])}, {fmt(row[2][2])}]; ₹20 {fmt(row[3][0])} [{fmt(row[3][1])}, {fmt(row[3][2])}]."
        )
    dd2, dd0 = max_drawdown(a2n["net"]), max_drawdown(a0n["net"])
    passed = verdicts["A2 − A0"][0][1] > 0 and verdicts["A2 − A1"][0][1] > 0 and dd2 >= dd0
    L.append("")
    L.append(
        f"A2 max drawdown {fmt(dd2)} vs A0 {fmt(dd0)}. **Verdict (A2 passes if both lower bounds are above zero and its drawdown is no deeper): {'PASS' if passed else 'FAIL'}**"
    )
    L.append("")
    L.append("| Half-year | Test days | A0 net | A1 net | A2 net | A3 net |")
    L.append("|---|---|---|---|---|---|")
    hy = np.array([f"{d.year} H{1 if d.month <= 6 else 2}" for d in test])
    for h in sorted(set(hy)):
        m = hy == h
        L.append(
            f"| {h} | {m.sum()} | " + " | ".join(fmt(daily[k]["net"][m].sum()) for k in keys) + " |"
        )
    L.append("")
    L.append("What the arms picked (share of picks):")
    for k in reps:
        c = Counter()
        for d in test:
            for v in reps[k]["picks"][d]:
                nm = reps[k]["names"][v]
                c[nm.split("_")[1].split("-")[0] + ("" if "-t1s" not in nm else " (T1)")] += 1
        tot = sum(c.values())
        L.append(f"- {k}: " + ", ".join(f"{a} {100 * b / tot:.0f} %" for a, b in c.most_common(6)))
    text = "\n".join(L) + "\n"
    (out / "replay_summary.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
