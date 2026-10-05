#!/usr/bin/env python3
"""Check the frozen backtest results, or accept new ones on purpose (BL-001).

Check only; writes nothing and exits 1 if any result moved:
    uv run python scripts/update-goldens.py

After reviewing a change that was meant to move results:
    uv run python scripts/update-goldens.py --accept-results --reason "E10: no sale while halted"

Every accept appends to tests/golden/CHANGELOG.md: the date, the commit, the reason and each
scenario's CAGR and max drawdown before and after. That file is the record of why any frozen
number is what it is.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from datetime import date
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from tests.golden.harness import (  # noqa: E402
    GOLDEN,
    differences,
    load_expected,
    run_scenarios,
    write_expected,
)
from tests.golden.scenarios import SCENARIOS  # noqa: E402

CHANGELOG = GOLDEN / "CHANGELOG.md"


def _kpi(result: dict | None, key: str) -> str:
    value = ((result or {}).get("response") or {}).get("kpis", {}).get(key)
    return "n/a" if value is None else f"{value:.2%}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-results", action="store_true")
    parser.add_argument("--reason", help="Why the results moved (required to accept).")
    args = parser.parse_args()
    if args.accept_results and not (args.reason or "").strip():
        raise SystemExit("--accept-results needs --reason: say why the numbers moved")

    results = run_scenarios(SCENARIOS)
    failed = [name for name, result in results.items() if result["status"] != 200]
    if failed:
        raise SystemExit(f"scenarios did not run: {failed}")
    moved = {}
    for name, result in results.items():
        expected = load_expected(name)
        found = ["no frozen result yet"] if expected is None else differences(expected, result)
        if found:
            moved[name] = (expected, found)
    if not moved:
        print(f"clean: {len(results)} scenarios match their frozen results")
        return

    lines = []
    for name, (expected, found) in moved.items():
        lines.append(
            f"| {name} | {_kpi(expected, 'cagr')} -> {_kpi(results[name], 'cagr')} | "
            f"{_kpi(expected, 'max_drawdown')} -> {_kpi(results[name], 'max_drawdown')} |"
        )
        print(f"\n{name}: {len(found)}{'+' if len(found) >= 40 else ''} differences")
        print("  " + "\n  ".join(found[:12]))
    if not args.accept_results:
        raise SystemExit(f"\n{len(moved)} of {len(results)} scenarios moved; nothing written")

    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=PACKAGE_ROOT, capture_output=True, text=True
    ).stdout.strip()
    write_expected(results)
    header = "" if CHANGELOG.exists() else "# Accepted changes to the frozen results\n"
    entry = (
        f"\n## {date.today()} (on top of `{commit}`)\n\n{args.reason.strip()}\n\n"
        "| Scenario | CAGR | Max drawdown |\n|---|---|---|\n" + "\n".join(lines) + "\n"
    )
    with CHANGELOG.open("a") as handle:
        handle.write(header + entry)
    print(f"\naccepted {len(moved)} scenarios; logged in {CHANGELOG.relative_to(PACKAGE_ROOT)}")


if __name__ == "__main__":
    main()
