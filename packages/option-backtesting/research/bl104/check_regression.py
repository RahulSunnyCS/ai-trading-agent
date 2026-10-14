"""BL-104: do the template cells reproduce the earlier sweeps to the rupee?

Compares the `template` rows of `results/<tag>/{W,D,B}_summary.csv` with the `baseline` rows of
BL-097/098 (`research/bl097/results/{widesl,buy}_sweep_postcharge.csv`, `full_*` columns, the
per-underlying day lists WITH weekend sessions) and the charged Dir row of BL-096
(`research/bl096/results/primary_diagnostics_charged.csv`, ATM / 21 / 3000 / 15:28 / cost1,
fit + holdout = the 488 common sessions). Run the templates with `--weekends` for BL-097/098.

    uv run python research/bl104/check_regression.py --tag regression490
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
COMPARE = (  # (bl104 column, earlier column suffix)
    ("n_days", "n_days"),
    ("gross_inr", "gross_inr"),
    ("charges_inr", "charges_inr"),
    ("net_inr", "net_inr"),
    ("max_drawdown_inr", "max_drawdown_inr"),
    ("worst_day_inr", "worst_day_inr"),
    ("ulcer_index_inr", "ulcer_index_inr"),
    ("n_trades", "n_trades"),
    ("mtm_stop_days", "mtm_stop_days"),
    ("reentry_count", "reentry_count"),
)
TOL = 0.01


def rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def bl097_row(family: str, base: str) -> dict[str, str] | None:
    name = "widesl" if family == "W" else "buy"
    for r in rows(RESEARCH / "bl097" / "results" / f"{name}_sweep_postcharge.csv"):
        if r["base"] == base and r["variant"] == "baseline":
            return {k[len("full_") :]: v for k, v in r.items() if k.startswith("full_")}
    return None


def bl096_row(base: str) -> dict[str, str] | None:
    for r in rows(RESEARCH / "bl096" / "results" / "primary_diagnostics_charged.csv"):
        if (
            r["base"],
            r["strike_type"],
            r["primary_sl_percent"],
            r["primary_mtm_sl_inr"],
            r["primary_exit_time"],
            r["reentry"],
            r["cutoff"],
            r["trailing"],
        ) == (base, "ATM", "21", "3000", "15:28", "cost1", "none", "none"):
            out = {}
            for key in (
                "n_days",
                "gross_inr",
                "charges_inr",
                "net_inr",
                "n_trades",
                "mtm_stop_days",
                "reentry_count",
            ):
                out[key] = str(float(r[f"fit_{key}"]) + float(r[f"holdout_{key}"]))
            return out  # drawdown / worst day / Ulcer are not additive across fit and holdout
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="regression490")
    args = parser.parse_args()
    out_dir = HERE / "results" / args.tag
    bad = 0
    for family, file_tag in (("W", "wide"), ("D", "dir"), ("B", "buy")):
        path = out_dir / f"{family}_summary.csv"
        if not path.exists():
            print(f"{family}: no summary under {out_dir}")
            continue
        for r in rows(path):
            if r["cell"] != "template":
                continue
            base = f"{r['index']}_{file_tag}_{r['slot'].replace(':', '')}"
            earlier = bl096_row(base) if family == "D" else bl097_row(family, base)
            source = "BL-096 charged (fit+holdout)" if family == "D" else "BL-097/098 full"
            if earlier is None:
                print(f"{base}: no earlier row")
                continue
            print(f"{base} vs {source}:")
            for mine, theirs in COMPARE:
                if theirs not in earlier:
                    continue
                a, b = float(r[mine]), float(earlier[theirs])
                ok = math.isclose(a, b, abs_tol=TOL)
                bad += not ok
                print(
                    f"  {mine:18s} {a:>16,.2f} {b:>16,.2f} {'ok' if ok else 'DIFF ' + format(a - b, ',.2f')}"
                )
    print("ALL MATCH" if not bad else f"{bad} differences")


if __name__ == "__main__":
    main()
