"""BL-121: do holiday-shifted expiry days earn less? Registered in backlog/BL-121 (Phase 0).

Read-only: reads the stored results and the P3 research results, writes only
`moved_expiry_2026-10-18.json` here.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl121/moved_expiry.py
"""

from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, store
from option_backtesting.rotation.variants import (
    is_dir,
    is_wide,
    track_names,
    underlying_of,
    variant_names,
)

HERE = Path(__file__).parent
# The P3 research results are git-ignored, so they live in the checkout that produced them.
RESEARCH_DIRS = [
    HERE.parent,
    Path("/Users/rahul/Projects/ai-trading-agent/packages/option-backtesting/research"),
]
EVENTS = json.loads((HERE / "events_2026-10-18.json").read_text())
ADAPTIVE_WINDOW = (date(2025, 1, 10), date(2026, 10, 16))
FOUR_YEAR = (date(2022, 1, 3), date(2026, 10, 16))
SEAM = date(2024, 10, 9)  # the live store starts here; earlier days come from the P3 research files
RESAMPLES, SEED = 5000, 20261018
PENDING = {"2026-10-19"}  # the live forward event: no result yet, excluded

INDEXES = ("NIFTY", "SENSEX")


def event_days(
    exclude_cross_index: bool = False,
) -> tuple[dict[str, set[date]], dict[str, set[date]]]:
    """Moved days and normal expiry days per index, exactly as registered. The normal set keeps a day
    that is moved for the OTHER index (the registration says only "an expiry on the regular weekday");
    `exclude_cross_index=True` drops those, as the first recorded run did, as a sensitivity only."""
    moved = {
        i: {date.fromisoformat(m["expiry"]) for m in EVENTS["indices"][i]["moved"]}
        - {date.fromisoformat(x) for x in PENDING}
        for i in INDEXES
    }
    every_moved = set().union(*moved.values()) if exclude_cross_index else set()
    normal = {
        i: {date.fromisoformat(x) for x in EVENTS["indices"][i]["normal_expiry_days"]} - every_moved
        for i in INDEXES
    }
    return moved, normal


def pooled_deviation(series: dict[date, float], moved, normal, window, rng=None) -> float | None:
    """Mean over moved days (both indices) of (day's value - mean of that index's normal days)."""
    devs = []
    for index in INDEXES:
        m = sorted(d for d in moved[index] if window[0] <= d <= window[1] and d in series)
        n = sorted(d for d in normal[index] if window[0] <= d <= window[1] and d in series)
        if not m or not n:
            continue
        mv = np.array([series[d] for d in m])
        nv = np.array([series[d] for d in n])
        if rng is not None:
            mv = rng.choice(mv, size=len(mv), replace=True)
            nv = rng.choice(nv, size=len(nv), replace=True)
        devs.extend(mv - nv.mean())
    return float(np.mean(devs)) if devs else None


def interval(series, moved, normal, window, leave_out: frozenset = frozenset()) -> dict:
    moved = {i: {d for d in moved[i] if d not in leave_out} for i in moved}
    point = pooled_deviation(series, moved, normal, window)
    rng = np.random.default_rng(SEED)
    draws = [pooled_deviation(series, moved, normal, window, rng) for _ in range(RESAMPLES)]
    draws = [x for x in draws if x is not None]
    lo, hi = np.percentile(draws, [5, 95])
    n_moved = {
        i: len([d for d in moved[i] if window[0] <= d <= window[1] and d in series])
        for i in INDEXES
    }
    n_normal = {
        i: len([d for d in normal[i] if window[0] <= d <= window[1] and d in series])
        for i in INDEXES
    }
    verdict = "worse" if hi < 0 else "not worse" if lo >= 0 else "inconclusive"
    return {
        "moved_minus_normal": point,
        "ci90": [float(lo), float(hi)],
        "moved_days": n_moved,
        "normal_days": n_normal,
        "reading": verdict,
    }


