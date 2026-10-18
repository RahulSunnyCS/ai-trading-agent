"""BL-127 Stage C (test year, read ONCE): Adaptive list C over Core-298 + the kept winners (all
together) against Core-298, 2025-10-09 -> the latest scored day; paired difference with the
registered 90 % circular block bootstrap (5-day blocks, 2,000 resamples, seed 20261019), max
drawdown, how often a new variant is picked. Also each kept winner alone (descriptive).

Reads the kept winners from stage_b.json; refuses to run again once stage_c.json exists (the test
year is read once, with the choice made in Stages A and B). The replays use a temporary data root
of symlinks to the live Core result files and days.csv (read-only use) plus this folder's result
files for the kept winners; nothing is written under the real TRADING_DATA_ROOT.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl127/stage_c.py
"""

from __future__ import annotations

import json
import shutil

from adaptive import compare, replay
from common import (
    ADAPTIVE_SEL_START,
    RESULTS,
    SELECTION_END,
    TEST_START,
    family,
    names_of,
)

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store
from option_backtesting.rotation.variants import variant_names

TMP = RESULTS / "tmp_root_test"


def build_root(real, extra: list[str]) -> None:
    rot, real_rot = TMP / "rotation", store.rotation_dir(real)
    if rot.exists():
        shutil.rmtree(rot)
    res = rot / "results"
    res.mkdir(parents=True)
    (rot / "days.csv").symlink_to(real_rot / "days.csv")
    for n in variant_names():
        (res / f"{n}.csv").symlink_to(real_rot / "results" / f"{n}.csv")
    for n in extra:
        (res / f"{n}.csv").symlink_to(RESULTS / "rotation" / "results" / f"{n}.csv")


def main() -> None:
    out_path = RESULTS / "stage_c.json"
    assert not out_path.exists(), "Stage C was already read once; it is not rerun"
    b = json.loads((RESULTS / "stage_b.json").read_text())
    assert b["stage_c_runs"], "Stage B kept nothing: Stage C does not run"
    kept = [(k["premium"], k["sl"]) for k in b["kept"]]
    core = variant_names()
    names = {f"{p}@{sl}": names_of(p, sl) for p, sl in kept}
    all_extra = [n for v in names.values() for n in v]
    build_root(data_dir(), all_extra)
    # one read of the test year: the full-history replay of Core, then each addition
    base_all = replay(TMP, core, ADAPTIVE_SEL_START, None, None)
    base = {d: v for d, v in base_all.items() if d >= TEST_START}
    out: dict = {
        "window_start": TEST_START.isoformat(),
        "rule": "list C, registered weights and lookbacks, no expiry rule; core + Buy picks",
        "kept": [{"premium": p, "sl": sl, "family": family(p, sl)} for p, sl in kept],
        "universe_core": len(core),
    }

    def run(label: str, extra: list[str]) -> None:
        new_all = replay(TMP, core + extra, ADAPTIVE_SEL_START, None, None)
        new = {d: v for d, v in new_all.items() if d >= TEST_START}
        res = compare(base, new, extra)
        res["universe"] = len(core) + len(extra)
        out[label] = res
        # consistency: the additions must not change what Adaptive picked in the selection year
        # except through the new variants themselves (informational, after the choice was made)
        print(
            f"{label}: core {res['core_per_lot_day']:+.1f} with {res['with_additions_per_lot_day']:+.1f}"
            f" diff {res['diff_mean']:+.1f} CI90 [{res['ci90'][0]:+.1f}, {res['ci90'][1]:+.1f}] "
            f"DD core {res['core_max_drawdown']:,.0f} with {res['with_additions_max_drawdown']:,.0f}; "
            f"picked on {res['days_with_a_new_variant_picked']}/{res['days']} days, "
            f"{res['new_variant_picks']} picks {res['new_picks_by_family']} -> {res['reading']}",
            flush=True,
        )

    run("together", all_extra)
    if len(kept) > 1:
        for label, extra in names.items():
            run(f"alone_{label}", extra)
    out["selection_year_base_check"] = {
        "days": sum(d <= SELECTION_END for d in base_all),
        "note": "Core replay days in 2025-01-10..2025-10-08 under the full-history root",
    }
    out_path.write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
