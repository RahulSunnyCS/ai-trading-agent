"""BL-164: writes and checks the three registered rule specs (backlog/BL-164, Phase 0).

H1 the gap-and-go band, H2 the Williams back-up, H3 the chain (H1, else H2), from one set of
definitions, NIFTY, the 150-point in-the-money weekly bought, -30% stop, 105% / 80% peak trail,
stops on the 1-minute close, out at 15:15. Nothing here runs a test:

    uv run python research/bl164/specs.py            # write out/specs/<id>.yaml, check, read back
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent

sys.path.insert(0, str(HERE.parent / "common"))
from gap_and_go_specs import specs  # noqa: E402


def main() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from option_backtesting.ruletest.spec import from_dict, read_back

    folder = HERE / "out" / "specs"
    folder.mkdir(parents=True, exist_ok=True)
    hashes = set()
    for body in specs():
        compiled = from_dict(body)
        hashes.add(compiled.spec_hash)
        (folder / f"{body['id']}.yaml").write_text(yaml.safe_dump({"rule": body}, sort_keys=False))
        print(f"\n== {body['id']}  {compiled.spec_hash[:12]}")
        print("\n".join(read_back(compiled)["sentences"]))
    assert len(hashes) == 3, "two specs compiled to the same rule"
    print(f"\n3 specs written to {folder}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