class RoutedResults(daylog._Results):
    """`daylog._Results` reads every variant from the live folder; T1's extra variants live in the
    track's own folder, so route each name through `store.result_path` (as the T1 job does)."""

    def row(self, name: str, day: date):
        if name not in self._rows:
            self._rows[name] = read_rows_routed(name, self.root)
        return self._rows[name].get(day)


def read_rows_routed(name: str, root: Path) -> dict[date, dict]:
    path = store.result_path(name, root)
    if not path.exists():
        return {}
    out: dict[date, dict] = {}
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                day = date.fromisoformat(r["day"])
                gross = float(r["gross"])
            except (KeyError, ValueError):
                continue
            worst = float(r["worst_mtm"]) if r.get("worst_mtm") not in (None, "") else None
            trades = int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else None
            out[day] = {
                "gross": gross,
                "worst_mtm": worst,
                "stopped_by": r.get("stopped_by") or "",
                "n_trades": trades,
            }
    return out


def adaptive(root: Path, names: list[str]) -> dict[date, float]:
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    results = RoutedResults(root)
    out = {}
    for d in rec.days_available():
        if not (ADAPTIVE_WINDOW[0] <= d <= ADAPTIVE_WINDOW[1]):
            continue
        row = daylog.reconstructed_row(d, rec, results)
        block = row["lists"]["C"] if row else None
        if block and block["scored"] and block["per_lot_day"] is not None:
            out[d] = float(block["per_lot_day"])
    return out


def read_gross(path: Path) -> dict[date, float]:
    if not path.exists():
        return {}
    with path.open() as f:
        return {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}


