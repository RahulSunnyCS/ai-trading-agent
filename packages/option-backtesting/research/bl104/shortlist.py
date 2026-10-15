"""BL-104: every Stage 1 parameter set's check table, and shortlists cut from it.

For each family x index x band x parameter set (present at every sampled slot of its band) it
records the band-level figures and, per check, whether the set passes and whether it passes
"strongly" (well clear of the gate). The table is written once (`--build`) and committed, so a
later question ("what fails only X and Y but is strong elsewhere?") is a filter on it, not a rerun.

Every check is applied at each sampled slot of the band (the registered gates are per slot) and
the set takes its worst slot. Checks (pass / strong):
  calmar           >= 1          / >= 2
  profit_factor    >= 1.05       / >= 1.15
  day_stop_rate    <= cap        / <= cap / 2      (cap 30 % Widesl and Dir; 60 % Buy is the owner's
                                                    2026-10-15 loosening of the registered 30 %)
  entry_rate       >= 95 %       / same            (Widesl and Dir; Buy always passes)
  buy_hit_rate     >= 40 %       / same            (Buy, the registered gate; others always pass)
  worst_day        <= 1.5 x tmpl / <= 1.0 x tmpl   (template magnitude floored at 3,000)
  worst_5_days     <= 1.5 x tmpl / <= 1.0 x tmpl   (floored at 15,000)
  plateau          at least half the registered neighbours pass the gates, at every slot /
                   and they keep >= 85 % of its Martin (the neighbour test only: it does not
                   re-count the set's own gate failures)
  real_stops       a day MTM stop, Widesl leg stop <= 100 %
  verified_reentry no RE COST x2 and no RE ASAP (unverified against AlgoTest, BL-009)

    uv run python research/bl104/shortlist.py --build                    # writes the committed table
    uv run python research/bl104/shortlist.py --max-fails 2 --strong     # the 2026-10-15 owner cut
    uv run python research/bl104/shortlist.py --max-fails 2 --allow-fail plateau,calmar --family B
"""

from __future__ import annotations

import argparse
import collections
import csv
import gzip
import statistics as st
from pathlib import Path

HERE = Path(__file__).resolve().parent
STAGE1 = HERE / "results" / "stage1"
TABLE = HERE / "shortlists" / "stage1_set_checks.csv.gz"
AX = {
    "W": ("strike", "sl", "trail", "mtm", "exit", "reentry"),
    "D": ("strike", "sl", "trail", "mtm", "reentry"),
    "B": ("strike", "range", "source", "sl", "target", "trail", "mtm"),
}
CAP = {"W": 0.30, "D": 0.30, "B": 0.60}
CHECKS = (
    "calmar",
    "profit_factor",
    "day_stop_rate",
    "entry_rate",
    "buy_hit_rate",
    "worst_day",
    "worst_5_days",
    "plateau",
    "real_stops",
    "verified_reentry",
)


def num(r: dict, k: str) -> float:
    try:
        return float(r[k])
    except (KeyError, ValueError):
        return float("nan")


