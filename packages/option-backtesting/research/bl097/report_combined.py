"""Build the final one-best-per-strategy comparison by index and time band."""

from __future__ import annotations

import argparse
import csv
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean

BANDS = ("09:15–11:00", "11:00–13:00", "13:00–15:30")
METRICS = (
    "holdout_gross_inr", "holdout_charges_inr", "holdout_net_inr",
    "holdout_avg_day_inr", "holdout_median_day_inr", "holdout_win_rate",
    "holdout_worst_day_inr", "holdout_max_drawdown_inr", "holdout_ulcer_index_inr",
    "holdout_cvar95_day_inr", "holdout_trade_expectancy_inr", "holdout_profit_factor",
    "holdout_mtm_stop_frequency", "holdout_reentry_count", "holdout_no_entry_rate",
)


def band(entry_time: str) -> str:
    hour, minute = map(int, entry_time.split(":"))
    total = hour * 60 + minute
    if total < 660:
        return BANDS[0]
    if total < 780:
        return BANDS[1]
    return BANDS[2]


def number(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def integerish(value: str) -> str:
    parsed = number(value)
    return str(int(parsed)) if math.isfinite(parsed) and parsed.is_integer() else value


def widesl_family(base: str) -> str:
    if base.startswith("N_p80"):
        return "P80"
    if base.startswith("N_p100"):
        return "P100"
    if base.startswith("N_wide"):
        return "OTM1"
    if base.startswith("S_p250"):
        return "P250"
    if base.startswith("S_p320"):
        return "P320"
    if base.startswith("S_wide"):
        return "OTM2"
    return "unknown"


def directional_label(raw: dict[str, str]) -> tuple[str, str]:
    family = raw["strike_type"]
    config = (
        f"SL {integerish(raw['primary_sl_percent'])}% / "
        f"MTM ₹{integerish(raw['primary_mtm_sl_inr'])} / "
        f"exit {raw['primary_exit_time']} / RE {raw['reentry']}"
    )
    if raw["trailing"] != "none":
        config += f" / trail {raw['trailing']}"
    if raw["cutoff"] != "none":
        config += f" / cutoff {raw['cutoff']}"
    return family, config


def load(path: Path, strategy: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with path.open(newline="") as handle:
        for raw in csv.DictReader(handle):
            if raw.get("valid", "").lower() != "true":
                continue
            if strategy == "directional":
                family, config = directional_label(raw)
            elif strategy == "buy":
                family = raw["strike_family"]
                config = raw["variant"]
            else:
                family = widesl_family(raw["base"])
                config = raw["variant"]
            row: dict[str, object] = {
                "strategy": strategy,
                "underlying": raw["underlying"],
                "band": band(raw["entry_time"]),
                "family": family,
                "config": config,
            }
            for key in METRICS:
                row[key] = number(raw.get(key, ""))
            rows.append(row)
    return rows


def aggregate(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[tuple[str, str, str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        key = (str(row["strategy"]), str(row["underlying"]), str(row["band"]), str(row["family"]), str(row["config"]))
        grouped[key].append(row)
    result: list[dict[str, object]] = []
    for (strategy, underlying, entry_band, family, config), values in grouped.items():
        row: dict[str, object] = {
            "strategy": strategy, "underlying": underlying, "band": entry_band,
            "family": family, "config": config,
        }
        for key in METRICS:
            finite = [float(value[key]) for value in values if math.isfinite(float(value[key]))]
            row[key] = mean(finite) if finite else float("nan")
        result.append(row)
    return result


def score(candidates: list[dict[str, object]], strategy: str) -> dict[str, object]:
    if strategy == "buy":
        criteria = [
            ("holdout_net_inr", True), ("holdout_avg_day_inr", True),
            ("holdout_median_day_inr", True), ("holdout_win_rate", True),
            ("holdout_max_drawdown_inr", True), ("holdout_ulcer_index_inr", False),
            ("holdout_cvar95_day_inr", True), ("holdout_trade_expectancy_inr", True),
            ("holdout_profit_factor", True), ("holdout_no_entry_rate", False),
        ]
    elif strategy == "widesl":
        criteria = [
            ("holdout_net_inr", True), ("holdout_avg_day_inr", True),
            ("holdout_median_day_inr", True), ("holdout_win_rate", True),
            ("holdout_max_drawdown_inr", True), ("holdout_worst_day_inr", True),
            ("holdout_ulcer_index_inr", False), ("holdout_cvar95_day_inr", True),
            ("holdout_trade_expectancy_inr", True), ("holdout_profit_factor", True),
            ("holdout_mtm_stop_frequency", False),
        ]
    else:
        criteria = [
            ("holdout_net_inr", True), ("holdout_avg_day_inr", True),
            ("holdout_median_day_inr", True), ("holdout_win_rate", True),
            ("holdout_max_drawdown_inr", True), ("holdout_worst_day_inr", True),
            ("holdout_ulcer_index_inr", False), ("holdout_cvar95_day_inr", True),
            ("holdout_trade_expectancy_inr", True), ("holdout_mtm_stop_frequency", False),
        ]
    for candidate in candidates:
        candidate["score"] = 0
    for key, higher in criteria:
        ordered = sorted(
            candidates,
            key=lambda row: (-float(row[key]) if higher else float(row[key]))
            if math.isfinite(float(row[key])) else math.inf,
        )
        for rank, candidate in enumerate(ordered, 1):
            candidate["score"] = int(candidate["score"]) + rank
    return min(candidates, key=lambda row: int(row["score"]))


def combined_score(candidates: list[dict[str, object]]) -> dict[str, object]:
    criteria = [
        ("holdout_net_inr", True), ("holdout_avg_day_inr", True),
        ("holdout_median_day_inr", True), ("holdout_win_rate", True),
        ("holdout_max_drawdown_inr", True), ("holdout_worst_day_inr", True),
        ("holdout_ulcer_index_inr", False), ("holdout_cvar95_day_inr", True),
        ("holdout_trade_expectancy_inr", True), ("holdout_profit_factor", True),
        ("holdout_mtm_stop_frequency", False),
    ]
    for candidate in candidates:
        candidate["combined_score"] = 0
    for key, higher in criteria:
        ordered = sorted(
            candidates,
            key=lambda row: (-float(row[key]) if higher else float(row[key]))
            if math.isfinite(float(row[key])) else math.inf,
        )
        for rank, candidate in enumerate(ordered, 1):
            candidate["combined_score"] = int(candidate["combined_score"]) + rank
    return min(candidates, key=lambda row: int(row["combined_score"]))


def inr(value: object) -> str:
    parsed = float(value)
    if not math.isfinite(parsed):
        return "—"
    return f"-₹{abs(parsed):,.0f}" if parsed < 0 else f"₹{parsed:,.0f}"


def pct(value: object) -> str:
    parsed = float(value)
    return "—" if not math.isfinite(parsed) else f"{parsed * 100:.1f}%"


def num(value: object) -> str:
    parsed = float(value)
    return "—" if not math.isfinite(parsed) else f"{parsed:.2f}"


def count(value: object) -> str:
    parsed = float(value)
    return "—" if not math.isfinite(parsed) else f"{parsed:,.1f}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directional", type=Path, required=True)
    parser.add_argument("--buy", type=Path, required=True)
    parser.add_argument("--widesl", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--final-only", action="store_true")
    args = parser.parse_args()

    rows = aggregate(load(args.directional, "directional") + load(args.buy, "buy") + load(args.widesl, "widesl"))
    grouped: dict[tuple[str, str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["underlying"]), str(row["band"]), str(row["strategy"]))].append(row)

    lines = [
        "# Combined final qualified list — Directional, Buy and Widesl",
        "",
        ("One final configuration selected after comparing Directional, Buy and Widesl "
         "for every index and timing band. This is the compact final list; it does "
         "not repeat every family or every sweep variation."
         if args.final_only else
         "One best configuration from each strategy for every index and timing band, "
         "using the same post-charge holdout comparison. This is the compact "
         "comparison list; it does not repeat every family or every sweep variation."),
        "",
        "Holdout: 2025-10-09 through 2026-10-09. Charges include ₹20 per order,",
        "STT, exchange charges, SEBI/IPFT, stamp duty and GST. Slippage is not",
        "included. Rankings use each strategy's registered balanced criteria.",
        "",
    ]
    for underlying in ("NIFTY", "SENSEX"):
        for entry_band in BANDS:
            lines += [f"## {underlying} — {entry_band}", ""]
            selected = [
                score(grouped[(underlying, entry_band, strategy)], strategy)
                for strategy in ("directional", "buy", "widesl")
                if grouped[(underlying, entry_band, strategy)]
            ]
            if args.final_only:
                selected = [combined_score(selected)]
            lines += [
                "| Strategy | Strike/family | Configuration | Pre-charge | Charges | Post-charge | Avg/day | Positive-day |",
                "|---|---|---|---:|---:|---:|---:|---:|",
            ]
            for row in selected:
                lines.append(
                    f"| {str(row['strategy']).title()} | {row['family']} | `{row['config']}` | "
                    f"{inr(row['holdout_gross_inr'])} | {inr(row['holdout_charges_inr'])} | "
                    f"{inr(row['holdout_net_inr'])} | {inr(row['holdout_avg_day_inr'])} | "
                    f"{pct(row['holdout_win_rate'])} |"
                )
            lines += [
                "",
                "| Strategy | Median/day | Max DD | Worst day | Ulcer | CVaR95/day | Exp/trade | PF | MTM stops | Re-entries |",
                "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
            ]
            for row in selected:
                lines.append(
                    f"| {str(row['strategy']).title()} | {inr(row['holdout_median_day_inr'])} | "
                    f"{inr(row['holdout_max_drawdown_inr'])} | {inr(row['holdout_worst_day_inr'])} | "
                    f"{inr(row['holdout_ulcer_index_inr'])} | {inr(row['holdout_cvar95_day_inr'])} | "
                    f"{inr(row['holdout_trade_expectancy_inr'])} | {num(row['holdout_profit_factor'])} | "
                    f"{pct(row['holdout_mtm_stop_frequency'])} | {count(row['holdout_reentry_count'])} |"
                )
            lines.append("")
    lines += [
        "## Interpretation",
        "",
        ("This report keeps only the combined winner in each index/timing section. "
         "The winner is selected from the best Directional, Buy and Widesl "
         "candidate using the balanced post-charge criteria. It is not an "
         "automatic live recommendation; fit-to-holdout stability, tail risk "
         "and forward validation still apply."
         if args.final_only else
         "This report keeps one winner per strategy in each timing band so the "
         "strategies can be compared directly. A strategy-level winner is not an "
         "automatic live recommendation; fit-to-holdout stability, tail risk and "
         "forward validation still apply."),
        "",
        "## Sources",
        "",
        "- `packages/option-backtesting/research/bl096/results/primary_diagnostics_charged.csv`",
        "- `packages/option-backtesting/research/bl097/results/buy_sweep_postcharge.csv`",
        "- `packages/option-backtesting/research/bl097/results/widesl_sweep_postcharge.csv`",
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines) + "\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
