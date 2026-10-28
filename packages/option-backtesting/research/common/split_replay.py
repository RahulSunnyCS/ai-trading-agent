"""The session-split replay (BL-182 Phase 2, generalised for BL-184 and later items).

A `Spec` names the Core families, the morning and afternoon entry slots, the morning exit, how many
picks each pool takes and how many lots of margin a book uses. `run_all` writes the derived morning
files (the Core slot file with only `exit_time` changed, and the overall stop when `mtm` is set),
simulates every variant with the legwise engine (sizing `current` at the rotation's sizing date,
charges from ruletest/charges.py on each run's own trades) and keeps one CSV a variant; `analyse`
replays list C's composite (`score.composite`, as the 09:16 job) on each pool, takes the top picks,
books the split (morning + afternoon picks) against the comparator (whole-day picks), and writes
out/<tag>_summary.md and out/<tag>_daily.csv. The whole-day re-simulations are checked against the
stored rotation results.

BL-182's own scripts (research/bl182/run.py, phase2.py) are the record of what ran there and stay as
they are; this module is their machinery for the items after it.
"""

from __future__ import annotations

import csv
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import yaml
from early_ref import early_reference

from option_backtesting.data.reference.loader import MissingReferenceData
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import backtest_days, load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.portfolio import apply_book, member_from_curve, parse_trail
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import composite, dte_matrix, family_index, select
from option_backtesting.rotation.variants import variant_names
from option_backtesting.ruletest.charges import day_charges, trade_values

ROTATION = Path(__file__).resolve().parents[2] / "strategies" / "rotation"
SIZING = date(2026, 10, 12)
START, END = date(2024, 10, 9), date(2026, 10, 27)
COLUMNS = ["day", "gross", "charges", "net", "worst_mtm", "stopped_by", "n_trades", "orders"]
BROKERAGE_MODEL, BROKERAGE_SENS, GST = 13.0, 5.0, 1.18
SELECTION_END = date(2025, 10, 8)  # T1's selection year ends here


def slot_minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[2:])


def slots(lo: str, hi: str) -> list[str]:
    m, out = slot_minutes(lo), []
    while m <= slot_minutes(hi):
        out.append(f"{m // 60:02d}{m % 60:02d}")
        m += 15
    return out


def half_year(d: date) -> str:
    return f"{d.year} H{1 if d.month <= 6 else 2}"


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


@dataclass
class Spec:
    here: Path  # the item's research folder: variants/, results/, out/ go under it
    families: dict[str, str]  # Core family -> underlying
    slots_am: list[str]
    slots_pm: list[str]
    am_exit: str  # "12:00", "13:00"
    n_pick: int  # picks per pool
    margin_lots: int  # per margin lot-day = book net / this
    title: str
    seed: int = 20261028
    mtm: int | None = None  # the half-day sets at this overall stop (the whole-day pool unchanged)
    mtm_halves: tuple[str, ...] = ("am", "pm")  # which halves take `mtm`; ("am",) = morning only
    #: an overlay on the morning sets' recorded MTM paths, applied at the files' stop (E3): "tgt1500"
    #: (close at the first bar close at or above Rs 1,500) or "lock4000-2000" (once Rs 4,000 was
    #: reached, close at the first bar close at or below Rs 2,000) or "lt3000-0-100" (once Rs 3,000 was
    #: reached, a lock at Rs 0 that rises Rs 100 for every further Rs 100 of peak MTM); results under
    #: results_split_<overlay>/
    overlay: str | None = None
    slots_all: list[str] = field(default_factory=lambda: slots("0917", "1517"))

    @property
    def pm_derived(self) -> bool:
        return bool(self.mtm) and "pm" in self.mtm_halves

    @property
    def tag(self) -> str:
        if self.overlay:
            return f"split_{self.overlay}"
        if not self.mtm:
            return "split"
        return f"split_mtm{self.mtm}" + ("" if self.pm_derived else "am")

    @property
    def paths_dir(self) -> Path:
        """The morning sets' recorded MTM paths at the files' stop (one .npz a variant)."""
        return self.here / "paths_split"

    @property
    def variants_dir(self) -> Path:
        return self.here / f"variants_{self.tag}"

    @property
    def results_half(self) -> Path:
        return self.here / f"results_{self.tag}"

    @property
    def results_all(self) -> Path:
        return self.here / "results_wholeday"

    @property
    def out(self) -> Path:
        return self.here / "out"

    def result_dir(self, name: str) -> Path:
        return self.results_half if ("-am_" in name or "-pm_" in name) else self.results_all

    def pools(self) -> dict[str, list[str]]:
        pm = "-pm" if self.pm_derived else ""
        return {
            "am": [f"{f}-am_{s}" for f in self.families for s in self.slots_am],
            "pm": [f"{f}{pm}_{s}" for f in self.families for s in self.slots_pm],
            "all": [f"{f}_{s}" for f in self.families for s in self.slots_all],
        }


