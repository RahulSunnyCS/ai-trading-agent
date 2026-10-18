"""The Adaptive replay used by Stages B and C: list C (registered weights and lookbacks, no expiry
rule), day by day on the reconstruction `daylog` / `pick.score_history` give, over a data root.

Gross per lot-day as the read-out defines it: the mean one-lot gross of the day's picks (core +
Buy), read from the root's result files. The reconstruction cache key does not include the
universe, so it is cleared before every replay.
"""

from __future__ import annotations

from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np
from common import BLOCK, LEVEL, RESAMPLES, SEED

from option_backtesting.rotation import daylog
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown


def replay(
    root: Path, names: list[str], start: date, end: date | None, last_allowed: date | None
) -> dict[date, dict]:
    """{day: {"picks": [...], "gross": float}} for the reconstructable days in [start, end].
    `last_allowed` (Stages A and B: the end of the selection year) is asserted against everything
    the reconstruction holds, not only the days returned."""
    daylog._recon_cache.clear()  # its key does not include the universe
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    if last_allowed is not None:
        assert max(rec.days) <= last_allowed, (max(rec.days), last_allowed)
        assert max(rec.attrs) <= last_allowed, (max(rec.attrs), last_allowed)
    cache: dict[str, dict] = {}
    out = {}
    for d in rec.days_available():
        if d < start or (end is not None and d > end):
            continue
        picks = rec.picks(d)["C"]
        chosen = [*picks["core"], *picks["buy"]]
        gross = []
        for n in chosen:
            if n not in cache:
                cache[n] = daylog.read_rows(n, root)
            row = cache[n].get(d)
            if row is None:
                raise RuntimeError(f"{d}: no result for {n}")
            gross.append(row["gross"])
        out[d] = {"picks": chosen, "gross": float(np.mean(gross))}
    if last_allowed is not None:
        assert max(out) <= last_allowed
    return out


def compare(base: dict[date, dict], new: dict[date, dict], extra: list[str]) -> dict:
    """Paired difference (new minus base) with the registered bootstrap, drawdowns, pick counts."""
    assert set(new) == set(base), (len(new), len(base))
    days = sorted(base)
    b = np.array([base[d]["gross"] for d in days])
    a = np.array([new[d]["gross"] for d in days])
    mean, lo, hi = block_bootstrap_mean(a - b, RESAMPLES, BLOCK, SEED, LEVEL)
    dd_a, dd_b = max_drawdown(a), max_drawdown(b)
    newset = set(extra)
    picked_days = [d for d in days if newset & set(new[d]["picks"])]
    changed_days = [d for d in days if set(new[d]["picks"]) != set(base[d]["picks"])]
    picks_new = [n for d in days for n in new[d]["picks"] if n in newset]
    by_family = Counter(n.split("_")[1] for n in picks_new)
    by_slot = Counter(n.rsplit("_", 1)[1] for n in picks_new)
    pa = np.array([new[d]["gross"] for d in picked_days])
    pb = np.array([base[d]["gross"] for d in picked_days])
    return {
        "universe_added": len(extra),
        "days": len(days),
        "first_day": days[0].isoformat(),
        "last_day": days[-1].isoformat(),
        "core_per_lot_day": float(b.mean()),
        "with_additions_per_lot_day": float(a.mean()),
        "diff_mean": mean,
        "ci90": [lo, hi],
        "core_max_drawdown": dd_b,
        "with_additions_max_drawdown": dd_a,
        "drawdown_no_deeper": bool(dd_a >= dd_b),
        "interval_above_zero": bool(lo > 0),
        "reading": "positive" if (lo > 0 and dd_a >= dd_b) else "not positive",
        "days_with_a_new_variant_picked": len(picked_days),
        "days_with_changed_picks": len(changed_days),
        "new_variant_picks": len(picks_new),
        "new_picks_by_family": dict(by_family),
        "new_picks_by_slot": dict(sorted(by_slot.items())),
        "on_days_new_picked": {
            "n": len(picked_days),
            "with_additions_mean": float(pa.mean()) if pa.size else None,
            "core_mean": float(pb.mean()) if pb.size else None,
        },
    }
