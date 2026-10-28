"""BL-182: the Widesl split session (09:17-12:00 plus 13:00-15:28) against the whole day.

    uv run python research/bl182/run.py [--smoke] [--analyse-only]

Phase 0 of backlog/BL-182-widesl-split-session.md, registered before this ran. Seven Widesl
definitions (A the study's, B/C the live NIFTY and SENSEX files, D the four T1 settings), each
simulated three ways on every usable lake day 2024-10-09 -> 2026-10-27: whole day (09:17-15:28),
morning (09:17-12:00) and afternoon (13:00-15:28). The split's day is morning + afternoon, each
half with its own MTM stop. Charges from ruletest/charges.py (BL-063) on each run's own trades.
Lot sizing 'current' at the rotation's sizing date (research reference override as BL-080/BL-181).

Writes variants/ (the generated strategy files), results/<variant>.csv (one row a day) and
out/daily.csv + out/summary.md. A finished results file is never re-run (delete it to redo).
"""

from __future__ import annotations

import copy
import csv
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import yaml

from option_backtesting.data.reference.loader import MissingReferenceData
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.ruletest.charges import day_charges, trade_values

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from early_ref import early_reference  # noqa: E402  (research/common, shared by items)

STRATEGIES = HERE.parents[1] / "strategies"
VARIANTS = HERE / "variants"
RESULTS = HERE / "results"
OUT = HERE / "out"
SIZING = date(2026, 10, 12)
START, END = date(2024, 10, 9), date(2026, 10, 27)
SEED, RESAMPLES, BLOCK = 20261028, 2000, 5
COLUMNS = ["day", "gross", "charges", "net", "worst_mtm", "stopped_by", "n_trades", "orders"]

#: definition -> (underlying, source file, patch applied to every leg)
DEFINITIONS: dict[str, tuple[str, Path, dict]] = {
    "A_study": ("NIFTY", STRATEGIES / "rotation/N_wide_0917.yaml", {"trail_sl": None}),
    "B_live_N": ("NIFTY", STRATEGIES / "rotation/N_wide_0917.yaml", {}),
    "C_live_S": ("SENSEX", STRATEGIES / "rotation/S_wide_0917.yaml", {}),
    "D_t1s4": ("NIFTY", STRATEGIES / "rotation_t1/N_wide-t1s4_0917.yaml", {}),
    "D_t1s8": ("NIFTY", STRATEGIES / "rotation_t1/N_wide-t1s8_0917.yaml", {}),
    "D_t1s11": ("NIFTY", STRATEGIES / "rotation_t1/N_p150-t1s11_0917.yaml", {}),
    "D_t1s22": ("SENSEX", STRATEGIES / "rotation_t1/S_p285-t1s22_0917.yaml", {}),
}
PRIMARY = ("B_live_N", "C_live_S")
RUNS = {"all": ("09:17", "15:28"), "am": ("09:17", "12:00"), "pm": ("13:00", "15:28")}
#: the study's before-cost figures per day over its 510 days: the split paid two sets of Rs 40
#: (Rs 222,681 + 510 x 80 = Rs 517 a day), the whole day one (Rs 139,929 + 510 x 40 = Rs 314).
#: Registered as Rs 477 by an arithmetic slip (one set's costs added back); corrected after the run,
#: logged in the item. The verdict is the same either way.
STUDY_PER_DAY = {"split": 517.0, "all": 314.0}


def make_variants() -> dict[str, tuple[str, Path]]:
    """Write variants/<definition>_<run>.yaml; returns variant name -> (underlying, path)."""
    VARIANTS.mkdir(exist_ok=True)
    out = {}
    for name, (underlying, src, patch) in DEFINITIONS.items():
        base = yaml.safe_load(src.read_text())
        for run, (entry, exit_) in RUNS.items():
            doc = copy.deepcopy(base)
            s = doc["strategy"]
            s["id"] = f"{name}_{run}"
            s["entry_time"] = entry
            s["exit_time"] = exit_
            for leg in s["legs"]:
                for k, v in patch.items():
                    if v is None:
                        leg.pop(k, None)
                    else:
                        leg[k] = v
            path = VARIANTS / f"{name}_{run}.yaml"
            path.write_text(
                f"# BL-182 generated from {src.relative_to(STRATEGIES)}: {run} run\n"
                + yaml.safe_dump(doc, sort_keys=False)
            )
            load_legwise(path)  # validates
            out[f"{name}_{run}"] = (underlying, path)
    return out