# --- simulation -----------------------------------------------------------------------------


def simulate(underlying: str, files: dict[str, Path], lo: date, hi: date) -> dict[str, list[list]]:
    """Every variant on every usable day of the window, one row a day with its charges."""
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


def make_variants(spec: Spec) -> dict[str, tuple[str, Path]]:
    """name -> (underlying, strategy file): Core files as they are, half-day files derived."""
    spec.variants_dir.mkdir(exist_ok=True)
    files: dict[str, tuple[str, Path]] = {}

    def derive(fam: str, s: str, half: str, underlying: str) -> None:
        src = ROTATION / f"{fam}_{s}.yaml"
        doc = yaml.safe_load(src.read_text())
        assert doc["strategy"]["entry_time"] == f"{s[:2]}:{s[2:]}", src
        doc["strategy"]["id"] = f"{fam}-{half}_{s}"
        note = []
        if half == "am":
            doc["strategy"]["exit_time"] = spec.am_exit
            note.append(f"the exit moved to {spec.am_exit}")
        if spec.mtm and half in spec.mtm_halves:
            doc["strategy"]["overall"]["stop_loss_inr"] = float(spec.mtm)
            note.append(f"overall stop {spec.mtm}")
        path = spec.variants_dir / f"{fam}-{half}_{s}.yaml"
        path.write_text(
            f"# {spec.here.name}: {src.name} with {', '.join(note)}\n"
            + yaml.safe_dump(doc, sort_keys=False)
        )
        load_legwise(path)
        files[f"{fam}-{half}_{s}"] = (underlying, path)

    for fam, underlying in spec.families.items():
        for s in spec.slots_all:
            files[f"{fam}_{s}"] = (underlying, ROTATION / f"{fam}_{s}.yaml")
        for s in spec.slots_am:
            derive(fam, s, "am", underlying)
        if spec.pm_derived:
            for s in spec.slots_pm:
                derive(fam, s, "pm", underlying)
    return files


