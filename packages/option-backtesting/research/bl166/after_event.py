"""BL-166 review check (descriptive, not a ledger test): the random-time control again, with its
minutes restricted to those AFTER each event's entry. The tester's control draws from the whole
09:41-14:01 grid, and before a swing low exists the exit condition is NaN, so minutes with no
structure at all were eligible. Uses the simulations the registered run already cached.

    uv run python research/bl166/after_event.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from specs import RULE  # noqa: E402

DRAWS = 200


def main() -> int:
    sys.path.insert(0, str(HERE.parents[1] / "src"))
    from trading_data.db import data_root

    from option_backtesting.ruletest import expr as E
    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import sim, study
    from option_backtesting.ruletest.spec import from_dict

    root = data_root()
    rule = from_dict(RULE)
    lo, hi = study.PERIODS["learning"]
    frame = F.load_frame(root, "NIFTY", hi)
    events, _ = study.find_events(rule, frame, lo, hi)
    eligible = study.control_filter(rule, frame)
    grid = study.entry_grid(rule.start, rule.stop)
    wanted = set()
    for ev in events:
        wanted.add((ev["day"], ev["entry"], ev["side"], 0.0))
        for e in grid:
            if eligible(ev["day"], e, ev["side"]):
                wanted.add((ev["day"], e, ev["side"], 0.0))
    exits = study.exit_minutes(rule, frame, {(d, e, s) for d, e, s, _ in wanted})
    got = sim.ensure(root, rule, wanted, 4, lambda m: None, exits)
    rows, before, after = [], [], []
    for ev in events:
        own = got.get((ev["day"], ev["entry"], ev["side"], 0.0))
        if own is None:
            continue
        rows.append(sim.net("NIFTY", own))
        at = E.clock_to_stamp(ev["entry"], "entry")
        pool_b, pool_a = [], []
        for e in grid:
            row = got.get((ev["day"], e, ev["side"], 0.0))
            if row is None or not eligible(ev["day"], e, ev["side"]):
                continue
            (pool_a if E.clock_to_stamp(e, "entry") > at else pool_b).append(sim.net("NIFTY", row))
        before.append(pool_b)
        after.append(pool_a)
    rng = np.random.default_rng(int(rule.spec_hash[:8], 16))
    event_mean = float(np.mean(rows))
    for name, pools in (("before the event", before), ("after the event", after)):
        usable = [p for p in pools if p]
        means = np.array([np.mean([p[rng.integers(len(p))] for p in usable]) for _ in range(DRAWS)])
        pct = float((means < event_mean).mean())
        print(f"{name}: {len(usable)} event days with eligible minutes, "
              f"{sum(len(p) for p in usable)} minutes; draws' mean ₹{means.mean():.0f}, "
              f"p05 ₹{np.percentile(means, 5):.0f} p95 ₹{np.percentile(means, 95):.0f}; "
              f"event mean ₹{event_mean:.0f} at percentile {pct:.2f}")  # fmt: skip
    return 0


if __name__ == "__main__":
    sys.exit(main())
