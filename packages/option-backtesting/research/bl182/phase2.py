"""BL-182 Phase 2: Adaptive two-plus-two over Core's Widesl families against its top two whole-day.

    uv run python research/bl182/phase2.py [--smoke] [--analyse-only]

Pre-registered in backlog/BL-182-widesl-split-session.md (Phase 2, 2026-10-28, owner override)
before this ran. Pools: morning = Core's six Widesl families at the 11 slots 09:17-11:47 with the
exit moved to 12:00 (the Core slot file with only `exit_time` changed); afternoon = the same
families' Core files at 13:02-15:02 unchanged (they already exit 15:28); whole-day comparator =
the families' 25 Core files. Every variant is simulated here (run.simulate: engine, sizing and
charges as Phase 1), and the whole-day re-simulations are checked against the stored
rotation/results/ gross. List C's composite (score.composite, as the 09:16 job) ranks each pool on
gross; top two each. Books: split = 2 morning + 2 afternoon picks, comparator = 2 whole-day picks;
per margin lot-day = book net / 2. Writes variants2/, results2/<variant>.csv and out/phase2_*.
"""

from __future__ import annotations

import csv
import sys
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import run  # noqa: E402  (research/bl182/run.py: simulate, START, END, SIZING)

from option_backtesting.legwise.schema import load_legwise  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import LISTS, WARMUP  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.score import composite, dte_matrix, family_index  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402

VARIANTS = HERE / "variants2"
RESULTS = HERE / "results2"
OUT = HERE / "out"
ROTATION = run.STRATEGIES / "rotation"
FAMILIES = {"N_wide": "NIFTY", "N_p80": "NIFTY", "N_p100": "NIFTY",
            "S_wide": "SENSEX", "S_p250": "SENSEX", "S_p320": "SENSEX"}  # fmt: skip
SEED = 20261028
N_PICK = 2
SELECTION_END = date(2025, 10, 8)  # T1's selection year ends here; the year after is 2025-10-09 on
BROKERAGE_SENS = 5.0  # Shoonya, reported only
GST = 1.18


def slot_minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[2:])


def slots(lo: str, hi: str) -> list[str]:
    m, out = slot_minutes(lo), []
    while m <= slot_minutes(hi):
        out.append(f"{m // 60:02d}{m % 60:02d}")
        m += 15
    return out


SLOTS_AM, SLOTS_PM, SLOTS_ALL = slots("0917", "1147"), slots("1302", "1502"), slots("0917", "1517")


def pools() -> dict[str, list[str]]:
    """Variant names of each pool: am (half-day files), pm and all (Core files)."""
    return {
        "am": [f"{fam}-am_{s}" for fam in FAMILIES for s in SLOTS_AM],
        "pm": [f"{fam}_{s}" for fam in FAMILIES for s in SLOTS_PM],
        "all": [f"{fam}_{s}" for fam in FAMILIES for s in SLOTS_ALL],
    }


def make_variants() -> dict[str, tuple[str, Path]]:
    """name -> (underlying, strategy file): Core files as they are, morning files derived."""
    VARIANTS.mkdir(exist_ok=True)
    files: dict[str, tuple[str, Path]] = {}
    for fam, underlying in FAMILIES.items():
        for s in SLOTS_ALL:
            files[f"{fam}_{s}"] = (underlying, ROTATION / f"{fam}_{s}.yaml")
        for s in SLOTS_AM:
            src = ROTATION / f"{fam}_{s}.yaml"
            doc = yaml.safe_load(src.read_text())
            assert doc["strategy"]["entry_time"] == f"{s[:2]}:{s[2:]}", src
            doc["strategy"]["id"] = f"{fam}-am_{s}"
            doc["strategy"]["exit_time"] = "12:00"
            path = VARIANTS / f"{fam}-am_{s}.yaml"
            path.write_text(
                f"# BL-182 Phase 2: {src.name} with the exit moved to 12:00\n"
                + yaml.safe_dump(doc, sort_keys=False)
            )
            load_legwise(path)
            files[f"{fam}-am_{s}"] = (underlying, path)
    return files


