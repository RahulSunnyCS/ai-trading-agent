"""BL-187: cut the picked Dir two minutes before the strongest late Widesl and run that Widesl in its
place (rule and arms: backlog/BL-187 Phase 0).

    BL187_A0=<A0 csv folder> uv run python research/bl187/run.py [--jobs-only | --gates-only]

Reads BL-185's A0 (Core-298 + T1 re-simulated with charges: one CSV a variant, git-ignored;
regenerate with `uv run python research/common/two_session/a0.py`, or point BL187_A0 at an existing folder), replays list C's
picks and composite per book, simulates the picked Dir with `exit_time` moved to each possible cut
(only on the days it was picked; resumable, out/dir_cuts.csv), runs the parity gates, then the arms.
"""

from __future__ import annotations

import csv
import functools
import os
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
sys.path.insert(0, str(HERE.parent / "common" / "two_session"))
sys.path.insert(0, str(HERE))
import replay as rp  # noqa: E402
import split_replay as sr  # noqa: E402
import swap  # noqa: E402
from early_ref import early_reference  # noqa: E402

from option_backtesting.data.reference.loader import MissingReferenceData  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import LISTS, WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.score import (  # noqa: E402
    composite,
    dte_matrix,
    family_index,
    is_dir,
    is_wide,
    select,
)
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

A0 = Path(os.environ.get("BL187_A0") or HERE.parent / "bl185" / "a0")
OUT, VAR = HERE / "out", HERE / "variants"
SEED, GST, MARGIN_LOTS = 20261028, 1.18, 3
P1_END = date(2025, 10, 8)
CUTS = sorted({swap.slot_min(s) - swap.CUT_GAP for s in swap.LATE_SLOTS})
DIR_CUTS_CSV = OUT / "dir_cuts.csv"
FIELDS = ["name", "cut", "day", "gross", "charges", "net", "orders"]


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def underlying_of(name: str) -> str:
    return "NIFTY" if name.startswith("N_") else "SENSEX"


# --- picks and rankings ---------------------------------------------------------------------


def rank_book(pool, attrs, days_all):
    """Same replay as BL-185's A0 (list C's composite on gross, select), keeping the composite."""
    days = sorted(set.intersection(*(set(s.rows) for s in pool)) & set(attrs) & set(days_all))
    days = [d for d in days if d.weekday() < 5]
    names = [s.name for s in pool]
    G = np.array([[s.rows[d][0] for s in pool] for d in days])
    wd = np.array([attrs[d]["weekday"] for d in days])
    bd = np.array([attrs[d]["vix_band"] for d in days])
    dn = np.array([attrs[d]["dte_n"] for d in days])
    ds = np.array([attrs[d]["dte_s"] for d in days])
    fam = family_index(names)
    comps, picks = {}, {}
    for i in range(WARMUP, len(days)):
        comp = composite(
            G[: i + 1], wd[: i + 1], bd[: i + 1], dte_matrix(dn[: i + 1], ds[: i + 1], names),
            names, LISTS["C"], fam,
        )  # fmt: skip
        p = select(comp, names)
        comps[days[i]] = comp
        picks[days[i]] = [names.index(n) for n in p.core]
    return {"days": days, "names": names, "comp": comps, "picks": picks}


def dir_file(name: str) -> Path:
    p = sr.ROTATION / f"{name}.yaml"
    return p if p.exists() else sr.ROTATION.parent / "rotation_t1" / f"{name}.yaml"


@functools.cache
def dir_entry(name: str) -> int:
    h, m = yaml.safe_load(dir_file(name).read_text())["strategy"]["entry_time"].split(":")
    return int(h) * 60 + int(m)


def cut_file(name: str, cut: int) -> Path:
    VAR.mkdir(exist_ok=True, parents=True)
    label = swap.cut_label(cut).replace(":", "")
    path = VAR / f"{name}-cut{label}.yaml"
    if not path.exists():
        doc = yaml.safe_load(dir_file(name).read_text())
        doc["strategy"]["id"] = f"{name}-cut{label}"
        doc["strategy"]["exit_time"] = swap.cut_label(cut)
        path.write_text(
            f"# bl187: {dir_file(name).name} with exit_time moved to {swap.cut_label(cut)}\n"
            + yaml.safe_dump(doc, sort_keys=False)
        )
        load_legwise(path)
    return path


