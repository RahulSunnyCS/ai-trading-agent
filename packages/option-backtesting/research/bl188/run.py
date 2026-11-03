"""BL-188: the fixed 14:00 Dir cut with the strongest 14:02 Widesl (BL-187's F1400) on the clean
N22 set (backlog/BL-188 Phase 0), plus the seen set as a check that the code reproduces BL-187.

    BL187_A0=<A0 folder> uv run python research/bl188/run.py

Needs research/bl188/n22.py simulate + attrs + gates first.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import books as bk  # noqa: E402

from option_backtesting.legwise.market import minute_index, minute_label  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation.score import is_dir, is_wide  # noqa: E402

OUT, VAR = HERE / "out", HERE / "variants"
LATE = ("1402", "1417", "1432", "1447", "1502", "1517")
GAP = 2


def hhmm(i: int) -> str:
    return minute_label(i)


def cut_path(name: str, cut: int) -> Path:
    VAR.mkdir(parents=True, exist_ok=True)
    lab = hhmm(cut)
    p = VAR / f"{name}-cut{lab.replace(':', '')}.yaml"
    if not p.exists():
        doc = yaml.safe_load(bk.strategy_file(name).read_text())
        doc["strategy"]["id"] = f"{name}-cut{lab.replace(':', '')}"
        doc["strategy"]["exit_time"] = lab
        p.write_text(f"# bl188: {bk.strategy_file(name).name} with exit_time {lab}\n"
                     + yaml.safe_dump(doc, sort_keys=False))  # fmt: skip
        load_legwise(p)
    return p


def strongest(book, d, picks, slots):
    """Widesl variants in `slots`, not picked, by the morning composite, highest first."""
    names, comp = book["names"], book["comp"][d]
    c = [v for v, n in enumerate(names) if is_wide(n) and v not in picks and bk.slot_of(n) in slots]
    return sorted(c, key=lambda v: (-comp[v], names[v]))


def plan(book):
    """Per pick day: the Dir (or None), and per arm (cut minute, added Widesl or None)."""
    names = book["names"]
    out = {}
    for d in book["days"]:
        picks = set(book["picks"][d])
        dirs = [v for v in picks if is_dir(names[v])]
        p = {"dir": None}
        if dirs:
            D = names[dirs[0]]
            e = bk.slot_index(D)
            p["dir"] = D
            f = strongest(book, d, picks, ("1402",))
            if f and e < minute_index("14:00"):
                p["F1400"] = (minute_index("14:00"), names[f[0]])
            r = strongest(book, d, picks, LATE)
            if r:
                c = bk.slot_index(names[r[0]]) - GAP
                if e < c:
                    p["R14"] = (c, names[r[0]])
                    p["X14"] = (c, None)
        out[d] = p
    return out


def evaluate(book, plans, cuts):
    days = book["days"]
    arms = {k: np.zeros((len(days), 3)) for k in ("B", "F1400", "R14", "X14")}
    added = {k: np.zeros(len(days), bool) for k in arms}
    swapped = {k: np.zeros(len(days), bool) for k in arms}
    names = {k: [None] * len(days) for k in arms}
    for i, d in enumerate(days):
        base = sum(bk.row(book, book["names"][v], d) for v in book["picks"][d])
        for k in arms:
            arms[k][i] = base
        p = plans[d]
        for k in ("F1400", "R14", "X14"):
            if k not in p:
                continue
            c, S = p[k]
            r, ch, o = cuts[(p["dir"], c, d)]
            v = base - bk.row(book, p["dir"], d) + np.array([r.gross, r.gross - ch, o])
            if S:
                v = v + bk.row(book, S, d)
                added[k][i] = True
                names[k][i] = S
            arms[k][i] = v
            swapped[k][i] = True
    return {k: v / bk.MARGIN_LOTS for k, v in arms.items()}, added, swapped, names


def daily(v, added=None, extra=0.0):
    n = v[:, 1] - (extra * added / bk.MARGIN_LOTS if added is not None else 0)
    return {"gross": v[:, 0], "net": n, "net5": n + 8 * v[:, 2] * bk.GST,
            "net20": n - 7 * v[:, 2] * bk.GST}  # fmt: skip


def gate_cuts(book, plans, cuts) -> str:
    """BL-187's gates on 20 sampled Dir picks: the original exit reproduces the stored row; the
    14:00 cut curve is identical to the original before the cut."""
    sample = [(p["dir"], d) for d, p in sorted(plans.items()) if "F1400" in p]
    sample = sample[:: max(1, len(sample) // 20)][:20]
    orig = bk.run_jobs([(n, None, d) for n, d in sample])
    bad, worst = 0, 0.0
    for n, d in sample:
        r, _, o = orig[(n, None, d)]
        g = bk.row(book, n, d)
        if abs(r.gross - g[0]) > 1 or o != g[2]:
            bad += 1
        c = cuts[(n, minute_index("14:00"), d)][0]
        k = len(c.mtm) - 1  # the cut's own last bar books the previous close
        a = np.array([x[1] for x in r.mtm[:k]])
        b = np.array([x[1] for x in c.mtm[:k]])
        worst = max(worst, float(np.abs(a - b).max()) if k else 0.0)
    ok = bad == 0 and worst < 1e-6
    return (f"Cut gates, {len(sample)} sampled Dir picks: original exit equals the stored row on "
            f"{len(sample) - bad}; 14:00-cut MTM identical before the cut (largest difference "
            f"₹{worst:.4f}). {'PASS' if ok else 'FAIL'}"), ok  # fmt: skip


def report(label, book, split, arms, added, swapped, added_names, attrs):
    days = book["days"]
    p1 = bk.periods(days, split)
    D = {k: daily(v, added[k]) for k, v in arms.items()}
    L = [f"## {label}", "",
         f"Pick days {days[0]} → {days[-1]} ({len(days)}); first period {int(p1.sum())} days "
         f"(to {days[int(p1.sum()) - 1]}), second {int((~p1).sum())}. Per margin lot-day = book ÷ 3.",
         "", "| Arm | Net | Gross | Net at ₹5 | Net at ₹20 | Swap days | Max DD (net) |",
         "|---|---|---|---|---|---|---|"]  # fmt: skip
    for k, d in D.items():
        L.append(f"| {k} | {bk.fmt(d['net'].mean())} | {bk.fmt(d['gross'].mean())} | "
                 f"{bk.fmt(d['net5'].mean())} | {bk.fmt(d['net20'].mean())} | "
                 f"{int(swapped[k].sum())} | {bk.fmt(bk.max_drawdown(d['net']))} |")  # fmt: skip
    L += ["", "| Arm − B | Net | Gross | ₹5 | ₹20 | First period | Second period | +₹100 / Widesl | +₹300 / Widesl |",
          "|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
    for k in ("F1400", "R14", "X14"):
        diff = D[k]["net"] - D["B"]["net"]
        L.append(
            f"| {k} | {bk.ftxt(diff)} | {bk.ftxt(D[k]['gross'] - D['B']['gross'])} | "
            f"{bk.ftxt(D[k]['net5'] - D['B']['net5'])} | {bk.ftxt(D[k]['net20'] - D['B']['net20'])} | "
            f"{bk.fmt(diff[p1].mean())} | {bk.fmt(diff[~p1].mean())} | "
            f"{bk.ftxt(daily(arms[k], added[k], 100)['net'] - D['B']['net'])} | "
            f"{bk.ftxt(daily(arms[k], added[k], 300)['net'] - D['B']['net'])} |"
        )
    diff = D["F1400"]["net"] - D["B"]["net"]
    m, lo, hi = bk.interval(diff)
    a = lo > 0
    b = diff[p1].mean() > 0 and diff[~p1].mean() > 0
    c = bk.max_drawdown(D["F1400"]["net"]) >= bk.max_drawdown(D["B"]["net"])
    d300 = (daily(arms["F1400"], added["F1400"], 300)["net"] - D["B"]["net"]).mean() > 0
    exp = np.array([attrs[d]["dte_n"] == "0" for d in days])
    yr = np.array([d.year for d in days])
    L += ["", f"F1400 − B by subset (mean per margin lot-day over all days of the subset): "
          f"expiry days {bk.fmt(diff[exp].mean())} ({int(exp.sum())}), other days "
          f"{bk.fmt(diff[~exp].mean())}; "
          + "; ".join(f"{y} {bk.fmt(diff[yr == y].mean())} ({int((yr == y).sum())})" for y in sorted(set(yr)))
          + ".",
          "F1400's added Widesl by family: " + ", ".join(
              f"{k} {v}" for k, v in Counter(
                  n.rsplit("_", 1)[0] for n in added_names["F1400"] if n
              ).most_common(8)
          ) + ".",
          "",
          f"**Pass rule (F1400, {label}):** (a) lower bound above zero: {a} ({bk.fmt(m)} [{bk.fmt(lo)}, "
          f"{bk.fmt(hi)}]); (b) above zero in both periods: {b}; (c) drawdown no deeper than B's: {c} "
          f"({bk.fmt(bk.max_drawdown(D['F1400']['net']))} vs {bk.fmt(bk.max_drawdown(D['B']['net']))}); "
          f"(d) above zero with ₹300 a swapped-in Widesl: {d300}. **{'PASS' if a and b and c and d300 else 'FAIL'}**", ""]  # fmt: skip
    return L, {"pass": a and b and c and d300}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    L = ["# BL-188 — fixed 14:00 Dir cut with the strongest 14:02 Widesl", ""]
    for which in ("clean", "seen"):
        bs, st = bk.books(which)
        for label, book in bs.items():
            plans = plan(book)
            jobs = {
                (p["dir"], p[k][0], d)
                for d, p in plans.items()
                for k in ("F1400", "R14", "X14")
                if k in p
            }
            print(
                f"{which} {label}: {len(book['days'])} pick days, {len(jobs)} Dir cut runs",
                flush=True,
            )
            cuts = bk.run_jobs(jobs, path_of=cut_path)
            g, ok = gate_cuts(book, plans, cuts)
            print(g, flush=True)
            if not ok:
                raise SystemExit("cut gate failed")
            arms, added, swapped, added_names = evaluate(book, plans, cuts)
            lines, _ = report(
                f"{label} ({which} set)",
                book,
                st["split"],
                arms,
                added,
                swapped,
                added_names,
                st["attrs"],
            )
            L += [g, ""] + lines
            with open(OUT / f"daily_{label}.csv", "w") as f:
                f.write("day," + ",".join(f"{k}_net" for k in arms) + "\n")
                for i, d in enumerate(book["days"]):
                    f.write(f"{d}," + ",".join(f"{arms[k][i, 1]:.2f}" for k in arms) + "\n")
    (OUT / "summary.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