def run_all(spec: Spec, smoke: bool = False) -> None:
    files = make_variants(spec)
    spec.results_all.mkdir(exist_ok=True)
    spec.results_half.mkdir(exist_ok=True)
    for underlying in ("NIFTY", "SENSEX"):
        todo = {
            n: p
            for n, (u, p) in files.items()
            if u == underlying and not (spec.result_dir(n) / f"{n}.csv").exists()
        }
        if not todo:
            continue
        hi = date(2024, 10, 16) if smoke else END
        print(f"{underlying}: {len(todo)} variants, {START} -> {hi}", flush=True)
        results = simulate(underlying, todo, START, hi)
        if smoke:
            print(sorted(Counter(len(r) for r in results.values()).items()))
            continue
        for name, rows in results.items():
            with open(spec.result_dir(name) / f"{name}.csv", "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
        print(f"{underlying}: done", flush=True)


# --- recorded paths and overlays (E3) ------------------------------------------------------


def simulate_paths(spec: Spec, underlying: str, files: dict[str, Path], hi: date = END) -> None:
    """Simulate the given variants once more at their files' settings, keeping each day's MTM
    series (`DayResult.mtm`, the combined MTM at every simulated bar's close, the series the engine's
    overall stop and target are judged on) as a 375-minute path (`portfolio.member_from_curve`:
    0 before the entry, the day's gross after the exit). One .npz a variant under paths_split/,
    beside the row the results CSV holds."""
    spec.paths_dir.mkdir(exist_ok=True)
    root = data_dir()
    ref = early_reference()
    strategies = {n: load_legwise(p) for n, p in files.items()}
    days, _ = backtest_days(root, underlying, START, hi)
    rows: dict[str, list[list]] = {n: [] for n in strategies}
    paths: dict[str, list[tuple[float, ...]]] = {n: [] for n in strategies}
    mismatch = 0
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
                continue
            orders, buy, sell = trade_values(r.trades)
            ch = day_charges(underlying, d.isoformat(), orders, buy, sell).total
            rows[name].append(
                [d, round(r.gross, 2), round(ch, 2), round(r.gross - ch, 2),
                 round(r.worst_mtm, 2), r.stopped_by or "", len(r.trades), orders]
            )  # fmt: skip
            path = member_from_curve(name, 1, r.mtm, r.gross).pnl
            if r.mtm and abs(r.mtm[-1][1] - r.gross) > 1.0:
                mismatch += 1
            paths[name].append(path)
        if (i + 1) % 25 == 0:
            print(f"  {underlying} {i + 1}/{len(days)} days, {time.time() - t0:.0f} s", flush=True)
    print(
        f"  {underlying}: days whose last MTM differs from the gross by more than Rs 1: {mismatch}"
    )
    for name in strategies:
        with open(spec.result_dir(name) / f"{name}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(COLUMNS)
            w.writerows(rows[name])
        np.savez_compressed(
            spec.paths_dir / f"{name}.npz",
            days=np.array([r[0].isoformat() for r in rows[name]]),
            path=np.array(paths[name], dtype=np.float32),
        )


def apply_overlay(path: np.ndarray, gross: float, overlay: str) -> tuple[float, str | None]:
    """(the day's gross under the overlay, what fired or None). `tgtT`: the first minute the path is
    at or above T, as the engine's overall target; `lockA-B`: `portfolio.apply_book` with `lock:A,B`
    and no stop (the file's own stop is already in the path)."""
    if overlay.startswith("tgt"):
        level = float(overlay[3:])
        hit = np.nonzero(path >= level)[0]
        if len(hit) and path[hit[0]] != 0.0:
            return float(path[hit[0]]), "target"
        return gross, None
    if overlay.startswith("lt"):  # lock-and-trail: ltA-B-S = locktrail:A,B,S,S (1:1 in S steps)
        a, b, step = overlay[2:].split("-")
        day = apply_book(
            [member_from_curve("x", 1, [(i, float(v)) for i, v in enumerate(path)], gross)],
            None,
            parse_trail(f"locktrail:{a},{b},{step},{step}"),
        )
        return (
            (float(day.gross_with), "locktrail") if day.stop_minute is not None else (gross, None)
        )
    if overlay.startswith("lock"):
        a, b = overlay[4:].split("-")
        day = apply_book([member_from_curve("x", 1, [(i, float(v)) for i, v in enumerate(path)], gross)],
                         None, parse_trail(f"lock:{a},{b}"))  # fmt: skip
        return (float(day.gross_with), "lock") if day.stop_minute is not None else (gross, None)
    raise ValueError(f"unknown overlay {overlay!r}")


def write_overlay(spec: Spec, names: list[str]) -> None:
    """results_split_<overlay>/<name>.csv for the morning variants from their recorded paths; charges
    are the base run's (the same legs close either way)."""
    assert spec.overlay
    spec.results_half.mkdir(exist_ok=True)
    base = replace_overlay(spec, None)
    for name in names:
        z = np.load(spec.paths_dir / f"{name}.npz")
        rows = read(base, name)
        out = []
        for d_iso, path in zip(z["days"], z["path"], strict=True):
            r = rows[date.fromisoformat(str(d_iso))]
            g, fired = apply_overlay(path, float(r["gross"]), spec.overlay)
            ch = float(r["charges"])
            out.append([d_iso, round(g, 2), round(ch, 2), round(g - ch, 2), r["worst_mtm"],
                        fired or r["stopped_by"], r["n_trades"], r["orders"]])  # fmt: skip
        with open(spec.results_half / f"{name}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(COLUMNS)
            w.writerows(out)


def replace_overlay(spec: Spec, overlay: str | None) -> Spec:
    from dataclasses import replace

    return replace(spec, overlay=overlay)


# --- analysis -------------------------------------------------------------------------------


def read(spec: Spec, name: str) -> dict[date, dict]:
    with open(spec.result_dir(name) / f"{name}.csv") as f:
        return {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}


def parity(spec: Spec, names: list[str], root: Path) -> tuple[int, int, list[str]]:
    """Whole-day re-simulations against the stored rotation results: (variant-days compared, those
    differing by more than Rs 1 in gross, the first few)."""
    compared = differ = 0
    examples: list[str] = []
    for n in names:
        mine = read(spec, n)
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


def rank_top(P, wd, bd, dn, ds, names: list[str], fam, i: int, n_pick: int) -> list[int]:
    """List C's composite for day i over rows < i; the top n_pick by composite, ties by name."""
    comp = composite(
        P[: i + 1], wd[: i + 1], bd[: i + 1], dte_matrix(dn[: i + 1], ds[: i + 1], names), names,
        LISTS["C"], fam,
    )  # fmt: skip
    order = sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))
    return order[:n_pick]


def core_as_traded(root: Path, days: list[date], attrs) -> dict[date, float]:
    """Context: Core Adaptive as traded (3 picks, Dir allowed) replayed from the stored results,
    gross per lot-day = the mean of the core picks' one-lot gross."""
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
            P[: i + 1], wd[: i + 1], bd[: i + 1], dte_matrix(dn[: i + 1], ds[: i + 1], names),
            names, LISTS["C"], fam,
        )  # fmt: skip
        picks = select(comp, names)
        out[d] = float(np.mean([P[i, names.index(n)] for n in picks.core]))
    return out