# --- Dir cut simulations --------------------------------------------------------------------


def needed_jobs(books: dict) -> set[tuple[str, int | None, date]]:
    """(Dir name, cut minute, day) for every picked Dir at every cut after its own entry."""
    jobs = set()
    for rep in books.values():
        for d, p in rep["picks"].items():
            for v in p:
                n = rep["names"][v]
                if is_dir(n):
                    for c in CUTS:
                        if dir_entry(n) < c:
                            jobs.add((n, c, d))
    return jobs


def read_cuts() -> dict[tuple[str, int | None, date], tuple[float, float, float, int]]:
    out = {}
    if DIR_CUTS_CSV.exists():
        with open(DIR_CUTS_CSV) as f:
            for r in csv.DictReader(f):
                cut = int(r["cut"]) if r["cut"] else None
                out[(r["name"], cut, date.fromisoformat(r["day"]))] = (
                    float(r["gross"]), float(r["charges"]), float(r["net"]), int(r["orders"])
                )  # fmt: skip
    return out


def simulate_cuts(jobs: set[tuple[str, int | None, date]]) -> None:
    done = read_cuts()
    todo = sorted((j for j in jobs if j not in done), key=lambda j: (j[2], j[0], j[1] or 0))
    print(f"Dir cut runs: {len(jobs)} needed, {len(todo)} to do", flush=True)
    if not todo:
        return
    OUT.mkdir(exist_ok=True)
    root, ref = data_dir(), early_reference()
    strat: dict[tuple[str, int | None], object] = {}
    new = not DIR_CUTS_CSV.exists()
    t0, last_day, data = time.time(), None, {}
    skipped: list = []
    with open(DIR_CUTS_CSV, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(FIELDS)
        for i, (name, cut, d) in enumerate(todo):
            if d != last_day:
                data = {}
                last_day = d
            u = underlying_of(name)
            if u not in data:
                data[u] = load_day(root, u, d)
            key = (name, cut)
            if key not in strat:
                strat[key] = load_legwise(dir_file(name) if cut is None else cut_file(name, cut))
            try:
                r = simulate_day(strat[key], data[u], ref, sr.SIZING)
            except MissingReferenceData:
                skipped.append((name, cut, d))
                continue
            orders, buy, sell = trade_values(r.trades)
            ch = day_charges(u, d.isoformat(), orders, buy, sell).total
            w.writerow([name, "" if cut is None else cut, d, round(r.gross, 2), round(ch, 2),
                        round(r.gross - ch, 2), orders])  # fmt: skip
            if (i + 1) % 200 == 0:
                f.flush()
                print(f"  {i + 1}/{len(todo)}, {time.time() - t0:.0f} s", flush=True)
    if skipped:
        print(f"  {len(skipped)} runs skipped for missing reference data, e.g. {skipped[:3]}")


# --- parity gates ---------------------------------------------------------------------------


def run_gates(a0: dict[str, rp.Series], books: dict) -> list[str]:
    """(1) the Dir at its original exit reproduces A0; (2) a cut run is identical to the original
    run before the cut; (3) charges come from the run's own trades (by construction, shown)."""
    L = ["## Parity gates", ""]
    ok = True
    root, ref = data_dir(), early_reference()
    t1 = books["t1"]
    sample = []
    for d, p in sorted(t1["picks"].items()):
        for v in p:
            if is_dir(t1["names"][v]):
                sample.append((t1["names"][v], d))
    step = max(1, len(sample) // 40)
    g1 = sample[::step][:40]
    bad1, worst1 = 0, 0.0
    data_cache: dict = {}
    for name, d in g1:
        u = underlying_of(name)
        if (u, d) not in data_cache:
            data_cache.clear()
            data_cache[(u, d)] = load_day(root, u, d)
        r = simulate_day(load_legwise(dir_file(name)), data_cache[(u, d)], ref, sr.SIZING)
        orders, buy, sell = trade_values(r.trades)
        row = a0[name].rows[d]
        diff = abs(r.gross - row[0])
        worst1 = max(worst1, diff)
        if diff > 1.0 or orders != row[2]:
            bad1 += 1
    ok &= bad1 == 0
    L.append(
        f"1. Original exit, {len(g1)} sampled Dir picks: gross and orders equal to A0 on "
        f"{len(g1) - bad1}; largest gross difference Rs {worst1:.2f}. {'PASS' if bad1 == 0 else 'FAIL'}"
    )
    worst2, tail, bad2, n2 = 0.0, [], 0, 0
    for cut in CUTS:
        early = [(n, d) for n, d in sample if dir_entry(n) < cut]
        for name, d in early[:: max(1, len(early) // 5)][:5]:
            n2 += 1
            u = underlying_of(name)
            data = load_day(root, u, d)
            orig = simulate_day(load_legwise(dir_file(name)), data, ref, sr.SIZING)
            cutr = simulate_day(load_legwise(cut_file(name, cut)), data, ref, sr.SIZING)
            n = len(cutr.mtm)
            a = np.array([x[1] for x in orig.mtm[:n]])
            b = np.array([x[1] for x in cutr.mtm[:n]])
            m = min(len(a), len(b))
            dd = float(np.abs(a[:m] - b[:m]).max()) if m else 0.0
            worst2 = max(worst2, dd)
            if dd > 1e-6:
                bad2 += 1
            if len(a) >= n and n:
                tail.append(cutr.gross - float(a[n - 1]))
    ok &= bad2 == 0
    tail_txt = (
        f"mean Rs {np.mean(tail):+.1f}, largest {max(tail, key=abs):+.1f}" if tail else "no days"
    )
    L.append(
        f"2. Each of the {len(CUTS)} cuts, {n2} sampled runs in all: MTM curves identical before the "
        f"cut on {n2 - bad2}; largest difference Rs {worst2:.4f}. The cut run's gross minus the "
        f"original curve's last bar before the cut: {tail_txt} "
        f"(the exit fills at the previous bar's close, BL-009). {'PASS' if bad2 == 0 else 'FAIL'}"
    )
    L.append(
        "3. Charges: a cut Dir's charges come from `day_charges` on its own trades; "
        "the added Widesl's row is A0's, unchanged. PASS"
    )
    L.append("")
    L.append(f"**Gates: {'all pass' if ok else 'FAILED'}**")
    L.append("")
    if not ok:
        print("\n".join(L))
        raise SystemExit("parity gate failed; nothing else is read")
    return L


# --- the arms -------------------------------------------------------------------------------


def book_arms(pool, rep, cuts) -> dict:
    names = rep["names"]
    days = sorted(rep["picks"])
    series = {s.name: s for s in pool}

    def row(n, d):  # (gross, net, orders)
        r = series[n].rows[d]
        return np.array([r[0], r[1], r[2]], dtype=float)

    def cut_row(n, c, d):
        if (n, c, d) not in cuts:
            raise SystemExit(
                f"no Dir cut run for {n} cut {swap.cut_label(c)} on {d} (skipped for missing data?)"
            )
        g, _ch, net, o = cuts[(n, c, d)]
        return np.array([g, net, o], dtype=float)

    base = {d: sum(row(names[v], d) for v in rep["picks"][d]) for d in days}
    arms: dict[str, dict] = {}

    def new(name):
        arms[name] = {"v": np.zeros((len(days), 3)), "swap": np.zeros(len(days), bool),
                      "S": [None] * len(days), "dir": [None] * len(days),
                      "added": np.zeros(len(days), bool)}  # fmt: skip
        return arms[name]

    for arm in ("B", "R14", "R1430", "R1500", "F1400", "F1430", "F1500", "X14", "P14",
                "R14_no1447"):  # fmt: skip
        new(arm)
    for i, d in enumerate(days):
        picks = set(rep["picks"][d])
        dirs = [v for v in picks if is_dir(names[v])]
        for arm in arms.values():
            arm["v"][i] = base[d]
        if not dirs:
            continue
        assert len(dirs) == 1, (d, [names[v] for v in dirs])
        D = names[dirs[0]]
        e = dir_entry(D)
        comp = rep["comp"][d]
        orig = row(D, d)

        def swapped(S, arm_name, add_widesl=True, D=D, e=e, d=d, i=i, orig=orig):
            c = swap.swap_for(e, names[S])
            if c is None:
                return
            v = base[d] - orig + cut_row(D, c, d) + (row(names[S], d) if add_widesl else 0)
            arms[arm_name]["v"][i] = v
            arms[arm_name]["swap"][i] = True
            arms[arm_name]["added"][i] = add_widesl
            arms[arm_name]["S"][i] = names[S]
            arms[arm_name]["dir"][i] = D

        for arm_name, t in (("R14", "1402"), ("R1430", "1432"), ("R1500", "1502")):
            lst = swap.ranked_late_widesl(names, comp, picks, is_wide, swap.slot_min(t))
            if lst:
                swapped(lst[0], arm_name)
        lst = swap.ranked_late_widesl(names, comp, picks, is_wide, swap.slot_min("1402"),
                                      exclude_slots=("1447",))  # fmt: skip
        if lst:
            swapped(lst[0], "R14_no1447")
        for arm_name, slot in (("F1400", "1402"), ("F1430", "1432"), ("F1500", "1502")):
            lst = swap.ranked_late_widesl(names, comp, picks, is_wide, swap.slot_min(slot),
                                          only_slot=slot)  # fmt: skip
            if lst:
                swapped(lst[0], arm_name)
        lst = swap.ranked_late_widesl(names, comp, picks, is_wide, swap.slot_min("1402"))
        if lst:
            swapped(lst[0], "X14", add_widesl=False)
            # placebo: the average over every eligible Widesl of the swapped day (or the day as
            # picked where that Widesl's cut is not after the Dir's entry)
            vals = []
            for S in lst:
                c = swap.swap_for(e, names[S])
                vals.append(
                    base[d] if c is None
                    else base[d] - orig + cut_row(D, c, d) + row(names[S], d)
                )  # fmt: skip
            arms["P14"]["v"][i] = np.mean(vals, axis=0)
            arms["P14"]["swap"][i] = any(swap.swap_for(e, names[S]) is not None for S in lst)
    for a in arms.values():
        a["v"] = a["v"] / MARGIN_LOTS
    return {"days": days, "arms": arms}


def daily(a: dict, extra_cost: float = 0.0) -> dict:
    g, n, o = a["v"][:, 0], a["v"][:, 1], a["v"][:, 2]
    n = n - extra_cost * a["added"] / MARGIN_LOTS  # only where a Widesl was added
    return {"gross": g, "net": n, "net5": n + (13.0 - 5.0) * o * GST,
            "net20": n + (13.0 - 20.0) * o * GST}  # fmt: skip


def interval(x: np.ndarray) -> str:
    m, lo, hi = block_bootstrap_mean(x, seed=SEED)
    return f"{fmt(m)} [{fmt(lo)}, {fmt(hi)}]"


def report_book(label: str, res: dict, attrs: dict) -> tuple[list[str], dict]:
    days, arms = res["days"], res["arms"]
    D = {k: daily(a) for k, a in arms.items()}
    p1 = np.array([d <= P1_END for d in days])
    L = [f"## {label} book", ""]
    L.append(
        f"Pick days {days[0]} → {days[-1]} ({len(days)}); periods: {int(p1.sum())} days to "
        f"{P1_END} and {int((~p1).sum())} after. Per margin lot-day = book ÷ {MARGIN_LOTS}. "
        "Net after ₹13 an order; ₹5 and ₹20 beside. Swap days = days the arm changed the book."
    )
    L.append("")
    L.append(
        "| Arm | Net / margin lot-day | Gross | Net at ₹5 | Net at ₹20 | Swap days | Max DD (net) | Total net |"
    )
    L.append("|---|---|---|---|---|---|---|---|")
    for k, d in D.items():
        L.append(
            f"| {k} | {fmt(d['net'].mean())} | {fmt(d['gross'].mean())} | {fmt(d['net5'].mean())} | "
            f"{fmt(d['net20'].mean())} | {int(arms[k]['swap'].sum())} | {fmt(max_drawdown(d['net']))} | "
            f"{fmt(d['net'].sum())} |"
        )
    L.append("")
    L.append(
        "Difference to B per margin lot-day, 90 % block bootstrap (all days; first period; second period):"
    )
    L.append("")
    L.append(
        "| Arm − B | All days: net | gross | ₹5 | ₹20 | First period net | Second period net |"
    )
    L.append("|---|---|---|---|---|---|---|")
    for k in D:
        if k == "B":
            continue
        L.append(
            f"| {k} | {interval(D[k]['net'] - D['B']['net'])} | {interval(D[k]['gross'] - D['B']['gross'])} | "
            f"{interval(D[k]['net5'] - D['B']['net5'])} | {interval(D[k]['net20'] - D['B']['net20'])} | "
            f"{interval((D[k]['net'] - D['B']['net'])[p1])} | {interval((D[k]['net'] - D['B']['net'])[~p1])} |"
        )
    L.append("")
    # decomposition and ranking placebo
    L.append(
        f"Decomposition (all days, net per margin lot-day): the Dir's last hour alone (X14 − B) "
        f"{interval(D['X14']['net'] - D['B']['net'])}; the strongest Widesl added (R14 − X14) "
        f"{interval(D['R14']['net'] - D['X14']['net'])}; ranking against a random eligible Widesl "
        f"(R14 − P14) {interval(D['R14']['net'] - D['P14']['net'])}."
    )
    L.append("")
    # late-fill allowance
    for extra in (100, 300):
        Dx = daily(arms["R14"], extra)
        L.append(
            f"R14 − B with Rs {extra} added per swapped-in Widesl: {interval(Dx['net'] - D['B']['net'])}."
        )
    L.append("")
    sw = arms["R14"]["swap"]
    if sw.any():
        L.append(
            f"R14 swapped on {int(sw.sum())} of {len(days)} days; per swap day (net per margin lot-day): "
            f"B {fmt(D['B']['net'][sw].mean())}, R14 {fmt(D['R14']['net'][sw].mean())}, "
            f"X14 {fmt(D['X14']['net'][sw].mean())}."
        )
        S = Counter(swap.slot_of(s) for s in np.array(arms["R14"]["S"], dtype=object)[sw])
        L.append("Strongest Widesl's slot: " + ", ".join(f"{k} {v}" for k, v in sorted(S.items())))
        fam = Counter(
            s.split("_")[0] + "_" + s.split("_")[1].split("-")[0]
            for s in np.array(arms["R14"]["S"], dtype=object)[sw]
        )
        L.append("by family: " + ", ".join(f"{k} {v}" for k, v in fam.most_common(8)))
        L.append("")
        # expiry split: the Dir's own index expires that day
        idx = np.array([underlying_of(x) if x else "" for x in arms["R14"]["dir"]])
        exp = np.array([
            bool(x) and attrs[d]["dte_n" if underlying_of(x) == "NIFTY" else "dte_s"] == "0"
            for x, d in zip(arms["R14"]["dir"], days, strict=True)
        ])  # fmt: skip
        L.append(
            "R14 − B by the Dir's own index and whether it expires that day (per margin lot-day over the subset's swap days):"
        )
        L.append("")
        L.append("| Subset | Swap days | R14 − B net | X14 − B net |")
        L.append("|---|---|---|---|")
        for lab, m in (
            ("expiry day", sw & exp), ("not an expiry day", sw & ~exp),
            ("NIFTY Dir", sw & (idx == "NIFTY")), ("SENSEX Dir", sw & (idx == "SENSEX")),
        ):  # fmt: skip
            if m.any():
                L.append(
                    f"| {lab} | {int(m.sum())} | "
                    f"{fmt((D['R14']['net'] - D['B']['net'])[m].mean())} | "
                    f"{fmt((D['X14']['net'] - D['B']['net'])[m].mean())} |"
                )
        L.append("")
    hy = np.array([sr.half_year(d) for d in days])
    L.append("| Half-year | Pick days | B net | R14 net | R14 − B (per margin lot-day, sum) |")
    L.append("|---|---|---|---|---|")
    for h in sorted(set(hy)):
        m = hy == h
        L.append(
            f"| {h} | {int(m.sum())} | {fmt(D['B']['net'][m].sum())} | {fmt(D['R14']['net'][m].sum())} | "
            f"{fmt((D['R14']['net'] - D['B']['net'])[m].sum())} |"
        )
    L.append("")
    diff = D["R14"]["net"] - D["B"]["net"]
    m, lo, hi = block_bootstrap_mean(diff, seed=SEED)
    a = lo > 0
    b = diff[p1].mean() > 0 and diff[~p1].mean() > 0
    c = max_drawdown(D["R14"]["net"]) >= max_drawdown(D["B"]["net"])
    Dx = daily(arms["R14"], 300)
    d_ = (Dx["net"] - D["B"]["net"]).mean() > 0
    verdict = {"a": a, "b": b, "c": c, "d": d_, "pass": a and b and c and d_}
    L.append(
        f"**Pass rule (R14, {label}):** (a) lower bound above zero: {a} ({fmt(m)} [{fmt(lo)}, {fmt(hi)}]); "
        f"(b) positive in both periods: {b} ({fmt(diff[p1].mean())}, {fmt(diff[~p1].mean())}); "
        f"(c) drawdown no deeper than B's: {c} (R14 {fmt(max_drawdown(D['R14']['net']))}, B "
        f"{fmt(max_drawdown(D['B']['net']))}); (d) still above zero with Rs 300 added: {d_}. "
        f"**{'PASS' if verdict['pass'] else 'FAIL'}**"
    )
    L.append("")
    return L, {"D": D, "verdict": verdict}


def main() -> None:
    args = sys.argv[1:]
    OUT.mkdir(exist_ok=True)
    attrs = store.read_days(data_dir(), "weekdays")
    days_all = sorted(attrs)
    a0 = rp.pool_from_csv(A0)
    if not a0:
        raise SystemExit(
            f"no A0 CSVs in {A0}: run research/common/two_session/a0.py (BL-185) or set BL187_A0"
        )
    pools = {"t1": a0, "core": [s for s in a0 if "-t1s" not in s.name]}
    books = {}
    for k, pool in pools.items():
        books[k] = rank_book(pool, attrs, days_all)
        ref = rp.replay(pool, attrs, days_all)  # BL-185's own replay: the picks must be identical
        assert ref["picks"] == books[k]["picks"], f"{k}: picks differ from BL-185's replay"
    print({k: (len(p), len(books[k]["picks"])) for k, p in pools.items()}, flush=True)
    simulate_cuts(needed_jobs(books))
    if "--jobs-only" in args:
        return
    cuts = read_cuts()
    a0_by = {s.name: s for s in a0}
    gates = run_gates(a0_by, books)
    (OUT / "gates.md").write_text("\n".join(gates))
    if "--gates-only" in args:
        print("\n".join(gates))
        return
    L = ["# BL-187 — cut the Dir, start the strongest late Widesl", ""] + gates
    for k in ("t1", "core"):
        res = book_arms(pools[k], books[k], cuts)
        lines, _ = report_book(k.upper() if k == "t1" else "Core", res, attrs)
        L += lines
        with open(OUT / f"daily_{k}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["day", *(f"{a}_net" for a in res["arms"])])
            for i, d in enumerate(res["days"]):
                w.writerow([d, *(round(float(a["v"][i, 1]), 2) for a in res["arms"].values())])
    (OUT / "summary.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


if __name__ == "__main__":
    main()
