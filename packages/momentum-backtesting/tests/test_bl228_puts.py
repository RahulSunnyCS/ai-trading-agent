"""BL-228: the learning run must not read, tally or load the confirmation weeks."""

import importlib.util
import sys
from pathlib import Path

import pandas as pd


def _script():
    scripts = Path(__file__).resolve().parents[1] / "scripts"
    sys.path.insert(0, str(scripts))
    try:
        spec = importlib.util.spec_from_file_location(
            "bl228_fno_puts", scripts / "bl228_fno_puts.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(scripts))
    return module


def test_entry_lists_stop_at_the_learning_end_and_count_only_learning_bans():
    puts = _script()
    sessions = list(pd.bdate_range("2024-05-01", "2024-08-30"))
    fridays = pd.date_range("2024-05-31", "2024-07-26", freq="W-FRI")
    weak = {w: ["AAA|PE", "BBB|PE"] for w in fridays}
    learn_day = puts.ob.rebalance_day(pd.Timestamp("2024-06-07"), sessions)
    after_day = puts.ob.rebalance_day(pd.Timestamp("2024-07-12"), sessions)
    assert learn_day <= puts.ob.LEARN_END < after_day
    banned = {(learn_day, "AAA"), (after_day, "AAA"), (after_day, "BBB")}

    whole, whole_skipped = puts.entry_lists(weak, sessions, banned, None)
    learn, learn_skipped = puts.entry_lists(weak, sessions, banned, None, until=puts.ob.LEARN_END)

    assert max(learn) <= puts.ob.LEARN_END < max(whole)
    assert learn_skipped == 1 and whole_skipped == 3  # the two bans after the cut are not counted
    assert {d: v for d, v in whole.items() if d <= puts.ob.LEARN_END} == learn