def analyse(spec: Spec) -> str:
    spec.out.mkdir(exist_ok=True)
    root = data_dir()
    pl = spec.pools()
    everything = sorted(set(pl["am"]) | set(pl["pm"]) | set(pl["all"]))
    rows = {n: read(spec, n) for n in everything}
    attrs = store.read_days(root, "weekdays")
    days = sorted(set.intersection(*(set(r) for r in rows.values())) & set(attrs))
    days = [d for d in days if d.weekday() < 5]
    G = {n: np.array([float(rows[n][d]["gross"]) for d in days]) for n in everything}
    N = {n: np.array([float(rows[n][d]["net"]) for d in days]) for n in everything}
    orders = {n: np.array([int(rows[n][d]["orders"]) for d in days]) for n in everything}
    N5 = {n: N[n] + (BROKERAGE_MODEL - BROKERAGE_SENS) * orders[n] * GST for n in everything}
    wd = np.array([attrs[d]["weekday"] for d in days])
    bd = np.array([attrs[d]["vix_band"] for d in days])
    dn = np.array([attrs[d]["dte_n"] for d in days])
    ds = np.array([attrs[d]["dte_s"] for d in days])
    compared, differ, examples = parity(spec, pl["all"], root)

    picks: dict[str, list[list[str]]] = {k: [] for k in pl}
    for key, names in pl.items():
        P = np.column_stack([G[n] for n in names])
        fam = family_index(names)
        for i in range(WARMUP, len(days)):
            picks[key].append(
                [names[v] for v in rank_top(P, wd, bd, dn, ds, names, fam, i, spec.n_pick)]
            )
    pick_days = days[WARMUP:]
    idx = {d: i for i, d in enumerate(days)}
    series = (("net", N), ("gross", G), ("net5", N5))

    def book(key: str, S: dict[str, np.ndarray]) -> np.ndarray:
        return np.array([sum(S[n][idx[d]] for n in picks[key][j]) for j, d in enumerate(pick_days)])

    books = {
        "split": {s: book("am", S) + book("pm", S) for s, S in series},
        "am": {s: book("am", S) for s, S in series},
        "pm": {s: book("pm", S) for s, S in series},
        "comparator": {s: book("all", S) for s, S in series},
    }
    per_lot = {b: {s: v / spec.margin_lots for s, v in d.items()} for b, d in books.items()}
    diff = {s: per_lot["split"][s] - per_lot["comparator"][s] for s in ("net", "gross", "net5")}
    boot = {s: block_bootstrap_mean(diff[s], seed=spec.seed) for s in diff}
    dd = {b: max_drawdown(per_lot[b]["net"]) for b in per_lot}
    passed = boot["net"][1] > 0 and dd["split"] >= dd["comparator"]

    n = spec.n_pick
    L = [f"# {spec.title}", ""]
    L.append(
        f"Pick days {pick_days[0]} → {pick_days[-1]} ({len(pick_days)}; {WARMUP}-day warm-up from {days[0]}). "
        f"Pools: morning {len(pl['am'])} (exit {spec.am_exit}), afternoon {len(pl['pm'])}, whole-day "
        f"{len(pl['all'])} variants; {n} pick{'s' if n > 1 else ''} each. Per margin lot-day = book net / "
        f"{spec.margin_lots}. Net after `ruletest/charges.py` (₹13 an order); net5 = Shoonya ₹5 an order, "
        f"reported only. Interval: 90 % circular 5-day block bootstrap, 2,000 resamples, seed {spec.seed}."
        + (
            f" {' and '.join(spec.mtm_halves)} sets at a ₹{spec.mtm:,} overall stop (the whole-day pool unchanged)."
            if spec.mtm
            else ""
        )
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
    for b, label in (
        ("comparator", f"Top {n} whole-day (comparator)"),
        ("am", f"Top {n} morning (alone)"),
        ("pm", f"Top {n} afternoon (alone)"),
        ("split", f"Split: {n} morning + {n} afternoon"),
    ):
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
        pm_, plo, phi = block_bootstrap_mean(diff["net"][mask], seed=spec.seed)
        L.append(f"| {label} | {mask.sum()} | {fmt(per_lot['split']['net'][mask].mean())} | "
                 f"{fmt(per_lot['comparator']['net'][mask].mean())} | {fmt(pm_)} [{fmt(plo)}, {fmt(phi)}] | "
                 f"{fmt(max_drawdown(per_lot['split']['net'][mask]))} | "
                 f"{fmt(max_drawdown(per_lot['comparator']['net'][mask]))} |")  # fmt: skip
    L.append("")
    L.append("| Half-year | Pick days | Split net | Comparator net | Difference (per mlot) |")
    L.append("|---|---|---|---|---|")
    for h in sorted({half_year(d) for d in pick_days}):
        mask = np.array([half_year(d) == h for d in pick_days])
        L.append(f"| {h} | {mask.sum()} | {fmt(per_lot['split']['net'][mask].sum())} | "
                 f"{fmt(per_lot['comparator']['net'][mask].sum())} | {fmt(diff['net'][mask].sum())} |")  # fmt: skip
    L.append("")
    for key, label in (
        ("am", "Morning picks"),
        ("pm", "Afternoon picks"),
        ("all", "Whole-day picks"),
    ):
        fams = Counter(x.split("_")[1].split("-")[0] for p in picks[key] for x in p)
        slots_ = Counter(x.split("_")[2] for p in picks[key] for x in p)
        tot = sum(fams.values())
        L.append(f"- **{label}** by family: " + ", ".join(f"{k} {100 * v / tot:.0f} %" for k, v in fams.most_common())
                 + "; by slot: " + ", ".join(f"{k} {100 * v / tot:.0f} %" for k, v in slots_.most_common(6)))  # fmt: skip
    ctx = core_as_traded(root, pick_days, attrs)
    if ctx:
        cd = np.array([ctx[d] for d in pick_days if d in ctx])
        L.append("")
        L.append(f"Context, gross only, from the stored results: Core Adaptive as traded (3 picks) "
                 f"{fmt(cd.mean())} per lot-day over {len(cd)} of these days, max DD {fmt(max_drawdown(cd))}; "
                 f"the whole-day comparator {fmt(per_lot['comparator']['gross'].mean())} gross per margin "
                 f"lot-day, the split {fmt(per_lot['split']['gross'].mean())}.")  # fmt: skip
    with open(spec.out / f"{spec.tag}_daily.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", "split_net", "split_gross", "comparator_net", "comparator_gross", "am_net", "pm_net",
                    "diff_net_per_mlot", "am_picks", "pm_picks", "all_picks"])  # fmt: skip
        for j, d in enumerate(pick_days):
            w.writerow([d, books["split"]["net"][j], books["split"]["gross"][j], books["comparator"]["net"][j],
                        books["comparator"]["gross"][j], books["am"]["net"][j], books["pm"]["net"][j],
                        diff["net"][j], " ".join(picks["am"][j]), " ".join(picks["pm"][j]), " ".join(picks["all"][j])])  # fmt: skip
    text = "\n".join(L) + "\n"
    (spec.out / f"{spec.tag}_summary.md").write_text(text)
    stops_hit = {
        key: sum(
            1 for j, d in enumerate(pick_days) for n in picks[key][j] if rows[n][d]["stopped_by"]
        )
        / max(len(pick_days), 1)
        for key in ("am", "pm", "all")
    }
    stats = {
        "pick_days": len(pick_days),
        "per_lot": {b: {s: float(v.mean()) for s, v in d.items()} for b, d in per_lot.items()},
        "in_profit": {b: float((per_lot[b]["net"] > 0).mean()) for b in per_lot},
        "dd": dd,
        "diff": {s: boot[s] for s in boot},
        "stops_hit_per_day": stops_hit,  # picks stopped by the overall stop, per pick day
    }
    return text, stats