def nifty_family_series(root: Path) -> tuple[dict[str, dict[date, float]], dict]:
    names = [n for n in variant_names() if underlying_of(n) == "NIFTY"]
    per_variant: dict[str, dict[date, float]] = {}
    cover = {"research_variants": 0, "store_variants": 0, "missing_research": []}
    for n in names:
        research = None
        for base in RESEARCH_DIRS:
            for cand in (
                base / "bl080/results" / f"{n}.csv",
                base / "bl071/results" / f"{n}.csv",
                base / "bl071/results" / f"{n[2:]}.csv",
            ):
                if cand.exists():
                    research = read_gross(cand)
                    break
            if research:
                break
        store_rows = daylog.read_rows(n, root)
        series = {d: v for d, v in (research or {}).items() if d < SEAM}
        series.update({d: float(r["gross"]) for d, r in store_rows.items() if d >= SEAM})
        if research:
            cover["research_variants"] += 1
        else:
            cover["missing_research"].append(n)
        if store_rows:
            cover["store_variants"] += 1
        per_variant[n] = series
    fam = {"Widesl": [], "Dir": [], "Buy": []}
    for n in names:
        fam["Widesl" if is_wide(n) else "Dir" if is_dir(n) else "Buy"].append(n)
    out: dict[str, dict[date, float]] = {}
    days = sorted({d for s in per_variant.values() for d in s})
    for label, members in fam.items():
        out[label] = {}
        for d in days:
            vals = [per_variant[n][d] for n in members if d in per_variant[n]]
            if len(vals) >= max(3, len(members) // 2):
                out[label][d] = float(np.mean(vals))
    out["All NIFTY variants"] = {}
    for d in days:
        vals = [per_variant[n][d] for n in names if d in per_variant[n]]
        if len(vals) >= len(names) // 2:
            out["All NIFTY variants"][d] = float(np.mean(vals))
    cover["family_sizes"] = {k: len(v) for k, v in fam.items()}
    assert not cover["missing_research"], (
        f"P3 research files missing: {cover['missing_research'][:5]}"
    )
    # seam: where a research file also covers days the live store has, how far apart are they?
    overlap, worst = 0, 0.0
    for n in names:
        for base in RESEARCH_DIRS:
            f = base / "bl080/results" / f"{n}.csv"
            if f.exists():
                store_rows = daylog.read_rows(n, root)
                for d, v in read_gross(f).items():
                    if d >= SEAM and d in store_rows:
                        overlap += 1
                        worst = max(worst, abs(v - float(store_rows[d]["gross"])))
                break
    cover["seam_overlap_variant_days"] = overlap
    cover["seam_max_abs_difference"] = worst
    return out, cover


def main() -> None:
    root = data_dir()
    moved, normal = event_days()
    report: dict = {"events_file": "events_2026-10-18.json", "excluded_pending": sorted(PENDING)}
    core = adaptive(root, variant_names())
    t1 = adaptive(root, [*variant_names(), *track_names("t1")])
    report["adaptive_days"] = {"core": len(core), "t1": len(t1)}
    report["adaptive_core"] = interval(core, moved, normal, ADAPTIVE_WINDOW)
    report["adaptive_t1"] = interval(t1, moved, normal, ADAPTIVE_WINDOW)
    drop = frozenset({date(2025, 4, 9)})
    report["leave_out_2025_04_09"] = {
        "core": interval(core, moved, normal, ADAPTIVE_WINDOW, drop),
        "t1": interval(t1, moved, normal, ADAPTIVE_WINDOW, drop),
    }
    moved_x, normal_x = event_days(exclude_cross_index=True)
    report["sensitivity_cross_index_days_excluded_from_normal"] = {
        "adaptive_core": interval(core, moved_x, normal_x, ADAPTIVE_WINDOW),
        "adaptive_t1": interval(t1, moved_x, normal_x, ADAPTIVE_WINDOW),
    }
    families, cover = nifty_family_series(root)
    report["coverage"] = cover
    nifty_only_moved = {"NIFTY": moved["NIFTY"], "SENSEX": set()}
    report["nifty_families_four_year"] = {
        label: interval(series, nifty_only_moved, normal, FOUR_YEAR)
        for label, series in families.items()
    }
    nifty_only_moved_x = {"NIFTY": moved_x["NIFTY"], "SENSEX": set()}
    report["sensitivity_cross_index_days_excluded_from_normal"]["nifty_families_four_year"] = {
        label: interval(series, nifty_only_moved_x, normal_x, FOUR_YEAR)
        for label, series in families.items()
    }
    # event table
    table = []
    mean_normal = {}
    for index in INDEXES:
        ds = [d for d in normal[index] if ADAPTIVE_WINDOW[0] <= d <= ADAPTIVE_WINDOW[1]]
        have = [d for d in ds if d in core and d in t1]
        mvd = [
            d
            for d in moved[index]
            if d in core and d in t1 and ADAPTIVE_WINDOW[0] <= d <= ADAPTIVE_WINDOW[1]
        ]
        core_normal = float(np.mean([core[d] for d in have]))
        mean_normal[index] = {
            "core": core_normal,
            "t1": float(np.mean([t1[d] for d in have])),
            "n": len(have),
            "moved_core_mean": float(np.mean([core[d] for d in mvd])),
            "moved_t1_mean": float(np.mean([t1[d] for d in mvd])),
            "moved_n": len(mvd),
            "moved_days_below_normal_mean_core": sum(1 for d in mvd if core[d] < core_normal),
        }
    report["mean_on_normal_expiry_days"] = mean_normal
    for index in INDEXES:
        for d in sorted(moved[index]):
            row = {
                "index": index,
                "day": d.isoformat(),
                "core_adaptive": core.get(d),
                "t1_adaptive": t1.get(d),
            }
            if index == "NIFTY":
                for label in ("Widesl", "Dir", "Buy"):
                    row[f"nifty_{label.lower()}"] = families[label].get(d)
            table.append(row)
    report["events"] = table
    (HERE / "moved_expiry_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "events"}, indent=1))
    print("\nEVENTS")
    for r in table:
        print(
            r["index"],
            r["day"],
            "core",
            None if r["core_adaptive"] is None else round(r["core_adaptive"]),
            "t1",
            None if r["t1_adaptive"] is None else round(r["t1_adaptive"]),
            {k: round(v) for k, v in r.items() if k.startswith("nifty_") and v is not None},
        )


if __name__ == "__main__":
    main()
