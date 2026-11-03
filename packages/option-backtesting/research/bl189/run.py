"""BL-189: strictly two Widesl and one Dir every day (S21) against Adaptive as picked (B, at least
two Widesl), on the seen set (A0) and the clean set (N22) (backlog/BL-189 Phase 0).

    BL187_A0=<A0 folder> uv run python research/bl189/run.py
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import books as bk  # noqa: E402

from option_backtesting.rotation.score import is_dir, is_wide  # noqa: E402

OUT = HERE / "out"


def arms(book):
    names, days = book["names"], book["days"]
    B = np.zeros((len(days), 3))
    S = np.zeros((len(days), 3))
    three = np.zeros(len(days), bool)
    third, best_dir = [None] * len(days), [None] * len(days)
    for i, d in enumerate(days):
        picks = book["picks"][d]
        base = sum(bk.row(book, names[v], d) for v in picks)
        B[i] = S[i] = base
        if all(is_wide(names[v]) for v in picks):
            comp = book["comp"][d]
            low = min(picks, key=lambda v: (comp[v], names[v]))
            dirs = [v for v, n in enumerate(names) if is_dir(n)]
            top = sorted(dirs, key=lambda v: (-comp[v], names[v]))[0]
            S[i] = base - bk.row(book, names[low], d) + bk.row(book, names[top], d)
            three[i] = True
            third[i], best_dir[i] = names[low], names[top]
    return B / bk.MARGIN_LOTS, S / bk.MARGIN_LOTS, three, third, best_dir


def nets(v):
    return {"gross": v[:, 0], "net": v[:, 1], "net5": v[:, 1] + 8 * v[:, 2] * bk.GST,
            "net20": v[:, 1] - 7 * v[:, 2] * bk.GST}  # fmt: skip


def report(label, book, st):
    days = book["days"]
    Bv, Sv, three, third, bdir = arms(book)
    B, S = nets(Bv), nets(Sv)
    p1 = bk.periods(days, st["split"])
    diff = S["net"] - B["net"]
    attrs = st["attrs"]
    exp = np.array([attrs[d]["dte_n"] == "0" or attrs[d]["dte_s"] == "0" for d in days])
    band = np.array([attrs[d]["vix_band"] for d in days])
    L = [f"## {label}", "",
         f"Pick days {days[0]} → {days[-1]} ({len(days)}); three-Widesl days {int(three.sum())} "
         f"({three.mean():.0%}). Per margin lot-day = book ÷ 3, net after ₹13 an order.", "",
         "| Book | Net | Gross | Net at ₹5 | Net at ₹20 | Max DD (net) | Total net |",
         "|---|---|---|---|---|---|---|"]  # fmt: skip
    for k, x in (("B (at least two Widesl)", B), ("S21 (two Widesl + one Dir)", S)):
        L.append(f"| {k} | {bk.fmt(x['net'].mean())} | {bk.fmt(x['gross'].mean())} | "
                 f"{bk.fmt(x['net5'].mean())} | {bk.fmt(x['net20'].mean())} | "
                 f"{bk.fmt(bk.max_drawdown(x['net']))} | {bk.fmt(x['net'].sum())} |")  # fmt: skip
    L += ["",
          f"S21 − B per margin lot-day, all days: net {bk.ftxt(diff)}; gross "
          f"{bk.ftxt(S['gross'] - B['gross'])}; ₹5 {bk.ftxt(S['net5'] - B['net5'])}; ₹20 "
          f"{bk.ftxt(S['net20'] - B['net20'])}. First period {bk.fmt(diff[p1].mean())} "
          f"({int(p1.sum())} days), second {bk.fmt(diff[~p1].mean())} ({int((~p1).sum())}).", ""]  # fmt: skip
    if three.any():
        t = np.where(three)[0]
        th = np.array([bk.row(book, third[i], days[i])[1] for i in t])
        bd = np.array([bk.row(book, bdir[i], days[i])[1] for i in t])
        L += [f"On the {len(t)} three-Widesl days (₹ a lot, net): the third Widesl {bk.fmt(th.mean())} "
              f"a day (in profit {np.mean(th > 0):.0%}), the best Dir {bk.fmt(bd.mean())} "
              f"(in profit {np.mean(bd > 0):.0%}); best Dir − third Widesl {bk.fmt((bd - th).mean())} "
              f"a day, better on {np.mean(bd > th):.0%} of them.", "",
              "| Subset of three-Widesl days | Days | Best Dir − third Widesl (₹ a lot, net) |",
              "|---|---|---|"]  # fmt: skip
        for lab, m in (("expiry day (either index)", exp[t]), ("not an expiry day", ~exp[t])):
            if m.any():
                L.append(f"| {lab} | {int(m.sum())} | {bk.fmt((bd - th)[m].mean())} |")
        for b_ in sorted(set(band[t])):
            m = band[t] == b_
            L.append(f"| VIX {b_} | {int(m.sum())} | {bk.fmt((bd - th)[m].mean())} |")
        L += ["", "Best Dir's family: " + ", ".join(
            f"{k} {v}" for k, v in Counter(bdir[i].rsplit("_", 1)[0] for i in t).most_common(6)), ""]  # fmt: skip
    return L, {"diff": diff, "dd": (bk.max_drawdown(S["net"]), bk.max_drawdown(B["net"]))}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    L = ["# BL-189 — strictly two Widesl and one Dir, or at least two Widesl", ""]
    res = {}
    for which in ("seen", "clean"):
        bs, st = bk.books(which)
        for label, book in bs.items():
            lines, r = report(f"{label} ({which} set)", book, st)
            L += lines
            res[label] = r
    m, lo, hi = bk.interval(res["T1"]["diff"])
    a = lo > 0
    b = res["T1-N"]["diff"].mean() > 0
    c = res["T1"]["dd"][0] >= res["T1"]["dd"][1]
    L += [f"**Pass rule (adopt S21):** (a) seen-set T1 lower bound above zero: {a} ({bk.fmt(m)} "
          f"[{bk.fmt(lo)}, {bk.fmt(hi)}]); (b) clean-set T1-N above zero: {b} "
          f"({bk.fmt(res['T1-N']['diff'].mean())}); (c) seen-set drawdown no deeper: {c} "
          f"(S21 {bk.fmt(res['T1']['dd'][0])}, B {bk.fmt(res['T1']['dd'][1])}). "
          f"**{'ADOPT S21' if a and b and c else 'KEEP AS IT IS'}**", ""]  # fmt: skip
    (OUT / "summary.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
