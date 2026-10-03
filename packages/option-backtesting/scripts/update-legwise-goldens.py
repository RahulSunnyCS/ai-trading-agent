#!/usr/bin/env python3
"""Check or explicitly refresh the committed leg-wise characterization suite.

Checking writes nothing:
    uv run python scripts/update-legwise-goldens.py

After reviewing a legitimate calculation correction, accept result changes:
    uv run python scripts/update-legwise-goldens.py --accept-results

Refreshing the frozen market inputs is intentionally more explicit and also
requires accepting their newly calculated results:
    uv run python scripts/update-legwise-goldens.py \
      --source-root ~/TradingData --accept-inputs --accept-results
"""

from __future__ import annotations

import argparse
import difflib
import json
import shutil
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

from tests.golden.legwise_scenarios import (  # noqa: E402
    EXPECTED_PATH,
    FIXTURE_ROOT,
    build_document,
    fixture_relative_paths,
)


def _render(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=False) + "\n"


def _import_inputs(source_root: Path) -> None:
    missing = [path for path in fixture_relative_paths() if not (source_root / path).is_file()]
    if missing:
        joined = "\n".join(f"  - {path}" for path in missing)
        raise SystemExit(f"source root is missing required fixture files:\n{joined}")
    for relative in fixture_relative_paths():
        source = source_root / relative
        destination = FIXTURE_ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    print(f"imported {len(fixture_relative_paths())} frozen input files from {source_root}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-results", action="store_true")
    parser.add_argument("--accept-inputs", action="store_true")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--diff-lines", type=int, default=400)
    args = parser.parse_args()

    if args.accept_inputs and (args.source_root is None or not args.accept_results):
        parser.error("--accept-inputs requires --source-root and --accept-results")
    if args.source_root is not None and not args.accept_inputs:
        parser.error("--source-root is only used with --accept-inputs")
    if args.accept_inputs:
        _import_inputs(args.source_root.expanduser().resolve())

    actual = _render(build_document())
    expected = EXPECTED_PATH.read_text() if EXPECTED_PATH.exists() else ""
    if actual == expected:
        print("leg-wise golden scenarios are up to date")
        return

    diff = list(
        difflib.unified_diff(
            expected.splitlines(),
            actual.splitlines(),
            fromfile=str(EXPECTED_PATH),
            tofile="recalculated",
            lineterm="",
        )
    )
    for line in diff[: args.diff_lines]:
        print(line)
    if len(diff) > args.diff_lines:
        print(f"... diff truncated: {len(diff) - args.diff_lines} more line(s)")

    if not args.accept_results:
        raise SystemExit(
            "golden output changed; review the diff, fix an accidental regression, or rerun "
            "with --accept-results for an intentional correction"
        )
    EXPECTED_PATH.write_text(actual)
    print(f"accepted {len(actual.splitlines())} lines in {EXPECTED_PATH}")


if __name__ == "__main__":
    main()