def fixed_half(spec: Spec, family: str, am_entry: str) -> dict:
    """Descriptive: one family's `am_entry` morning half alone: net / gross per day, drawdown, days
    in profit, share of days the overall stop was hit."""
    am = read(spec, f"{family}-am_{am_entry}")
    days = sorted(am)
    n = np.array([float(am[d]["net"]) for d in days])
    g = np.array([float(am[d]["gross"]) for d in days])
    return {
        "days": len(days), "net": float(n.mean()), "gross": float(g.mean()), "dd": max_drawdown(n),
        "in_profit": float((n > 0).mean()),
        "stopped": sum(1 for d in days if am[d]["stopped_by"]) / max(len(days), 1),
    }  # fmt: skip


def fixed_split(spec: Spec, family: str, am_entry: str, pm_entry: str) -> str:
    """Descriptive: one family's `am_entry` Core file split at the morning exit plus its `pm_entry`
    Core file (both from the pools' results) against the family's whole-day `am_entry` file."""
    am = read(spec, f"{family}-am_{am_entry}")
    pm = read(spec, f"{family}{'-pm' if spec.pm_derived else ''}_{pm_entry}")
    whole = read(spec, f"{family}_{am_entry}")
    days = sorted(set(am) & set(pm) & set(whole))
    sn = np.array([float(am[d]["net"]) + float(pm[d]["net"]) for d in days])
    sg = np.array([float(am[d]["gross"]) + float(pm[d]["gross"]) for d in days])
    wn = np.array([float(whole[d]["net"]) for d in days])
    wg = np.array([float(whole[d]["gross"]) for d in days])
    m, lo, hi = block_bootstrap_mean(sn - wn, seed=spec.seed)
    gm, glo, ghi = block_bootstrap_mean(sg - wg, seed=spec.seed)
    return (f"{family}: {am_entry}→{spec.am_exit} + {pm_entry}→15:28 vs {am_entry}→15:28, {len(days)} days: "
            f"whole net {fmt(wn.mean())} split net {fmt(sn.mean())}; diff net {fmt(m)} [{fmt(lo)}, {fmt(hi)}], "
            f"gross {fmt(gm)} [{fmt(glo)}, {fmt(ghi)}]; max DD whole {fmt(max_drawdown(wn))} split "
            f"{fmt(max_drawdown(sn))}")  # fmt: skip