def run_all(smoke: bool) -> None:
    files = make_variants()
    RESULTS.mkdir(exist_ok=True)
    for underlying in ("NIFTY", "SENSEX"):
        todo = {
            n: p
            for n, (u, p) in files.items()
            if u == underlying and not (RESULTS / f"{n}.csv").exists()
        }
        if not todo:
            continue
        hi = date(2024, 10, 16) if smoke else run.END
        print(f"{underlying}: {len(todo)} variants, {run.START} -> {hi}", flush=True)
        results = run.simulate(underlying, todo, run.START, hi)
        if smoke:
            print(sorted(Counter(len(r) for r in results.values()).items()))
            continue
        for name, rows in results.items():
            with open(RESULTS / f"{name}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(run.COLUMNS)
                w.writerows(rows)
        print(f"{underlying}: done", flush=True)


# --- analysis -------------------------------------------------------------------------------


def read(name: str) -> dict[date, dict]:
    with open(RESULTS / f"{name}.csv") as f:
        return {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}


def parity(names: list[str], root: Path) -> tuple[int, int, list[str]]:
    """Whole-day re-simulations against the stored rotation results: (days compared, days differing
    by more than Rs 1 in gross, the first few differences)."""
    compared = differ = 0
    examples = []
    for n in names:
        mine = read(n)
        with store.result_path(n, root).open() as f:
            stored = {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}
        for d, r in mine.items():
            if d in stored:
                compared += 1
                if abs(float(r["gross"]) - stored[d]) > 1.0:
                    differ += 1
                    if len(examples) < 8:
                        examples.append(
                            f"{n} {d}: ours {float(r['gross']):.0f} stored {stored[d]:.0f}"
                        )
    return compared, differ, examples


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def rank_top(P: np.ndarray, wd, bd, dn, ds, names: list[str], fam: np.ndarray, i: int) -> list[int]:
    """List C's composite for day i over rows < i; the top N_PICK by composite, ties by name."""
    comp = composite(
        P[: i + 1],
        wd[: i + 1],
        bd[: i + 1],
        dte_matrix(dn[: i + 1], ds[: i + 1], names),
        names,
        LISTS["C"],
        fam,
    )
    order = sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))
    return order[:N_PICK]


def core_as_traded(root: Path, days: list[date], attrs) -> dict[date, float]:
    """Context: Core Adaptive as traded (3 picks, Dir allowed, + Buy) replayed from the stored
    results, gross per lot-day = mean of the core picks' one-lot gross. Days with no stored
    row are left out."""
    from option_backtesting.rotation.score import select

    names = variant_names()
    m = store.load_matrix(names, root)
    keep = [i for i, d in enumerate(m.days) if d in attrs]
    mdays = [m.days[i] for i in keep]
    P = m.values[keep]
    wd = np.array([attrs[d]["weekday"] for d in mdays])
    bd = np.array([attrs[d]["vix_band"] for d in mdays])
    dn = np.array([attrs[d]["dte_n"] for d in mdays])
    ds = np.array([attrs[d]["dte_s"] for d in mdays])
    fam = family_index(names)
    pos = {d: i for i, d in enumerate(mdays)}
    out = {}
    for d in days:
        i = pos.get(d)
        if i is None or i < WARMUP:
            continue
        comp = composite(
            P[: i + 1],
            wd[: i + 1],
            bd[: i + 1],
            dte_matrix(dn[: i + 1], ds[: i + 1], names),
            names,
            LISTS["C"],
            fam,
        )
        picks = select(comp, names)
        out[d] = float(np.mean([P[i, names.index(n)] for n in picks.core]))
    return out


