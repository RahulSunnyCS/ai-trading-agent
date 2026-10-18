"""BL-104 Stage 3: the robustness checks, from the stored day x cell series.

pbo        CSCV / PBO per cohort over the whole Stage-1 matrix (every trial counts), at 8 and
           16 blocks. A numpy restatement of analytics/overfit.run_cscv (the stdlib one loops
           in Python per split per config: hours per cohort at 16 blocks); a unit test pins
           the two to each other.
finalists  for each band's top parameter set (score.py's band winners): the pooled candidate
           and template series at the band's slots, the block bootstrap of their difference
           (rotation.readout.block_bootstrap_mean: 5-day circular blocks, 2,000 resamples,
           seed 20261012), the four half-years, the DTE and VIX strata (rotation/days.csv),
           and the correlation among the finalists (analytics/correlation.analyse).

uv run python research/bl104/robust.py pbo --tag stage1 --family W
uv run python research/bl104/robust.py finalists --tag stage1 --family all
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import math
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402

from option_backtesting.analytics.correlation import Series, analyse  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402

RESULTS = HERE / "results"
TRADING_DAYS_PER_YEAR = 252
HALF_YEARS = (
    ("2024H2", date(2024, 10, 9), date(2025, 3, 31)),
    ("2025H1", date(2025, 4, 1), date(2025, 9, 30)),
    ("2025H2", date(2025, 10, 1), date(2026, 3, 31)),
    ("2026H1", date(2026, 4, 1), date(2026, 10, 9)),
)
DTE_BUCKETS = (("0", 0, 0), ("1", 1, 1), ("2-3", 2, 3), ("4+", 4, 99))
REGIME_SHARE = 0.60  # more of the edge than this from one bucket = a regime bet (Phase 0, rule 7)
PBO_LIMIT = 0.5


# ---------------------------------------------------------------------------- series


def load_series(out_dir: Path, cohort: str) -> tuple[np.ndarray, list[str], list[date]]:
    matrix = np.load(out_dir / "series" / f"{cohort}.npy").astype(float)
    meta = json.loads((out_dir / "series" / f"{cohort}.json").read_text())
    return matrix, meta["labels"], [date.fromisoformat(d) for d in meta["days"]]


def column(out_dir: Path, cohort: str, label: str) -> tuple[np.ndarray, list[date]]:
    matrix, labels, days = load_series(out_dir, cohort)
    return matrix[:, labels.index(label)], days


# ---------------------------------------------------------------------------- CSCV


def _block_bounds(n: int, n_blocks: int) -> list[tuple[int, int]]:
    base, extra = divmod(n, n_blocks)
    bounds, start = [], 0
    for i in range(n_blocks):
        size = base + (1 if i < extra else 0)
        bounds.append((start, start + size))
        start += size
    return bounds


def _sharpe_from_moments(n: np.ndarray, s: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Sample mean / sample stdev (ddof=1) from (count, sum, sum of squares) per config; 0 for
    fewer than 2 values or zero variance — overfit._sharpe's conventions."""
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / n
        var = (q - n * mean**2) / (n - 1)
        var = np.where(var < 1e-12, 0.0, var)  # rounding noise is zero variance
        std = np.sqrt(var)
        out = np.where((n >= 2) & (std > 0), mean / np.where(std > 0, std, 1.0), 0.0)
    return out