def build() -> None:
    out = []
    for fam in "WDB":
        with (STAGE1 / f"{fam}_ranked_tail.csv").open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        tmpl = {r["cohort"]: r for r in rows if r["cell"] == "template"}
        sets: dict[tuple, list[dict]] = collections.defaultdict(list)
        for r in rows:
            if r["cell"] == "grid":
                sets[(r["index"], r["band"], tuple(r[f"p_{a}"] for a in AX[fam]))].append(r)
        width = collections.Counter()
        for (idx, band, _), rs in sets.items():
            width[(idx, band)] = max(width[(idx, band)], len(rs))
        for (idx, band, key), rs in sets.items():
            if len(rs) < width[(idx, band)]:
                continue
            ts = [tmpl[r["cohort"]] for r in rs]
            p = dict(zip(AX[fam], key, strict=True))
            avg = st.fmean(num(r, "avg_day_inr") for r in rs)
            tavg = st.fmean(num(t, "avg_day_inr") for t in ts)
            cal = min(min(9, num(r, "calmar")) for r in rs)  # worst slot: the gates are per slot
            pf = min(min(9, num(r, "profit_factor")) for r in rs)
            stop = max(num(r, "mtm_stop_frequency") for r in rs)
            cov = 1.0 if fam == "B" else min(num(r, "entry_hit_rate") for r in rs)
            hit = min(num(r, "entry_hit_rate") for r in rs) if fam == "B" else 1.0
            wd = max(
                abs(num(r, "worst_day_inr")) / max(abs(num(t, "worst_day_inr")), 3000)
                for r, t in zip(rs, ts, strict=True)
            )
            w5 = max(
                abs(num(r, "worst5_inr")) / max(abs(num(t, "worst5_inr")), 15000)
                for r, t in zip(rs, ts, strict=True)
            )
            plateau = all(
                num(r, "n_neighbours") > 0
                and 2 * num(r, "neighbours_passing") >= num(r, "n_neighbours")
                for r in rs
            )
            nbr = min(
                (num(r, "neighbour_median_martin") / num(r, "martin_f"))
                if num(r, "martin_f") > 0
                else 0.0
                for r in rs
            )
            stops = bool(p["mtm"]) and not (fam == "W" and p["sl"] and float(p["sl"]) > 100)
            re = p.get("reentry", "")
            parity = not (re and ('"asap"' in re or '"cost", 2' in re))
            res = {
                "calmar": (cal >= 1, cal >= 2),
                "profit_factor": (pf >= 1.05, pf >= 1.15),
                "day_stop_rate": (stop <= CAP[fam], stop <= CAP[fam] / 2),
                "entry_rate": (cov >= 0.95, cov >= 0.95),
                "buy_hit_rate": (hit >= 0.40, hit >= 0.40),
                "worst_day": (wd <= 1.5, wd <= 1.0),
                "worst_5_days": (w5 <= 1.5, w5 <= 1.0),
                "plateau": (plateau, plateau and nbr >= 0.85),
                "real_stops": (stops, stops),
                "verified_reentry": (parity, parity),
            }
            row = {
                "family": fam,
                "index": idx,
                "band": band,
                "slots": ",".join(sorted(r["slot"] for r in rs)),
                **{f"p_{a}": p[a] for a in AX[fam]},
                "avg_day_inr": round(avg, 2),
                "template_avg_day_inr": round(tavg, 2),
                "calmar_worst_slot": round(cal, 3),
                "profit_factor_worst_slot": round(pf, 4),
                "day_stop_rate_worst_slot": round(stop, 4),
                "buy_hit_rate": round(hit, 4),
                "entry_rate": round(cov, 4),
                "worst_day_x_template": round(wd, 3),
                "worst5_x_template": round(w5, 3),
                "neighbour_martin_ratio": round(nbr, 3),
            }
            for c in CHECKS:
                row[f"pass_{c}"], row[f"strong_{c}"] = res[c]
            out.append(row)
    TABLE.parent.mkdir(exist_ok=True)
    fields = list(dict.fromkeys(k for r in out for k in r))
    with gzip.open(TABLE, "wt", newline="") as h:
        w = csv.DictWriter(h, fieldnames=fields)
        w.writeheader()
        w.writerows(out)
    print(f"wrote {len(out)} parameter sets to {TABLE}")


def cut(args: argparse.Namespace) -> list[dict]:
    with gzip.open(TABLE, "rt", newline="") as h:
        rows = list(csv.DictReader(h))
    allow = set(args.allow_fail.split(",")) if args.allow_fail else set(CHECKS)
    out = []
    for r in rows:
        if args.family and r["family"] not in args.family.split(","):
            continue
        avg, tavg = float(r["avg_day_inr"]), float(r["template_avg_day_inr"])
        if not (avg > 0 and avg >= tavg + args.min_gain):
            continue
        failed = [c for c in CHECKS if r[f"pass_{c}"] != "True"]
        weak = [c for c in CHECKS if r[f"pass_{c}"] == "True" and r[f"strong_{c}"] != "True"]
        if len(failed) > args.max_fails or not set(failed) <= allow or (args.strong and weak):
            continue
        out.append({**r, "failed": "+".join(failed) or "none"})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--build", action="store_true", help="rebuild the committed check table from results/stage1"
    )
    ap.add_argument("--max-fails", type=int, default=2)
    ap.add_argument(
        "--strong", action="store_true", help="every check not failed must pass strongly"
    )
    ap.add_argument(
        "--allow-fail", default="", help="comma list of checks that may fail (default any)"
    )
    ap.add_argument(
        "--min-gain",
        type=float,
        default=0.0,
        help="Rs per lot-day above the template (mandatory > 0 net)",
    )
    ap.add_argument("--family", default="", help="W, D, B or a comma list")
    ap.add_argument("--out", type=Path, default=None, help="write the shortlist CSV here")
    args = ap.parse_args()
    if args.build:
        build()
        return
    rows = cut(args)
    print(f"{len(rows)} sets")
    for k, n in collections.Counter(r["failed"] for r in rows).most_common():
        print(f"  {n:5d}  fails: {k}")
    if args.out:
        with args.out.open("w", newline="") as h:
            w = csv.DictWriter(h, fieldnames=list(dict.fromkeys(k for r in rows for k in r)))
            w.writeheader()
            w.writerows(rows)
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