def simulate(underlying: str, files: dict[str, Path], lo: date, hi: date) -> dict[str, list[list]]:
    root = data_dir()
    ref = early_reference()
    strategies = {n: load_legwise(p) for n, p in files.items()}
    days, _ = backtest_days(root, underlying, lo, hi)
    out: dict[str, list[list]] = {n: [] for n in strategies}
    missing = dict.fromkeys(strategies, 0)
    t0 = time.time()
    for i, d in enumerate(days):
        try:
            data = load_day(root, underlying, d)
        except FileNotFoundError:
            continue
        for name, strat in strategies.items():
            try:
                r = simulate_day(strat, data, ref, SIZING)
            except MissingReferenceData:
                missing[name] += 1
                continue
            orders, buy, sell = trade_values(r.trades)
            ch = day_charges(underlying, d.isoformat(), orders, buy, sell).total
            out[name].append(
                [d, round(r.gross, 2), round(ch, 2), round(r.gross - ch, 2),
                 round(r.worst_mtm, 2), r.stopped_by or "", len(r.trades), orders]
            )  # fmt: skip
        if (i + 1) % 25 == 0:
            print(f"  {underlying} {i + 1}/{len(days)} days, {time.time() - t0:.0f} s", flush=True)
    dropped = {n: k for n, k in missing.items() if k}
    print(f"  {underlying}: variant-days dropped for missing reference data: {dropped or 'none'}")
    return out


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
        hi = date(2024, 10, 16) if smoke else END
        print(f"{underlying}: {len(todo)} variants, {START} -> {hi}", flush=True)
        results = simulate(underlying, todo, START, hi)
        if smoke:
            print({n: len(r) for n, r in results.items()})
            continue
        for name, rows in results.items():
            with open(RESULTS / f"{name}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
        print(f"{underlying}: done, rows per variant {sorted({len(r) for r in results.values()})}")


# --- analysis -------------------------------------------------------------------------------


def block_boot(values: np.ndarray) -> tuple[float, float, float]:
    """(mean, 5th, 95th percentile of the mean) under a circular 5-day block bootstrap."""
    n = len(values)
    rng = np.random.default_rng(SEED)
    nb = int(np.ceil(n / BLOCK))
    draws = []
    for _ in range(RESAMPLES):
        idx = np.concatenate([(s + np.arange(BLOCK)) % n for s in rng.integers(0, n, nb)])[:n]
        draws.append(values[idx].mean())
    return float(values.mean()), float(np.percentile(draws, 5)), float(np.percentile(draws, 95))


def max_drawdown(daily: np.ndarray) -> float:
    cum = np.cumsum(daily)
    return float((cum - np.maximum.accumulate(np.maximum(cum, 0))).min())


def read(name: str) -> dict[str, dict]:
    with open(RESULTS / f"{name}.csv") as f:
        return {r["day"]: r for r in csv.DictReader(f)}


def half_year(day: str) -> str:
    y, m = int(day[:4]), int(day[5:7])
    return f"{y} H{1 if m <= 6 else 2}"


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def analyse() -> None:
    OUT.mkdir(exist_ok=True)
    lines = ["# BL-182 — split session vs whole day", ""]
    lines.append(
        f"Window {START} → {END}; net = gross − charges (`ruletest/charges.py`); per lot-day; "
        f"interval = 90 % circular {BLOCK}-day block bootstrap of the mean, {RESAMPLES} resamples, "
        f"seed {SEED}. Split = morning (09:17–12:00) + afternoon (13:00–15:28), each with its own "
        "MTM stop. Drawdown on the cumulative net."
    )
    lines.append("")
    daily_rows = []
    for name, (underlying, _src, _patch) in DEFINITIONS.items():
        parts = {run: read(f"{name}_{run}") for run in RUNS}
        days = sorted(set(parts["all"]) & set(parts["am"]) & set(parts["pm"]))
        g = {run: np.array([float(parts[run][d]["gross"]) for d in days]) for run in RUNS}
        n = {run: np.array([float(parts[run][d]["net"]) for d in days]) for run in RUNS}
        split_g, split_n = g["am"] + g["pm"], n["am"] + n["pm"]
        diff_n, diff_g = split_n - n["all"], split_g - g["all"]
        mean, lo, hi = block_boot(diff_n)
        gmean, glo, ghi = block_boot(diff_g)
        dd_split, dd_all = max_drawdown(split_n), max_drawdown(n["all"])
        for i, d in enumerate(days):
            daily_rows.append(
                [name, underlying, d, g["all"][i], n["all"][i], g["am"][i], n["am"][i],
                 g["pm"][i], n["pm"][i], split_g[i], split_n[i], diff_n[i]]
            )  # fmt: skip
        lines.append(f"## {name} ({underlying}, {len(days)} days)")
        lines.append("")
        lines.append(
            "| Book | Net / day | Gross / day | Days in profit | Max DD (net) | Total net |"
        )
        lines.append("|---|---|---|---|---|---|")
        for label, nn, gg in (
            ("Whole day 09:17–15:28", n["all"], g["all"]),
            ("Morning 09:17–12:00", n["am"], g["am"]),
            ("Afternoon 13:00–15:28", n["pm"], g["pm"]),
            ("Split (morning + afternoon)", split_n, split_g),
        ):
            lines.append(
                f"| {label} | {fmt(nn.mean())} | {fmt(gg.mean())} | {100 * (nn > 0).mean():.0f} % "
                f"| {fmt(max_drawdown(nn))} | {fmt(nn.sum())} |"
            )
        lines.append("")
        lines.append(
            f"Split − whole day: net **{fmt(mean)} [{fmt(lo)}, {fmt(hi)}]** per lot-day; "
            f"gross {fmt(gmean)} [{fmt(glo)}, {fmt(ghi)}]. Max DD split {fmt(dd_split)} vs whole day "
            f"{fmt(dd_all)}. Split days in profit {100 * (split_n > 0).mean():.0f} % vs "
            f"{100 * (n['all'] > 0).mean():.0f} %."
        )
        if name in PRIMARY:
            verdict = "PASS" if lo > 0 and dd_split >= dd_all else "FAIL"
            why = []
            if lo <= 0:
                why.append("lower bound not above zero")
            if dd_split < dd_all:
                why.append("split drawdown deeper")
            lines.append(
                f"**Verdict ({name}): {verdict}**" + (f" — {'; '.join(why)}" if why else "")
            )
        if name == "A_study":
            ok_all = abs(g["all"].mean() - STUDY_PER_DAY["all"]) <= 0.15 * STUDY_PER_DAY["all"]
            ok_split = abs(split_g.mean() - STUDY_PER_DAY["split"]) <= 0.15 * STUDY_PER_DAY["split"]
            lines.append(
                f"Reconciliation with the study (gross per day): whole day ours {g['all'].mean():,.0f} "
                f"vs study {STUDY_PER_DAY['all']:,.0f} ({'within' if ok_all else 'outside'} 15 %); split "
                f"ours {split_g.mean():,.0f} vs study {STUDY_PER_DAY['split']:,.0f} "
                f"({'within' if ok_split else 'outside'} 15 %)."
            )
        lines.append("")
        lines.append(
            "| Half-year | Days | Split net | Whole-day net | Split − whole | Split in profit | Whole in profit |"
        )
        lines.append("|---|---|---|---|---|---|---|")
        halves = sorted({half_year(d) for d in days})
        for h in halves:
            m = np.array([half_year(d) == h for d in days])
            lines.append(
                f"| {h} | {m.sum()} | {fmt(split_n[m].sum())} | {fmt(n['all'][m].sum())} | "
                f"{fmt(diff_n[m].sum())} | {100 * (split_n[m] > 0).mean():.0f} % | "
                f"{100 * (n['all'][m] > 0).mean():.0f} % |"
            )
        stops = {run: sum(1 for d in days if parts[run][d]["stopped_by"]) for run in RUNS}
        lines.append("")
        lines.append(
            f"MTM stops hit: whole day {stops['all']}, morning {stops['am']}, afternoon {stops['pm']} "
            f"of {len(days)} days. Charges per day (gross − net): whole day {g['all'].mean() - n['all'].mean():,.0f}, "
            f"split {split_g.mean() - split_n.mean():,.0f}."
        )
        lines.append("")
    with open(OUT / "daily.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["definition", "underlying", "day", "all_gross", "all_net", "am_gross", "am_net",
                    "pm_gross", "pm_net", "split_gross", "split_net", "diff_net"])  # fmt: skip
        w.writerows(daily_rows)
    (OUT / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


def main() -> None:
    smoke = "--smoke" in sys.argv
    if "--analyse-only" not in sys.argv:
        run_all(smoke)
    if not smoke:
        analyse()


if __name__ == "__main__":
    main()
