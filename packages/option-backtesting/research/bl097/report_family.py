"""Create a compact qualified-list Markdown report from a family sweep CSV."""

from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean


def number(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def band(entry_time: str) -> str:
    hour, minute = map(int, entry_time.split(":"))
    total = hour * 60 + minute
    if total < 660:
        return "09:15–11:00"
    if total < 780:
        return "11:00–13:00"
    return "13:00–15:30"


def family_name(row: dict[str, str], family: str) -> str:
    if family == "buy":
        return "Buy"
    base = row["base"]
    if base.startswith("N_p80"):
        return "NIFTY P80"
    if base.startswith("N_p100"):
        return "NIFTY P100"
    if base.startswith("N_wide"):
        return "NIFTY OTM1"
    if base.startswith("S_p250"):
        return "SENSEX P250"
    if base.startswith("S_p320"):
        return "SENSEX P320"
    if base.startswith("S_wide"):
        return "SENSEX OTM2"
    return row["underlying"]


def mean_metric(rows: list[dict[str, float]], key: str) -> float:
    values = [row[key] for row in rows if math.isfinite(row[key])]
    return mean(values) if values else float("nan")


def fmt_inr(value: float) -> str:
    if not math.isfinite(value):
        return "—"
    return f"-₹{abs(value):,.0f}" if value < 0 else f"₹{value:,.0f}"


def fmt_pct(value: float) -> str:
    return "—" if not math.isfinite(value) else f"{value * 100:.1f}%"


def fmt_num(value: float) -> str:
    return "—" if not math.isfinite(value) else f"{value:.2f}"


def fmt_count(value: float) -> str:
    return "—" if not math.isfinite(value) else f"{value:,.1f}"


def load(path: Path, family: str) -> list[dict[str, object]]:
    out = []
    with path.open(newline="") as handle:
        for raw in csv.DictReader(handle):
            if raw["valid"].lower() != "true":
                continue
            row: dict[str, object] = {
                "underlying": raw["underlying"],
                "entry_time": raw["entry_time"],
                "band": band(raw["entry_time"]),
                "family": family_name(raw, family),
                "variant": raw["variant"],
            }
            for key, value in raw.items():
                if key.startswith("holdout_"):
                    row[key] = number(value)
            out.append(row)
    return out


def aggregate(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[tuple[str, str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["underlying"]), str(row["family"]), str(row["band"]), str(row["variant"]))].append(row)
    keys = [
        "holdout_gross_inr", "holdout_charges_inr", "holdout_net_inr", "holdout_avg_day_inr",
        "holdout_median_day_inr", "holdout_win_rate", "holdout_worst_day_inr", "holdout_max_drawdown_inr",
        "holdout_ulcer_index_inr", "holdout_cvar95_day_inr", "holdout_trade_expectancy_inr",
        "holdout_profit_factor", "holdout_mtm_stop_frequency", "holdout_entry_hit_rate",
        "holdout_no_entry_rate", "holdout_avg_hold_minutes", "holdout_one_leg_sl_days",
        "holdout_both_leg_sl_days", "holdout_reentry_count", "holdout_n_trades",
    ]
    result = []
    for (underlying, family, entry_band, variant), values in grouped.items():
        row: dict[str, object] = {"underlying": underlying, "family": family, "band": entry_band, "variant": variant}
        for key in keys:
            row[key] = mean_metric([{key: float(v.get(key, float("nan")))} for v in values], key)
        result.append(row)
    return result


def score_rows(rows: list[dict[str, object]], family: str, limit: int | None = None) -> list[dict[str, object]]:
    if family == "buy":
        criteria = [
            ("holdout_net_inr", True), ("holdout_avg_day_inr", True), ("holdout_median_day_inr", True),
            ("holdout_win_rate", True), ("holdout_max_drawdown_inr", True), ("holdout_ulcer_index_inr", False),
            ("holdout_cvar95_day_inr", True), ("holdout_trade_expectancy_inr", True),
            ("holdout_profit_factor", True), ("holdout_entry_hit_rate", True), ("holdout_no_entry_rate", False),
        ]
    else:
        criteria = [
            ("holdout_net_inr", True), ("holdout_avg_day_inr", True), ("holdout_median_day_inr", True),
            ("holdout_win_rate", True), ("holdout_max_drawdown_inr", True), ("holdout_worst_day_inr", True),
            ("holdout_ulcer_index_inr", False), ("holdout_cvar95_day_inr", True),
            ("holdout_trade_expectancy_inr", True), ("holdout_profit_factor", True),
            ("holdout_mtm_stop_frequency", False),
        ]
    for row in rows:
        row["rank_score"] = 0.0
    for key, higher in criteria:
        ordered = sorted(
            rows,
            key=lambda row: (-(float(row[key])) if higher else float(row[key]))
            if math.isfinite(float(row[key])) else math.inf,
        )
        for rank, row in enumerate(ordered, 1):
            row["rank_score"] = float(row["rank_score"]) + rank
    # The family-level Widesl read-out shows four rows; an index-level view
    # passes a limit of three so all strike/premium families compete together.
    if limit is None:
        limit = 4 if family == "widesl" else 3
    return sorted(rows, key=lambda row: float(row["rank_score"]))[:limit]


def performance_table(rows: list[dict[str, object]]) -> list[str]:
    lines = [
        "| Rank | Variant | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |",
        "|---:|---|---:|---:|---:|---:|---:|",
    ]
    for rank, row in enumerate(rows, 1):
        display_variant = row.get("display_variant", row["variant"])
        lines.append(
            f"| {rank} | `{display_variant}` | {fmt_inr(float(row['holdout_gross_inr']))} | "
            f"{fmt_inr(float(row['holdout_charges_inr']))} | {fmt_inr(float(row['holdout_net_inr']))} | "
            f"{fmt_inr(float(row['holdout_avg_day_inr']))} | {fmt_pct(float(row['holdout_win_rate']))} |"
        )
    return lines


def risk_table(rows: list[dict[str, object]], family: str) -> list[str]:
    if family == "buy":
        header = "| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | Entry hit | No entry | Avg hold |"
        divider = "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    else:
        header = "| Rank | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |"
        divider = "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    lines = [header, divider]
    for rank, row in enumerate(rows, 1):
        if family == "buy":
            lines.append(
                f"| {rank} | {fmt_inr(float(row['holdout_median_day_inr']))} | {fmt_inr(float(row['holdout_max_drawdown_inr']))} | "
                f"{fmt_inr(float(row['holdout_worst_day_inr']))} | {fmt_inr(float(row['holdout_ulcer_index_inr']))} | "
                f"{fmt_inr(float(row['holdout_cvar95_day_inr']))} | {fmt_inr(float(row['holdout_trade_expectancy_inr']))} | "
                f"{fmt_pct(float(row['holdout_entry_hit_rate']))} | {fmt_pct(float(row['holdout_no_entry_rate']))} | "
                f"{fmt_num(float(row['holdout_avg_hold_minutes']))}m |"
            )
        else:
            lines.append(
                f"| {rank} | {fmt_inr(float(row['holdout_median_day_inr']))} | {fmt_inr(float(row['holdout_max_drawdown_inr']))} | "
                f"{fmt_inr(float(row['holdout_worst_day_inr']))} | {fmt_inr(float(row['holdout_ulcer_index_inr']))} | "
                f"{fmt_inr(float(row['holdout_cvar95_day_inr']))} | {fmt_inr(float(row['holdout_trade_expectancy_inr']))} | "
                f"{fmt_num(float(row['holdout_profit_factor']))} | {fmt_pct(float(row['holdout_mtm_stop_frequency']))} | "
                f"{fmt_count(float(row['holdout_reentry_count']))} |"
            )
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", choices=("buy", "widesl"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scope", choices=("family", "index"), default="family")
    args = parser.parse_args()
    family = args.family
    rows = aggregate(load(args.input, family))
    if args.scope == "index":
        for row in rows:
            row["display_variant"] = f"{row['family']} / {row['variant']}"
    groups: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        group_family = "INDEX" if args.scope == "index" else str(row["family"])
        groups[(str(row["underlying"]), group_family, str(row["band"]))].append(row)
    ordered_groups = sorted(groups, key=lambda key: (key[0], key[1], ("09:15–11:00", "11:00–13:00", "13:00–15:30").index(key[2])))
    title = "Buy" if family == "buy" else "Widesl"
    backlog_id = "097" if family == "buy" else "098"
    lines = [
        f"# BL-{backlog_id} {title} qualified list — post-charge sweep",
        "",
        f"Qualified {title} configurations from the registered one-factor sweep, ranked separately by {'index and' if args.scope == 'index' else 'underlying, family and'} entry-time band.",
        "The holdout is 2025-10-09 through 2026-10-09; values are averages across the exact entry-time files in each section.",
        "Results include ₹20 per order, STT, exchange charges, SEBI/IPFT, stamp duty and GST; slippage is not included.",
        "",
        "## Ranking contract",
        "",
    ]
    if family == "buy":
        lines += [
            "Buy prioritizes post-charge return, drawdown, Ulcer Index, CVaR, expectancy, profit factor and entry quality.",
            "Positive-day rate is secondary to entry-hit rate and payoff because no-entry days are part of the daily result.",
        ]
    else:
        lines += [
            ("Widesl shows the best four configurations across all strike/premium families for each index and time band, prioritizing post-charge return, tail loss, CVaR, maximum drawdown, Ulcer Index and expectancy."
             if args.scope == "index" else
             "Widesl shows the best four configurations per family and time band, prioritizing post-charge return, tail loss, CVaR, maximum drawdown, Ulcer Index and expectancy."),
            "Win rate is secondary; MTM stops, re-entry turnover and the loss tail must remain controlled.",
        ]
    lines += ["Candidates still require fit-to-holdout stability and a separate owner decision before deployment.", ""]
    current_family = None
    for key in ordered_groups:
        underlying, family_name_value, entry_band = key
        heading_family = underlying if args.scope == "index" else (family_name_value if family == "widesl" else underlying)
        if heading_family != current_family:
            lines += [f"## {heading_family}", ""]
            current_family = heading_family
        lines += [f"### {entry_band}", ""]
        selected = score_rows(groups[key], family, limit=4 if args.scope == "index" else None)
        lines += performance_table(selected) + ["", *risk_table(selected, family), ""]
    lines += [
        "## Source",
        "",
        f"Machine-readable results: `{args.input}`.",
        "Invalid configurations are retained in the CSV with an error and excluded from ranking.",
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n")
    print(f"wrote {args.output} with {len(ordered_groups)} sections")


if __name__ == "__main__":
    main()
