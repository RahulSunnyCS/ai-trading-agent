"""BL-190: a pick finished (stopped out, no entry left) by 12:15 is replaced by the strongest later
Widesl or Dir (backlog/BL-190 Phase 0), on the seen set (A0) and the clean set (N22).

    BL187_A0=<A0 folder> uv run python research/bl190/run.py
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import books as bk  # noqa: E402

from option_backtesting.legwise.market import minute_index, minute_label  # noqa: E402
from option_backtesting.rotation.score import is_dir, is_wide  # noqa: E402

OUT = HERE / "out"
GAP = 2
WINDOWS = {"12": minute_index("12:15"), "11": minute_index("11:15")}
STOP_REASONS = {"SL", "TRAIL", "TARGET", "SQUARE_OFF"}
KINDS = {"W": is_wide, "D": is_dir}


def finished_at(strat, r) -> tuple[int | None, str]:
    """The minute the pick is finished and why, from its own trades (no look-ahead: an overall
    stop, or every leg stopped as many times as it can enter), else (None, '')."""
    if not r.trades:
        return None, ""
    if r.stopped_by and r.stopped_by.startswith("overall"):
        why = "overall target" if "target" in r.stopped_by else "overall stop"
        return max(t.exit_min for t in r.trades), why
    last = 0
    for leg in strat.legs:
        allowed = 1 + (leg.reentry_on_sl.count if leg.reentry_on_sl else 0)
        ts = [t for t in r.trades if t.leg_id == leg.id]
        if len(ts) < allowed or any(t.exit_reason not in STOP_REASONS for t in ts):
            return None, ""
        last = max(last, max(t.exit_min for t in ts))
    return last, "legs stopped"


def finishes(book) -> tuple[dict, str]:
    """{(day, pick name): (minute, reason)} for every pick, plus the parity gate's line."""
    jobs = {(book["names"][v], None, d) for d in book["days"] for v in book["picks"][d]}
    res = bk.run_jobs(jobs)
    bad, worst = 0, 0.0
    out = {}
    for (n, _, d), (r, _ch, o) in res.items():
        g = bk.row(book, n, d)
        diff = abs(r.gross - g[0])
        worst = max(worst, diff)
        if diff > 1.0 or o != g[2]:
            bad += 1
        out[(d, n)] = finished_at(bk.strategy(n), r)
    line = (f"Parity: {len(res)} picks re-simulated, {len(res) - bad} equal to the stored row "
            f"(gross within ₹1, orders equal); largest gross difference ₹{worst:.2f}. "
            f"{'PASS' if bad == 0 else 'FAIL'}")  # fmt: skip
    if bad:
        print(line)
        raise SystemExit("parity gate failed")
    return out, line


def arms(book, fin):
    names, days = book["names"], book["days"]
    keys = ["B", "RW12", "RD12", "RF12", "RW11", "RD11", "PW12", "PD12"]
    V = {k: np.zeros((len(days), 3)) for k in keys}
    nrep = {k: np.zeros(len(days)) for k in keys}
    log = {k: [] for k in keys}  # (day, stopped pick, minute, reason, replacement)
    for i, d in enumerate(days):
        picks = book["picks"][d]
        base = sum(bk.row(book, names[v], d) for v in picks)
        comp = book["comp"][d]
        done = sorted(
            ((fin[(d, names[v])][0], names[v], fin[(d, names[v])][1]) for v in picks
             if fin[(d, names[v])][0] is not None),
        )  # fmt: skip
        for k in keys:
            V[k][i] = base
            if k == "B":
                continue
            kind, win = k[1], k[2:]
            used = {names[v] for v in picks}
            for t, n, why in done:
                if t > WINDOWS[win]:
                    continue
                want = ("W" if is_wide(n) else "D") if kind == "F" else kind
                elig = [v for v, m in enumerate(names) if KINDS[want](m) and m not in used
                        and bk.slot_index(m) >= t + GAP]  # fmt: skip
                if not elig:
                    continue
                if k[0] == "P":
                    V[k][i] += np.mean([bk.row(book, names[v], d) for v in elig], axis=0)
                    nrep[k][i] += 1
                    log[k].append((d, n, t, why, None))
                    continue
                s = min(elig, key=lambda v: (-comp[v], names[v]))
                used.add(names[s])
                V[k][i] += bk.row(book, names[s], d)
                nrep[k][i] += 1
                log[k].append((d, n, t, why, names[s]))
    return {k: v / bk.MARGIN_LOTS for k, v in V.items()}, nrep, log


def net(v, nrep=None, extra=0.0):
    n = v[:, 1] - (extra * nrep / bk.MARGIN_LOTS if nrep is not None else 0)
    return n


