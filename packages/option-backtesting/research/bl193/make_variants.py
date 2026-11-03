"""BL-193: every Core Widesl at a ₹3,000 overall stop, plus unchanged copies for engine parity.

    uv run python research/bl193/make_variants.py

For each of the 150 Core Widesl files (`strategies/rotation/<I>_<family>_<HHMM>.yaml`), into
`variants/` (git-ignored): `<I>_<family>-m3k_<HHMM>` with `stop_loss_inr: 2500` -> `3000` and nothing
else changed, and `<I>_<family>-m25_<HHMM>` unchanged.
"""

from __future__ import annotations

import re
from pathlib import Path

from option_backtesting.rotation.variants import is_wide, strategy_path, variant_names

HERE = Path(__file__).parent
OUT = HERE / "variants"


def write(name: str, text: str) -> None:
    (OUT / f"{name}.yaml").write_text(re.sub(r"id: \S+", f"id: bl193_{name}", text, count=1))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.yaml"):
        old.unlink()
    names = [n for n in variant_names() if is_wide(n)]
    assert len(names) == 150, len(names)
    for name in names:
        index, family, slot = name.split("_")
        text = strategy_path(name).read_text()
        assert text.count("stop_loss_inr: 2500") == 1, name
        write(f"{index}_{family}-m25_{slot}", text)
        write(
            f"{index}_{family}-m3k_{slot}",
            text.replace("stop_loss_inr: 2500", "stop_loss_inr: 3000"),
        )
    print(f"{2 * len(names)} variants in {OUT}")


if __name__ == "__main__":
    main()
