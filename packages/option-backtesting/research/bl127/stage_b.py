"""BL-127 Stage B (selection year only): for each premium winner of Stage A that is not already a
Core file, replay Adaptive list C over Core-298 + that winner's 25 variants against Core-298 alone,
2025-01-10 -> 2025-10-08, gross per lot-day. Keep the two with the largest difference above zero
(fewer if fewer are above zero; none -> stop, Stage C does not run).

The replays run on a temporary data root that holds only rows on or before 2025-10-08 (filtered
copies of the Core result files, days.csv and the new variants' files), so no test-year day can be
read; `adaptive.replay` asserts it again on the reconstruction.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl127/stage_b.py
"""

from __future__ import annotations

import json

from adaptive import compare, replay
from common import (
    ADAPTIVE_SEL_START,
    RESULTS,
    SELECTION_END,
    TEST_START,
    family,
    names_of,
    truncated_root,
)

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation.variants import variant_names

SEL_ROOT = RESULTS / "tmp_root_selection"


def main() -> None:
    a = json.loads((RESULTS / "stage_a.json").read_text())
    assert a["last_day"] < TEST_START.isoformat()
    cands = {int(p): w["sl"] for p, w in a["winners"].items() if not w["core_file"]}
    core_wins = {int(p): w["sl"] for p, w in a["winners"].items() if w["core_file"]}
    print("candidates", cands, "| winners that are Core files (nothing to add):", core_wins)
    core = variant_names()
    extra_by_premium = {p: names_of(p, sl) for p, sl in cands.items()}
    all_names = core + [n for v in extra_by_premium.values() for n in v]
    truncated_root(data_dir(), SEL_ROOT, all_names, RESULTS / "rotation" / "results", SELECTION_END)
    base = replay(SEL_ROOT, core, ADAPTIVE_SEL_START, SELECTION_END, SELECTION_END)
    out: dict = {
        "window": [ADAPTIVE_SEL_START.isoformat(), SELECTION_END.isoformat()],
        "rule": "list C, registered weights and lookbacks, no expiry rule; core + Buy picks",
        "candidates": {str(p): {"sl": sl, "family": family(p, sl)} for p, sl in cands.items()},
        "core_file_winners_not_tested": {str(p): sl for p, sl in core_wins.items()},
        "results": {},
    }
    for premium, sl in cands.items():
        extra = extra_by_premium[premium]
        new = replay(SEL_ROOT, core + extra, ADAPTIVE_SEL_START, SELECTION_END, SELECTION_END)
        res = compare(base, new, extra)
        res["premium"], res["sl"] = premium, sl
        out["results"][str(premium)] = res
        print(
            f"₹{premium} SL {sl}: core {res['core_per_lot_day']:+.1f} with "
            f"{res['with_additions_per_lot_day']:+.1f} diff {res['diff_mean']:+.1f} "
            f"CI90 [{res['ci90'][0]:+.1f}, {res['ci90'][1]:+.1f}] DD core "
            f"{res['core_max_drawdown']:,.0f} with {res['with_additions_max_drawdown']:,.0f}; "
            f"picked on {res['days_with_a_new_variant_picked']}/{res['days']} days"
        )
    ranked = sorted(out["results"].values(), key=lambda r: r["diff_mean"], reverse=True)
    kept = [r for r in ranked if r["diff_mean"] > 0][:2]
    out["ranking"] = [
        {"premium": r["premium"], "sl": r["sl"], "diff_mean": r["diff_mean"]} for r in ranked
    ]
    out["kept"] = [{"premium": r["premium"], "sl": r["sl"]} for r in kept]
    out["stage_c_runs"] = bool(kept)
    (RESULTS / "stage_b.json").write_text(json.dumps(out, indent=1))
    print("ranking", out["ranking"])
    print("kept", out["kept"], "-> Stage C runs" if kept else "-> STOP, Stage C does not run")


if __name__ == "__main__":
    main()