def report(label, book, st, fin, gate):
    days = book["days"]
    V, nrep, log = arms(book, fin)
    p1 = bk.periods(days, st["split"])
    B = V["B"]
    L = [f"## {label}", "", gate, "",
         f"Pick days {days[0]} → {days[-1]} ({len(days)}). Per margin lot-day = book ÷ 3.", ""]  # fmt: skip
    nf = Counter()
    for (_d, n), (t, why) in fin.items():
        if t is not None and t <= WINDOWS["12"]:
            nf[("Widesl" if is_wide(n) else "Dir", why)] += 1
    L.append("Picks finished by 12:15: " + ", ".join(f"{a} by {b} {c}" for (a, b), c in sorted(nf.items()))
             + f" (of {sum(len(book['picks'][d]) for d in days)} picks).")  # fmt: skip
    L += ["", "| Arm | Net | Gross | Replacements | Max DD (net) | Arm − B net (90 %) | 95 % | First period | Second period | +₹100 / repl. | +₹300 / repl. |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]  # fmt: skip
    res = {}
    for k, v in V.items():
        if k == "B":
            L.append(f"| B | {bk.fmt(v[:, 1].mean())} | {bk.fmt(v[:, 0].mean())} | 0 | "
                     f"{bk.fmt(bk.max_drawdown(v[:, 1]))} | | | | | | |")  # fmt: skip
            continue
        diff = v[:, 1] - B[:, 1]
        L.append(
            f"| {k} | {bk.fmt(v[:, 1].mean())} | {bk.fmt(v[:, 0].mean())} | {int(nrep[k].sum())} | "
            f"{bk.fmt(bk.max_drawdown(v[:, 1]))} | {bk.ftxt(diff)} | {bk.ftxt(diff, 0.95)} | "
            f"{bk.fmt(diff[p1].mean())} | {bk.fmt(diff[~p1].mean())} | "
            f"{bk.ftxt(net(v, nrep[k], 100) - B[:, 1])} | {bk.ftxt(net(v, nrep[k], 300) - B[:, 1])} |"
        )
        res[k] = {
            "diff": diff,
            "dd": bk.max_drawdown(v[:, 1]),
            "d100": net(v, nrep[k], 100) - B[:, 1],
        }
    res["B_dd"] = bk.max_drawdown(B[:, 1])
    L.append("")
    for k in ("RW12", "RD12"):
        if not log[k]:
            continue
        rep = [x for x in log[k] if x[4]]
        stopped = np.array([bk.row(book, n, d)[1] for d, n, *_ in rep])
        repl = np.array([bk.row(book, x[4], x[0])[1] for x in rep])
        tm = Counter(minute_label(t)[:2] + ":00" for _, _, t, _, _ in rep)
        L.append(f"{k}: {len(rep)} replacements; the stopped pick's day net {bk.fmt(stopped.mean())} a lot, "
                 f"the replacement's {bk.fmt(repl.mean())} (in profit {np.mean(repl > 0):.0%}); "
                 "stop hour " + ", ".join(f"{a} {b}" for a, b in sorted(tm.items())) + "; replacement slot "
                 + ", ".join(f"{a} {b}" for a, b in Counter(bk.slot_of(x[4]) for x in rep).most_common(5)) + ".")  # fmt: skip
    L.append("")
    return L, res


def main() -> None:
    OUT.mkdir(exist_ok=True)
    L = ["# BL-190 — replace a pick stopped out by 12:15", ""]
    res = {}
    for which in ("seen", "clean"):
        bs, st = bk.books(which)
        for label, book in bs.items():
            fin, gate = finishes(book)
            print(f"{which} {label}: {gate}", flush=True)
            lines, r = report(f"{label} ({which} set)", book, st, fin, gate)
            L += lines
            res[label] = r
    for k in ("RW12", "RD12"):
        s, c = res["T1"][k], res["T1-N"][k]
        m, lo, hi = bk.interval(s["diff"], 0.95)
        a, b = lo > 0, c["diff"].mean() > 0
        cc = s["dd"] >= res["T1"]["B_dd"]
        d = s["d100"].mean() > 0
        L.append(f"**Pass rule ({k}):** (a) seen-set T1 95 % lower bound above zero: {a} ({bk.fmt(m)} "
                 f"[{bk.fmt(lo)}, {bk.fmt(hi)}]); (b) clean-set T1-N above zero: {b} "
                 f"({bk.fmt(c['diff'].mean())}); (c) seen drawdown no deeper: {cc} ({bk.fmt(s['dd'])} vs "
                 f"{bk.fmt(res['T1']['B_dd'])}); (d) above zero with ₹100 a replacement: {d} "
                 f"({bk.fmt(s['d100'].mean())}). **{'PASS' if a and b and cc and d else 'FAIL'}**")  # fmt: skip
        L.append("")
    (OUT / "summary.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
