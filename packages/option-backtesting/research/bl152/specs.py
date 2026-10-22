"""BL-152: writes and checks the 192 rule specs of the registered grid (backlog/BL-152, Phase 0).

The rules themselves are built in `common/breakout_specs.py` (BL-153 shares them):

    uv run python research/bl152/specs.py            # write out/specs/<id>.yaml and check all 192
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "common"))
from breakout_specs import AXES, CRITERIA, grid, levels, spec  # noqa: E402, F401


def main() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from option_backtesting.ruletest.spec import from_dict, read_back

    folder = HERE / "out" / "specs"
    folder.mkdir(parents=True, exist_ok=True)
    hashes = set()
    for vid, rule in grid():
        compiled = from_dict(rule)
        hashes.add(compiled.spec_hash)
        (folder / f"{vid}.yaml").write_text(yaml.safe_dump({"rule": rule}, sort_keys=False))
    assert len(hashes) == len(grid()), "two variants compiled to the same rule"
    print(f"{len(hashes)} specs written to {folder}")
    print("\n".join(read_back(from_dict(grid()[0][1]))["sentences"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
