"""`Result.weights` is in date order on the frozen fixture's real runs (BL-001).

`pd.DataFrame.from_dict(..., orient="index")` orders rows by when each column first appears,
not by date, and the circuit card (`holding_periods`, `last_day`) and the weekly signal read the
rows in order. The golden responses do not carry the frame, so the harness is asked to record
every `Result.weights` index the engine returns while it runs the scenarios.
"""

from __future__ import annotations

from .harness import load_expected, run_scenarios
from .scenarios import SCENARIOS

#: One scenario of each kind of run: ETF index, stock, and Broad (the circuit card's).
SCENARIO_NAMES = ["etf_default", "stock_default", "broad_default", "broad_monday_open"]


def test_every_weights_frame_on_the_fixture_is_in_date_order():
    results = run_scenarios({name: SCENARIOS[name] for name in SCENARIO_NAMES}, record_weights=True)
    for name in SCENARIO_NAMES:
        assert results[name]["status"] == 200, name
        weeks = len(load_expected(name)["response"]["series"]["dates"])
        frames = results[name]["weights_frames"]
        assert frames, f"{name}: the engine returned no weights frame"
        for found in frames:
            # Fewer than two rows is sorted whatever the order: the check would prove nothing.
            assert 2 <= found["rows"] <= weeks, name
            assert found["sorted"] and found["unique"], f"{name}: weights not in date order"
