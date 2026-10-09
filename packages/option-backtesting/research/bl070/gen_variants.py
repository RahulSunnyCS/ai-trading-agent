"""BL-070: the 248 whole-day variants with the overall MTM stop removed.

Reads each source variant (research/bl054, bl056, bl059, bl060, bl061, bl062 via varlib.variant_file),
drops `strategy.overall` (the per-strategy stop_loss_inr; legs' own SL / trail untouched) and writes
research/bl070/variants/<name>.yaml with id bl070_<name>. Checks that nothing else changed.

    uv run python research/bl070/gen_variants.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

OUT = HERE / "variants"


def names() -> list[str]:
    out = []
    for pfx, premiums in (("N_", (80, 100)), ("S_", (250, 320))):
        for slot in varlib.SLOTS_MORNING + varlib.SLOTS_LATE + [varlib.SLOT_LAST]:
            tag = slot.replace(":", "")
            for fam in ("wide", "dir", "buy"):
                if fam == "buy" and slot == varlib.SLOT_LAST:
                    continue
                out.append(f"{pfx}{fam}_{tag}")
            out.extend(f"{pfx}p{p}_{tag}" for p in premiums)
    assert len(out) == 248, len(out)
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name in names():
        src = varlib.variant_file(name, "variants")
        doc = yaml.safe_load(src.read_text())
        strat = doc["strategy"]
        overall = strat.pop("overall")
        assert set(overall) == {"stop_loss_inr"}, (name, overall)  # no target / other overall rules
        strat["id"] = f"bl070_{name}"
        text = f"# BL-070: {src.relative_to(HERE.parent)} with the overall MTM stop removed\n"
        text += yaml.safe_dump(doc, sort_keys=False)
        (OUT / f"{name}.yaml").write_text(text)
        # verification: the only differences are the dropped overall block and the id
        back = yaml.safe_load((OUT / f"{name}.yaml").read_text())["strategy"]
        orig = yaml.safe_load(src.read_text())["strategy"]
        orig.pop("overall")
        orig["id"] = back["id"]
        assert back == orig, name
    print(f"{len(list(OUT.glob('*.yaml')))} no-stop variants in {OUT}")


if __name__ == "__main__":
    main()
