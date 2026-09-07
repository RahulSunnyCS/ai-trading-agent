"""
Parameter sweep runner (M-5). Runs a base strategy against a list of
change-dicts (each deep-merged into the base's parsed YAML, same mechanism
as the MCP server's `propose_strategy` tool — see strategy/mutate.py) over
one shared date window, collecting every configuration's result. This is
the raw material `analytics/overfit.py`'s CSCV/PBO guard needs: it can only
say anything about overfitting if it can see how many configs were tried
and how each one performed, not just the one an author is about to ship.

A config that fails to validate, or finds no cached sessions in the shared
window, is recorded with its error rather than silently dropped — a sweep
report that quietly shrinks from N configs to fewer would misrepresent how
many trials were actually run, which is exactly the number CSCV/PBO needs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import yaml

from ..data.cache import Cache
from ..data.reference.loader import ReferenceData
from ..engine.loop import run_backtest
from ..engine.result import AggregateResult, aggregate
from ..strategy.loader import StrategyValidationError, load_strategy_from_source
from ..strategy.mutate import deep_merge


@dataclass(frozen=True)
class SweepConfigResult:
    label: str
    changes: dict[str, Any]
    yaml_text: str
    result: AggregateResult | None
    error: str | None


@dataclass(frozen=True)
class SweepReport:
    date_from: date
    date_to: date
    configs: list[SweepConfigResult]

    @property
    def n_configs(self) -> int:
        return len(self.configs)

    @property
    def successful(self) -> list[SweepConfigResult]:
        return [c for c in self.configs if c.result is not None]


def run_sweep(
    base_yaml_text: str,
    changes_list: list[dict[str, Any]],
    cache: Cache,
    reference: ReferenceData,
    date_from: date,
    date_to: date,
) -> SweepReport:
    if not changes_list:
        raise ValueError(
            "run_sweep needs at least one change-dict — an empty sweep tests nothing."
        )

    base_data = yaml.safe_load(base_yaml_text)
    configs: list[SweepConfigResult] = []

    for i, changes in enumerate(changes_list):
        label = f"config_{i}"
        merged = deep_merge(base_data, changes)
        merged_yaml = yaml.safe_dump(merged, sort_keys=False)

        try:
            loaded = load_strategy_from_source(merged_yaml, label=label)
        except StrategyValidationError as e:
            configs.append(
                SweepConfigResult(
                    label=label,
                    changes=changes,
                    yaml_text=merged_yaml,
                    result=None,
                    error="; ".join(e.errors),
                )
            )
            continue

        assert loaded.strategy is not None
        sessions = run_backtest(loaded, cache, reference, date_from, date_to)
        if not sessions:
            configs.append(
                SweepConfigResult(
                    label=label,
                    changes=changes,
                    yaml_text=merged_yaml,
                    result=None,
                    error=f"No cached sessions in [{date_from}, {date_to}]",
                )
            )
            continue

        configs.append(
            SweepConfigResult(
                label=label,
                changes=changes,
                yaml_text=merged_yaml,
                result=aggregate(sessions),
                error=None,
            )
        )

    return SweepReport(date_from=date_from, date_to=date_to, configs=configs)


def render_sweep(report: SweepReport) -> str:
    lines = [
        f"Sweep [{report.date_from} .. {report.date_to}]: {report.n_configs} config(s), "
        f"{len(report.successful)} succeeded",
        "",
    ]
    ranked = sorted(report.successful, key=lambda c: c.result.net_inr, reverse=True)  # type: ignore[union-attr]
    for c in ranked:
        assert c.result is not None
        lines.append(
            f"  {c.label}: net={c.result.net_inr:.0f}  "
            f"INR/lot-day={c.result.inr_per_lot_day:.0f}  win_days={c.result.win_days}"
        )
    failed = [c for c in report.configs if c.result is None]
    if failed:
        lines.append("")
        lines.append("Failed configs:")
        for c in failed:
            lines.append(f"  {c.label}: {c.error}")
    return "\n".join(lines)