def analyse() -> None:
    OUT.mkdir(exist_ok=True)
    root = run.data_dir()
    pl = pools()
    everything = sorted(set(pl["am"]) | set(pl["all"]))
    rows = {n: read(n) for n in everything}
    attrs = store.read_days(root, "weekdays")
    days = sorted(set.intersection(*(set(r) for r in rows.values())) & set(attrs))
    days = [d for d in days if d.weekday() < 5]
    G = {n: np.array([float(rows[n][d]["gross"]) for d in days]) for n in everything}
    N = {n: np.array([float(rows[n][d]["net"]) for d in days]) for n in everything}
    orders = {n: np.array([int(rows[n][d]["orders"]) for d in days]) for n in everything}
    N5 = {n: N[n] + (13.0 - BROKERAGE_SENS) * orders[n] * GST for n in everything}
    wd = np.array([attrs[d]["weekday"] for d in days])
    bd = np.array([attrs[d]["vix_band"] for d in days])
    dn = np.array([attrs[d]["dte_n"] for d in days])
    ds = np.array([attrs[d]["dte_s"] for d in days])
    compared, differ, examples = parity(pl["all"], root)

    picks: dict[str, list[list[str]]] = {k: [] for k in pl}
    for key, names in pl.items():
        P = np.column_stack([G[n] for n in names])
        fam = family_index(names)
        for i in range(WARMUP, len(days)):
            picks[key].append([names[v] for v in rank_top(P, wd, bd, dn, ds, names, fam, i)])
    pick_days = days[WARMUP:]
    idx = {d: i for i, d in enumerate(days)}

    def book(key: str, series: dict[str, np.ndarray]) -> np.ndarray:
        return np.array(
            [sum(series[n][idx[d]] for n in picks[key][j]) for j, d in enumerate(pick_days)]
        )

    books = {
        "split": {
            s: book("am", S) + book("pm", S) for s, S in (("net", N), ("gross", G), ("net5", N5))
        },
        "am": {s: book("am", S) for s, S in (("net", N), ("gross", G), ("net5", N5))},
        "pm": {s: book("pm", S) for s, S in (("net", N), ("gross", G), ("net5", N5))},
        "comparator": {s: book("all", S) for s, S in (("net", N), ("gross", G), ("net5", N5))},
    }
    per_lot = {
        b: {s: v / N_PICK for s, v in d.items()} for b, d in books.items()
    }  # per margin lot-day
    diff = {s: per_lot["split"][s] - per_lot["comparator"][s] for s in ("net", "gross", "net5")}
    boot = {s: block_bootstrap_mean(diff[s], seed=SEED) for s in diff}
    dd = {b: max_drawdown(per_lot[b]["net"]) for b in per_lot}
    passed = boot["net"][1] > 0 and dd["split"] >= dd["comparator"]

    L = [
        "# BL-182 Phase 2 — Adaptive two-plus-two vs top two whole-day (Core's Widesl families)",
        "",
    ]
    L.append(
        f"Pick days {pick_days[0]} → {pick_days[-1]} ({len(pick_days)}; {WARMUP}-day warm-up from {days[0]}). "
        f"Pools: morning {len(pl['am'])}, afternoon {len(pl['pm'])}, whole-day {len(pl['all'])} variants. "
        f"Per margin lot-day = book net / {N_PICK}. Net after `ruletest/charges.py` (₹13 an order); net5 = "
        f"Shoonya ₹5 an order, reported only. Interval: 90 % circular 5-day block bootstrap, 2,000 "
        f"resamples, seed {SEED}."
    )
    L.append("")
    L.append(f"Parity of the {len(pl['all'])} whole-day re-simulations with the stored rotation results: "
             f"{compared} variant-days compared, {differ} differ by more than ₹1 in gross."
             + (" Examples: " + "; ".join(examples) if examples else ""))  # fmt: skip
    L.append("")
    L.append(
        "| Book | Net / margin lot-day | Gross | Net at ₹5 | Days in profit | Max DD (net) | Total net |"
    )
    L.append("|---|---|---|---|---|---|---|")
    for b, label in (("comparator", "Top two whole-day Widesl (comparator)"), ("am", "Top two morning (alone)"),
                     ("pm", "Top two afternoon (alone)"), ("split", "Split: two morning + two afternoon")):  # fmt: skip
        p = per_lot[b]
        L.append(f"| {label} | {fmt(p['net'].mean())} | {fmt(p['gross'].mean())} | {fmt(p['net5'].mean())} | "
                 f"{100 * (p['net'] > 0).mean():.0f} % | {fmt(dd[b])} | {fmt(p['net'].sum())} |")  # fmt: skip
    L.append("")
    m, lo, hi = boot["net"]
    gm, glo, ghi = boot["gross"]
    m5, lo5, hi5 = boot["net5"]
    L.append(f"Split − comparator per margin lot-day: net **{fmt(m)} [{fmt(lo)}, {fmt(hi)}]**; gross {fmt(gm)} "
             f"[{fmt(glo)}, {fmt(ghi)}]; at ₹5 an order {fmt(m5)} [{fmt(lo5)}, {fmt(hi5)}]. Max DD split "
             f"{fmt(dd['split'])} vs comparator {fmt(dd['comparator'])}.")  # fmt: skip
    why = []
    if boot["net"][1] <= 0:
        why.append("lower bound not above zero")
    if dd["split"] < dd["comparator"]:
        why.append("split drawdown deeper")
    L.append(
        f"**Verdict: {'PASS' if passed else 'FAIL'}**" + (f" — {'; '.join(why)}" if why else "")
    )
    L.append("")
    L.append(
        "| Period | Pick days | Split net / mlot-day | Comparator | Difference [90 %] | Split DD | Comparator DD |"
    )
    L.append("|---|---|---|---|---|---|---|")
    for label, mask in (
        (
            f"T1 selection year (to {SELECTION_END})",
            np.array([d <= SELECTION_END for d in pick_days]),
        ),
        (
            f"The year after (from {SELECTION_END})",
            np.array([d > SELECTION_END for d in pick_days]),
        ),
    ):
        if mask.sum() == 0:
            continue
        pm_, plo, phi = block_bootstrap_mean(diff["net"][mask], seed=SEED)
        L.append(f"| {label} | {mask.sum()} | {fmt(per_lot['split']['net'][mask].mean())} | "
                 f"{fmt(per_lot['comparator']['net'][mask].mean())} | {fmt(pm_)} [{fmt(plo)}, {fmt(phi)}] | "
                 f"{fmt(max_drawdown(per_lot['split']['net'][mask]))} | "
                 f"{fmt(max_drawdown(per_lot['comparator']['net'][mask]))} |")  # fmt: skip
    L.append("")
    L.append("| Half-year | Pick days | Split net | Comparator net | Difference (per mlot) |")
    L.append("|---|---|---|---|---|")
    for h in sorted({run.half_year(d.isoformat()) for d in pick_days}):
        mask = np.array([run.half_year(d.isoformat()) == h for d in pick_days])
        L.append(f"| {h} | {mask.sum()} | {fmt(per_lot['split']['net'][mask].sum())} | "
                 f"{fmt(per_lot['comparator']['net'][mask].sum())} | {fmt(diff['net'][mask].sum())} |")  # fmt: skip
    L.append("")
    for key, label in (
        ("am", "Morning picks"),
        ("pm", "Afternoon picks"),
        ("all", "Whole-day picks"),
    ):
        fams = Counter(n.split("_")[1].split("-")[0] for p in picks[key] for n in p)
        slots_ = Counter(n.split("_")[2] for p in picks[key] for n in p)
        tot = sum(fams.values())
        L.append(f"- **{label}** by family: " + ", ".join(f"{k} {100 * v / tot:.0f} %" for k, v in fams.most_common())
                 + "; by slot: " + ", ".join(f"{k} {100 * v / tot:.0f} %" for k, v in slots_.most_common(6)))  # fmt: skip
    ctx = core_as_traded(root, pick_days, attrs)
    if ctx:
        cd = np.array([ctx[d] for d in pick_days if d in ctx])
        L.append("")
        L.append(f"Context, gross only, from the stored results: Core Adaptive as traded (3 picks, Dir allowed) "
                 f"{fmt(cd.mean())} per lot-day over {len(cd)} of these days, max DD {fmt(max_drawdown(cd))}; "
                 f"the whole-day Widesl-only comparator {fmt(per_lot['comparator']['gross'].mean())} gross per "
                 f"margin lot-day, the split {fmt(per_lot['split']['gross'].mean())}.")  # fmt: skip
    with open(OUT / "phase2_daily.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "split_net", "split_gross", "comparator_net", "comparator_gross", "am_net", "pm_net",
                    "diff_net_per_mlot", "am_picks", "pm_picks", "all_picks"])  # fmt: skip
        for j, d in enumerate(pick_days):
            w.writerow([d, books["split"]["net"][j], books["split"]["gross"][j], books["comparator"]["net"][j],
                        books["comparator"]["gross"][j], books["am"]["net"][j], books["pm"]["net"][j],
                        diff["net"][j], " ".join(picks["am"][j]), " ".join(picks["pm"][j]), " ".join(picks["all"][j])])  # fmt: skip
    (OUT / "phase2_summary.md").write_text("\n".join(L) + "\n")
    print("\n".join(L))


def main() -> None:
    smoke = "--smoke" in sys.argv
    if "--analyse-only" not in sys.argv:
        run_all(smoke)
    if not smoke:
        analyse()


if __name__ == "__main__":
    main()
