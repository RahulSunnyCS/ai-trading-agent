"""Committed characterization scenarios for the Fyers leg-wise engine.

These snapshots answer "did the engine's observable result change?" They are
not, by themselves, proof that every current result is financially correct.
Focused unit tests and externally checked parity cases remain the correctness
oracles. A legitimate engine correction should therefore fail these scenarios,
receive a reviewed diff, and update the expected file explicitly.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import load_day, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise
from option_backtesting.legwise.store import spec_hash

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_ROOT = Path(__file__).parent
FIXTURE_ROOT = GOLDEN_ROOT / "legwise_fixture"
EXPECTED_PATH = GOLDEN_ROOT / "legwise_expected.json"
STRATEGIES_ROOT = PACKAGE_ROOT / "strategies" / "legwise"
REFERENCE_ROOT = PACKAGE_ROOT / "src" / "option_backtesting" / "data" / "reference"

DAYS = (
    date(2026, 9, 23),
    date(2026, 9, 24),
    date(2026, 9, 25),
    date(2026, 9, 28),
    date(2026, 9, 29),
    date(2026, 10, 1),
)

STRATEGY_FILES = (
    "nifty_buy_range_breakout.yaml",
    "nifty_dir_924_itm1_sl21_recost.yaml",
    "nifty_widesl_917_closest_premium.yaml",
    "nifty_widesl_917_otm1.yaml",
)


@dataclass(frozen=True)
class Scenario:
    id: str
    strategy_file: str
    start: date
    end: date


def _scenario_id(strategy_file: str, suffix: str) -> str:
    return f"{Path(strategy_file).stem}__{suffix}"


def _scenarios() -> tuple[Scenario, ...]:
    single_days = tuple(
        Scenario(
            _scenario_id(strategy, day.isoformat().replace("-", "_")),
            strategy,
            day,
            day,
        )
        for strategy in STRATEGY_FILES
        for day in DAYS
    )
    full_windows = tuple(
        Scenario(_scenario_id(strategy, "all_6d"), strategy, DAYS[0], DAYS[-1])
        for strategy in STRATEGY_FILES
    )
    split_windows = (
        Scenario(
            _scenario_id(STRATEGY_FILES[0], "early_3d"),
            STRATEGY_FILES[0],
            DAYS[0],
            DAYS[2],
        ),
        Scenario(
            _scenario_id(STRATEGY_FILES[1], "late_3d"),
            STRATEGY_FILES[1],
            DAYS[3],
            DAYS[-1],
        ),
    )
    scenarios = single_days + full_windows + split_windows
    assert len(scenarios) == 30
    assert len({scenario.id for scenario in scenarios}) == len(scenarios)
    return scenarios


SCENARIOS = _scenarios()


def fixture_relative_paths() -> tuple[Path, ...]:
    paths: list[Path] = []
    for day in DAYS:
        paths.extend(
            (
                Path(f"lake/bars_1m/asset=option/underlying=NIFTY/date={day}/data.parquet"),
                Path(f"lake/bars_1m/asset=index/symbol=NIFTY/date={day}/data.parquet"),
                Path(f"lake/symbol_master/vendor=fyers/date={day}/data.parquet"),
            )
        )
    return tuple(paths)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def input_manifest() -> dict:
    fixture_files = {str(path): _sha256(FIXTURE_ROOT / path) for path in fixture_relative_paths()}
    reference_files = {
        name: _sha256(REFERENCE_ROOT / name) for name in ("lot_sizes.csv", "strike_step.csv")
    }
    return {
        "source": "Frozen Fyers 1-minute NIFTY data collected 2026-09-23 through 2026-10-01",
        "days": [day.isoformat() for day in DAYS],
        "fixture_files_sha256": fixture_files,
        "reference_files_sha256": reference_files,
    }


def _number(value: float | None, places: int = 2) -> float | None:
    return None if value is None else round(value, places)


def _mtm_hash(result: DayResult) -> str:
    canonical = json.dumps(
        [[minute, _number(value)] for minute, value in result.mtm], separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def serialize_day(result: DayResult) -> dict:
    return {
        "day": result.day.isoformat(),
        "gross": _number(result.gross),
        "costs": _number(result.costs),
        "net": _number(result.net),
        "worst_mtm": _number(result.worst_mtm),
        "best_mtm": _number(result.best_mtm),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        "mtm_points": len(result.mtm),
        "mtm_sha256": _mtm_hash(result),
        "trades": [
            {
                "leg": trade.leg_id,
                "position": trade.position,
                "quantity": trade.qty,
                "contract": {
                    "expiry": trade.contract[0].isoformat(),
                    "strike": _number(trade.contract[1]),
                    "option_type": trade.contract[2],
                },
                "entry_time": minute_label(trade.entry_min),
                "entry_price": _number(trade.entry_price, 4),
                "exit_time": minute_label(trade.exit_min) if trade.exit_min is not None else None,
                "exit_price": _number(trade.exit_price, 4),
                "exit_reason": trade.exit_reason,
                "pnl": _number(trade.pnl),
            }
            for trade in result.trades
        ],
    }


def _summary(results: list[DayResult]) -> dict:
    running = peak = max_drawdown = 0.0
    for result in results:
        running += result.net
        peak = max(peak, running)
        max_drawdown = min(max_drawdown, running - peak)
    return {
        "days": len(results),
        "gross": _number(sum(result.gross for result in results)),
        "costs": _number(sum(result.costs for result in results)),
        "net": _number(sum(result.net for result in results)),
        "win_days": sum(result.net > 0 for result in results),
        "max_drawdown": _number(max_drawdown),
        "trades": sum(len(result.trades) for result in results),
    }


def render_scenario(
    scenario: Scenario, strategy: LegwiseStrategy, results: list[DayResult]
) -> dict:
    return {
        "id": scenario.id,
        "strategy_file": scenario.strategy_file,
        "strategy_id": strategy.id,
        "strategy_spec_hash": spec_hash(strategy),
        "window": {"from": scenario.start.isoformat(), "to": scenario.end.isoformat()},
        "summary": _summary(results),
        "days": [serialize_day(result) for result in results],
    }


#: Pinned so `lot_sizing: current` (today's lot) cannot move the snapshot when a new lot row
#: becomes effective: the frozen days are sized as on the day the suite was accepted.
SIZING_DATE = date(2026, 10, 7)


def build_document() -> dict:
    # Windows overlap heavily. Leg-wise sessions are deliberately independent,
    # so load six Parquet days and simulate the 4x6 unique pairs once, then form
    # the 30 single-day/multi-day scenario views from that immutable matrix.
    strategies = {filename: load_legwise(STRATEGIES_ROOT / filename) for filename in STRATEGY_FILES}
    market_days = {day: load_day(FIXTURE_ROOT, "NIFTY", day) for day in DAYS}
    matrix = {
        (filename, day): simulate_day(strategy, market_days[day], sizing_date=SIZING_DATE)
        for filename, strategy in strategies.items()
        for day in DAYS
    }
    rendered = []
    for scenario in SCENARIOS:
        results = [
            matrix[(scenario.strategy_file, day)]
            for day in DAYS
            if scenario.start <= day <= scenario.end
        ]
        rendered.append(render_scenario(scenario, strategies[scenario.strategy_file], results))
    return {
        "schema_version": 1,
        "purpose": (
            "Characterization baseline: review diffs; do not treat current output alone as a "
            "correctness oracle."
        ),
        "inputs": input_manifest(),
        "scenarios": rendered,
    }


def load_expected() -> dict:
    return json.loads(EXPECTED_PATH.read_text())