def cscv_pbo(matrix: np.ndarray, n_blocks: int) -> tuple[float, int]:
    """(PBO, number of IS/OOS splits) of a days x configs matrix — overfit.run_cscv restated:
    contiguous blocks, every half-and-half split, the in-sample best (first argmax) counted when
    its out-of-sample rank among all configs is at or below the median."""
    n_days, n_configs = matrix.shape
    if n_configs < 2 or n_blocks < 2 or n_blocks % 2 or n_days < 2 * n_blocks:
        raise ValueError("CSCV needs >= 2 configs, an even n_blocks and >= 2 * n_blocks days")
    bounds = _block_bounds(n_days, n_blocks)
    counts = np.array([b - a for a, b in bounds], dtype=float)
    sums = np.stack([matrix[a:b].sum(axis=0) for a, b in bounds])  # blocks x configs
    squares = np.stack([(matrix[a:b] ** 2).sum(axis=0) for a, b in bounds])
    below = 0
    combos = list(itertools.combinations(range(n_blocks), n_blocks // 2))
    for combo in combos:
        is_mask = np.zeros(n_blocks, dtype=bool)
        is_mask[list(combo)] = True
        is_perf = _sharpe_from_moments(
            counts[is_mask].sum(), sums[is_mask].sum(axis=0), squares[is_mask].sum(axis=0)
        )
        oos_perf = _sharpe_from_moments(
            counts[~is_mask].sum(), sums[~is_mask].sum(axis=0), squares[~is_mask].sum(axis=0)
        )
        best = int(np.argmax(is_perf))
        rank = (oos_perf <= oos_perf[best]).sum() / (n_configs + 1)
        below += rank <= 0.5
    return below / len(combos), len(combos)


def pbo_cohorts(out_dir: Path, family: str, blocks: tuple[int, ...]) -> list[dict[str, Any]]:
    rows = []
    for path in sorted((out_dir / "series").glob(f"{family}_*.npy")):
        cohort = path.stem
        matrix, labels, days = load_series(out_dir, cohort)
        row: dict[str, Any] = {"cohort": cohort, "n_configs": len(labels), "n_days": len(days)}
        for n_blocks in blocks:
            pbo, splits = cscv_pbo(matrix, n_blocks)
            row[f"pbo_{n_blocks}"] = pbo
            row[f"splits_{n_blocks}"] = splits
        row["pbo_ok"] = all(row[f"pbo_{b}"] <= PBO_LIMIT for b in blocks)
        rows.append(row)
        print(
            f"{cohort}: " + ", ".join(f"PBO{b}={row[f'pbo_{b}']:.2f}" for b in blocks), flush=True
        )
    return rows


# ---------------------------------------------------------------------------- finalists


def calmar(values: np.ndarray) -> float:
    if values.size == 0:
        return float("nan")
    annual = values.mean() * TRADING_DAYS_PER_YEAR
    dd = max_drawdown(values)
    return annual / abs(dd) if dd < 0 else float("inf")


def half_years(days: list[date], values: np.ndarray) -> list[dict[str, Any]]:
    out = []
    d = np.array(days)
    for name, start, end in HALF_YEARS:
        mask = (d >= start) & (d <= end)
        v = values[mask]
        out.append(
            {
                "period": name,
                "n_days": int(mask.sum()),
                "avg_day_inr": float(v.mean()) if v.size else float("nan"),
                "calmar": calmar(v),
            }
        )
    return out


def load_day_attrs(root: Path) -> dict[date, dict[str, str]]:
    path = root / "rotation" / "days.csv"
    if not path.exists():
        return {}
    with path.open(newline="") as handle:
        return {date.fromisoformat(r["day"]): r for r in csv.DictReader(handle)}


def strata(
    days: list[date],
    candidate: np.ndarray,
    template: np.ndarray,
    attrs: dict[date, dict[str, str]],
    underlying: str,
) -> list[dict[str, Any]]:
    """Candidate and template rupees per lot-day, and the share of the edge (candidate minus
    template), by days-to-expiry bucket, by VIX band and by weekday. Weekday is reported only
    (owner, 2026-10-15: a calendar label is not a mechanism); the regime flag reads DTE and VIX."""
    dte_key = "dte_n" if underlying == "NIFTY" else "dte_s"
    edge = candidate - template
    total_edge = edge.sum()
    rows = []
    groups: dict[tuple[str, str], list[int]] = defaultdict(list)
    for i, day in enumerate(days):
        a = attrs.get(day)
        if a is None:
            groups[("dte", "unknown")].append(i)
            groups[("vix", "unknown")].append(i)
            groups[("weekday", day.strftime("%a"))].append(i)
            continue
        dte = a.get(dte_key, "")
        label = "unknown"
        dte = dte.rstrip("+")  # days.csv writes rotation.score.dte_label: "0".."6" or "7+"
        if dte.isdigit():
            n = int(dte)
            label = next(name for name, lo, hi in DTE_BUCKETS if lo <= n <= hi)
        groups[("dte", label)].append(i)
        groups[("vix", a.get("vix_band", "unknown") or "unknown")].append(i)
        groups[("weekday", a.get("weekday", "") or day.strftime("%a"))].append(i)
    for (kind, label), idx in sorted(groups.items()):
        ix = np.array(idx)
        rows.append(
            {
                "stratum": kind,
                "bucket": label,
                "n_days": len(idx),
                "candidate_avg_inr": float(candidate[ix].mean()),
                "template_avg_inr": float(template[ix].mean()),
                "edge_share": float(edge[ix].sum() / total_edge)
                if total_edge > 0
                else float("nan"),
            }
        )
    return rows


def pooled(
    out_dir: Path, family: str, index: str, slots: list[str], params: dict[str, Any] | None
) -> tuple[np.ndarray, list[date]]:
    """Mean across the band's slots of a parameter set's daily net (still rupees per lot-day)."""
    series = []
    days_ref: list[date] | None = None
    for slot in slots:
        cell = grid.Cell(family, index, slot, params)
        values, days = column(out_dir, cell.cohort, cell.label)
        if days_ref is None:
            days_ref = days
        elif days != days_ref:
            raise ValueError(f"{cell.cohort}: day list differs from the band's first slot")
        series.append(values)
    assert days_ref is not None
    return np.mean(series, axis=0), days_ref


WINNERS_SUFFIX = ""  # set from --suffix: "_tail" reads and writes the tail-gated selection


def read_winners(out_dir: Path, family: str, top: int) -> list[dict[str, Any]]:
    path = out_dir / f"{family}_band_winners{WINNERS_SUFFIX}.csv"
    if not path.exists():
        return []
    with path.open(newline="") as handle:
        rows = [
            r
            for r in csv.DictReader(handle)
            if r["band_candidate"] == "True" and int(r["band_rank"]) <= top
        ]
    for r in rows:
        r["params"] = grid.params_from_row(family, r)
    return rows


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def joined_rules(
    out_dir: Path,
    stage2_dir: Path | None,
    breadth_dir: Path | None,
    name: str,
    family: str,
    index: str,
    band_: str,
    slots: list[str],
) -> dict[str, Any]:
    """Rules 3, 4 and 6 come from other files; absent = not yet run (None), never a pass."""
    out: dict[str, Any] = {"rule3_flat": None, "rule4_breadth": None, "rule6_pbo": None}
    if stage2_dir is not None:
        if ("tail" in stage2_dir.name) != (WINNERS_SUFFIX == "_tail"):
            raise SystemExit(
                f"--suffix {WINNERS_SUFFIX!r} but the Stage 2 directory is {stage2_dir.name!r}: "
                "the tail-gated and return-only selections share winner names; refusing to mix"
            )
        for r in read_csv(stage2_dir / "flatness.csv"):
            if r["winner"] == name:
                out["rule3_flat"] = r["rule3_flat"] == "True"
    pbo = {r["cohort"]: r for r in read_csv(out_dir / "pbo.csv")}
    cohorts = [grid.Cell(family, index, s, None).cohort for s in slots]
    if pbo and all(c in pbo for c in cohorts):
        out["rule6_pbo"] = all(pbo[c]["pbo_ok"] == "True" for c in cohorts)
    if breadth_dir is not None:
        for r in read_csv(breadth_dir / f"breadth{WINNERS_SUFFIX}.csv"):
            if r["finalist"] == name:
                out["rule4_breadth"] = r["rule4_breadth"] == "True"
    return out


def breadth(
    out_dir: Path, families: tuple[str, ...], stage1_dir: Path, top: int
) -> list[dict[str, Any]]:
    """Rule 4 over an all-25-slot run of the finalists (`slots-cells` -> run_grid --cells): at the
    band's slots, the sign of rupees per lot-day and Calmar >= 1 must hold on >= 70 % of slots."""
    rows = []
    for family in families:
        summary = {r["label"]: r for r in read_csv(out_dir / f"{family}_summary.csv")}
        for w in read_winners(stage1_dir, family, top):
            index, band_ = w["index"], w["band"]
            name = f"{family}_{index}_{band_}"
            hits = []
            for r in summary.values():
                cell_band = grid.band(r["slot"])
                if r["index"] != index or cell_band != band_ or r["cell"] == "template":
                    continue
                if grid.params_from_row(family, r) != w["params"]:
                    continue
                avg, calmar_ = float(r["avg_day_inr"]), float(r["calmar"])
                hits.append(avg > 0 and calmar_ >= 1.0)
            share = sum(hits) / len(hits) if hits else float("nan")
            rows.append(
                {
                    "finalist": name,
                    "slots_checked": len(hits),
                    "share_ok": share,
                    "rule4_breadth": bool(hits) and share >= 0.7,
                }
            )
            print(
                f"{name}: {sum(hits)}/{len(hits)} band slots positive with Calmar >= 1 -> rule 4 {'PASS' if rows[-1]['rule4_breadth'] else 'FAIL'}",
                flush=True,
            )
    return rows


def slots_cells(stage1_dir: Path, families: tuple[str, ...], top: int, out_path: Path) -> None:
    """The finalists' parameter sets at every rotation slot (the 25 of `strategies/rotation/`),
    plus the template at each, as a cells.json for run_grid.py."""
    slots = sorted(
        {p.stem[-4:][:2] + ":" + p.stem[-2:] for p in grid.ROTATION.glob("N_wide_*.yaml")}
    )
    items = []
    for family in families:
        for w in read_winners(stage1_dir, family, top):
            for slot in slots:
                if not grid.template_path(family, w["index"], slot).exists():
                    continue
                for params in (w["params"], None):
                    items.append(
                        {
                            "family": family,
                            "index": w["index"],
                            "slot": slot,
                            "params": params,
                            "finalist": f"{family}_{w['index']}_{w['band']}",
                        }
                    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(items, indent=1, default=list))
    print(f"{len(items)} cells at {len(slots)} slots -> {out_path}", flush=True)


def check_finalists(
    out_dir: Path,
    families: tuple[str, ...],
    top: int,
    root: Path,
    stage2_dir: Path | None = None,
    breadth_dir: Path | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    attrs = load_day_attrs(root)
    summary: list[dict[str, Any]] = []
    detail: list[dict[str, Any]] = []
    finalist_series: list[Series] = []
    lines = ["# BL-104 Stage 3 — finalists vs their templates", ""]
    for family in families:
        for w in read_winners(out_dir, family, top):
            index, band_ = w["index"], w["band"]
            slots = w["slots"].split(",")
            underlying = grid.INDICES[index]
            cand, days = pooled(out_dir, family, index, slots, w["params"])
            tmpl, _ = pooled(out_dir, family, index, slots, None)
            diff = cand - tmpl
            mean, lo, hi = block_bootstrap_mean(diff)
            cand_dd, tmpl_dd = max_drawdown(cand), max_drawdown(tmpl)
            cand_ulcer = ulcer(cand)
            tmpl_ulcer = ulcer(tmpl)
            halves = half_years(days, cand)
            positive = sum(h["avg_day_inr"] > 0 for h in halves if h["n_days"])
            weak = any(h["calmar"] < 0.5 for h in halves if h["n_days"])
            strata_rows = strata(days, cand, tmpl, attrs, underlying)
            regime = max(
                (
                    s["edge_share"]
                    for s in strata_rows
                    if s["stratum"] in ("dte", "vix")
                    and s["bucket"] != "unknown"
                    and not math.isnan(s["edge_share"])
                ),
                default=float("nan"),
            )
            reentry = w["params"].get("reentry")
            parity = reentry is not None and (reentry[0] == "asap" or reentry[1] >= 2)
            name = f"{family}_{index}_{band_}"
            row = {
                "finalist": name,
                "family": family,
                "index": index,
                "band": band_,
                "slots": w["slots"],
                "params": json.dumps(w["params"], default=str),
                "n_days": len(days),
                "candidate_avg_inr": float(cand.mean()),
                "template_avg_inr": float(tmpl.mean()),
                "diff_mean_inr": mean,
                "diff_lower90_inr": lo,
                "diff_upper90_inr": hi,
                "rule1_bootstrap_lower_gt_0": lo > 0,
                "candidate_max_dd_inr": cand_dd,
                "template_max_dd_inr": tmpl_dd,
                "candidate_ulcer_inr": cand_ulcer,
                "template_ulcer_inr": tmpl_ulcer,
                "rule2_dd_and_ulcer_within_10pct": cand_dd >= 1.1 * tmpl_dd
                and cand_ulcer <= 1.1 * tmpl_ulcer,
                "half_years_positive": positive,
                "rule5_half_years": positive >= 3 and not weak,
                "max_edge_share": regime,
                "rule7_not_regime_bet": not (regime > REGIME_SHARE)
                if not math.isnan(regime)
                else True,
                "rule8_parity_verified": not parity,
                **joined_rules(out_dir, stage2_dir, breadth_dir, name, family, index, band_, slots),
            }
            summary.append(row)
            for h in halves:
                detail.append({"finalist": name, "kind": "half_year", **h})
            for s in strata_rows:
                detail.append(
                    {
                        "finalist": name,
                        "kind": s["stratum"],
                        **{k: v for k, v in s.items() if k != "stratum"},
                    }
                )
            finalist_series.append(
                Series(
                    name=name,
                    kind="legwise",
                    values={d: float(v) for d, v in zip(days, cand, strict=True)},
                )
            )
            lines += [
                f"## {name} (slots {w['slots']})",
                "",
                f"- params: `{json.dumps(w['params'], default=str)}`",
                f"- ₹/lot-day: candidate {cand.mean():,.0f} vs template {tmpl.mean():,.0f}; difference {mean:,.0f}, 90 % interval [{lo:,.0f}, {hi:,.0f}] → rule 1 {'PASS' if lo > 0 else 'FAIL'}",
                f"- max DD {cand_dd:,.0f} vs {tmpl_dd:,.0f}; Ulcer {cand_ulcer:,.0f} vs {tmpl_ulcer:,.0f} → rule 2 {'PASS' if row['rule2_dd_and_ulcer_within_10pct'] else 'FAIL'}",
                "- half-years: "
                + "; ".join(
                    f"{h['period']} {h['avg_day_inr']:,.0f}/day Calmar {h['calmar']:.2f}"
                    for h in halves
                    if h["n_days"]
                )
                + f" → rule 5 {'PASS' if row['rule5_half_years'] else 'FAIL'}",
                f"- largest edge share from one bucket {regime:.0%} → rule 7 {'PASS' if row['rule7_not_regime_bet'] else 'FLAG regime bet'}",
                f"- re-entry parity: {'PASS' if not parity else 'parity_unverified (RE ASAP or RE COST x2)'}",
                "",
            ]
    if len(finalist_series) >= 2:
        report = analyse(finalist_series)
        lines += ["## Correlation among finalists (daily net, Pearson)", ""]
        lines.append("| | " + " | ".join(report.names) + " |")
        lines.append("|---|" + "---|" * len(report.names))
        for i, name in enumerate(report.names):
            lines.append(
                f"| {name} | "
                + " | ".join(f"{report.pearson[i, j]:.2f}" for j in range(len(report.names)))
                + " |"
            )
        lines += [
            "",
            f"Equal-lot basket: net {report.basket.net:,.0f}, max DD {report.basket.max_dd:,.0f}, loss-day share {report.basket.loss_day_share:.0%}; sum of the parts' max DD {sum(p.max_dd for p in report.parts.values()):,.0f}",
            "",
        ]
    return summary, detail, "\n".join(lines) + "\n"


def ulcer(values: np.ndarray) -> float:
    eq = np.cumsum(values)
    under = eq - np.maximum.accumulate(np.maximum(eq, 0.0))
    return float(np.sqrt((np.minimum(under, 0.0) ** 2).mean())) if values.size else float("nan")


# ---------------------------------------------------------------------------- CLI


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    fields = list(dict.fromkeys(k for r in rows for k in r))
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pbo")
    p.add_argument("--tag", default="stage1")
    p.add_argument("--family", default="all")
    p.add_argument("--blocks", default="8,16")
    f = sub.add_parser("finalists")
    f.add_argument("--tag", default="stage1")
    f.add_argument("--family", default="all")
    f.add_argument("--top", type=int, default=1)
    f.add_argument("--root", type=Path, default=None)
    f.add_argument("--stage2", default=None, help="tag of the Stage-2 run (rule 3)")
    f.add_argument("--breadth", default=None, help="tag of the all-25-slot run (rule 4)")
    b = sub.add_parser("breadth")
    b.add_argument("--tag", required=True, help="tag the all-25-slot run was written under")
    b.add_argument("--stage1", default="stage1")
    b.add_argument("--family", default="all")
    b.add_argument("--top", type=int, default=1)
    c = sub.add_parser("slots-cells")
    c.add_argument("--stage1", default="stage1")
    c.add_argument("--family", default="all")
    c.add_argument("--top", type=int, default=1)
    c.add_argument("--out", type=Path, default=None)
    for sp in (f, b, c):
        sp.add_argument("--suffix", default="", help="winners file suffix, e.g. _tail")
    args = parser.parse_args()
    global WINNERS_SUFFIX
    WINNERS_SUFFIX = getattr(args, "suffix", "") or ""
    out_dir = RESULTS / getattr(args, "tag", "stage1")
    families = grid.FAMILIES if args.family == "all" else tuple(args.family.split(","))
    if args.command == "breadth":
        rows = breadth(out_dir, families, RESULTS / args.stage1, args.top)
        write_csv(out_dir / f"breadth{WINNERS_SUFFIX}.csv", rows)
        print(f"wrote {out_dir / 'breadth.csv'}", flush=True)
        return
    if args.command == "slots-cells":
        slots_cells(
            RESULTS / args.stage1,
            families,
            args.top,
            args.out or RESULTS / "stage3_slots" / "cells.json",
        )
        return
    if args.command == "pbo":
        blocks = tuple(int(b) for b in args.blocks.split(","))
        rows = []
        for family in families:
            rows += pbo_cohorts(out_dir, family, blocks)
        write_csv(out_dir / "pbo.csv", rows)
        print(f"wrote {out_dir / 'pbo.csv'}", flush=True)
    else:
        summary, detail, text = check_finalists(
            out_dir,
            families,
            args.top,
            args.root or data_dir(),
            RESULTS / args.stage2 if args.stage2 else None,
            RESULTS / args.breadth if args.breadth else None,
        )
        write_csv(out_dir / f"finalists{WINNERS_SUFFIX}.csv", summary)
        write_csv(out_dir / f"finalists_detail{WINNERS_SUFFIX}.csv", detail)
        (out_dir / f"robust{WINNERS_SUFFIX}.md").write_text(text)
        print(
            f"wrote {out_dir / 'finalists.csv'} and robust.md ({len(summary)} finalists)",
            flush=True,
        )
        for row in summary:
            rules = {k: v for k, v in row.items() if k.startswith("rule")}
            pending = [k for k, v in rules.items() if v is None]
            verdict = (
                "PENDING " + ",".join(k[:5] for k in pending)
                if pending
                else ("PASS" if all(rules.values()) else "FAIL")
            )
            print(
                f"{row['finalist']}: {verdict} — "
                + ", ".join(
                    f"{k[:5]} {'ok' if row[k] else ('?' if row[k] is None else 'no')}"
                    for k in row
                    if k.startswith("rule")
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
