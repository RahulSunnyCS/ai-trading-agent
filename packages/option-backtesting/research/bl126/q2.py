"""BL-126 Q2 (Adaptive, list C): replay the registered list-C rule day by day over Core-298 plus the
new variants, against Core-298 alone on the same days (2025-01-10 -> latest). Gross per lot-day as
the read-out defines it (mean one-lot gross of the day's picks, core + Buy); paired difference with
the Q1 bootstrap; max drawdown; where a new variant was picked. No expiry rule (BL-122 not
applied), reconstructed history exactly as `daylog.reconstruction` / `pick.score_history`.

The replay reads results through a temporary data root under results/: symlinks to the live Core
result files and days.csv (read-only use) plus this folder's new result files. Nothing is written
under the real TRADING_DATA_ROOT.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl126/q2.py
"""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import date

import numpy as np
from common import ARMS, RESULTS, arm_names

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import variant_names

BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261018, 0.90
WINDOW_START = date(2025, 1, 10)
TMP = RESULTS / "tmp_root"


def build_tmp_root(real: os.PathLike) -> None:
    rot, real_rot = TMP / "rotation", store.rotation_dir(real)
    res = rot / "results"
    res.mkdir(parents=True, exist_ok=True)
    for p in (rot / "days.csv", *res.glob("*.csv")):
        if p.is_symlink() or p.exists():
            p.unlink()
    (rot / "days.csv").symlink_to(real_rot / "days.csv")
    for n in variant_names():
        (res / f"{n}.csv").symlink_to(real_rot / "results" / f"{n}.csv")
    for p in (RESULTS / "rotation" / "results").glob("*.csv"):
        (res / p.name).symlink_to(p)


def replay(names: list[str]) -> dict[date, dict]:
    daylog._recon_cache.clear()  # its key does not include the universe
    rec = daylog.reconstruction(TMP, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}
    out = {}
    for d in rec.days_available():
        if d < WINDOW_START:
            continue
        picks = rec.picks(d)["C"]
        chosen = [*picks["core"], *picks["buy"]]
        gross = []
        for n in chosen:
            if n not in cache:
                cache[n] = daylog.read_rows(n, TMP)
            row = cache[n].get(d)
            if row is None:
                raise RuntimeError(f"{d}: no result for {n}")
            gross.append(row["gross"])
        out[d] = {"picks": chosen, "gross": float(np.mean(gross))}
    return out


def main() -> None:
    real = data_dir()
    build_tmp_root(real)
    core_names = variant_names()
    base = replay(core_names)
    out: dict = {
        "window_start": WINDOW_START.isoformat(),
        "core_days": len(base),
        "universe_core": len(core_names),
        "rule": "list C, registered weights and lookbacks, no expiry rule; core + Buy picks",
    }
    sets = {"both": ["X1", "X2"], "X1": ["X1"], "X2": ["X2"]}
    rows_dump = {}
    for label, arms in sets.items():
        extra = [n for a in arms for n in arm_names(a)]
        new = replay(core_names + extra)
        assert set(new) == set(base), (label, len(new), len(base))
        days = sorted(base)
        b = np.array([base[d]["gross"] for d in days])
        a = np.array([new[d]["gross"] for d in days])
        diff = a - b
        mean, lo, hi = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
        dd_a, dd_b = max_drawdown(a), max_drawdown(b)
        newset = set(extra)
        picked_days = [d for d in days if newset & set(new[d]["picks"])]
        changed_days = [d for d in days if set(new[d]["picks"]) != set(base[d]["picks"])]
        picks_new = [n for d in days for n in new[d]["picks"] if n in newset]
        by_slot = Counter(n.rsplit("_", 1)[1] for n in picks_new)
        by_arm = Counter(
            next(x for x in arms if n.startswith(f"N_{ARMS[x]['family']}_")) for n in picks_new
        )
        # on the days a new variant was picked: the day's gross under each rule
        pa = np.array([new[d]["gross"] for d in picked_days]) if picked_days else np.array([])
        pb = np.array([base[d]["gross"] for d in picked_days]) if picked_days else np.array([])
        out[label] = {
            "arms_added": arms,
            "universe": len(core_names) + len(extra),
            "days": len(days),
            "first_day": days[0].isoformat(),
            "last_day": days[-1].isoformat(),
            "core_per_lot_day": float(b.mean()),
            "arm_per_lot_day": float(a.mean()),
            "diff_mean": mean,
            "ci90": [lo, hi],
            "core_max_drawdown": dd_b,
            "arm_max_drawdown": dd_a,
            "drawdown_no_deeper": bool(dd_a >= dd_b),
            "reading": "positive" if (lo > 0 and dd_a >= dd_b) else "not positive",
            "interval_above_zero": bool(lo > 0),
            "days_with_a_new_variant_picked": len(picked_days),
            "days_with_changed_picks": len(changed_days),
            "new_variant_picks": len(picks_new),
            "new_picks_by_arm": dict(by_arm),
            "new_picks_by_slot": dict(sorted(by_slot.items())),
            "on_days_new_picked": {
                "n": len(picked_days),
                "arm_mean": float(pa.mean()) if pa.size else None,
                "core_mean": float(pb.mean()) if pb.size else None,
            },
        }
        rows_dump[label] = {d.isoformat(): {"core": base[d], "arm": new[d]} for d in days}
        print(
            f"{label}: core {b.mean():+.1f} arm {a.mean():+.1f} diff {mean:+.1f} "
            f"CI90 [{lo:+.1f}, {hi:+.1f}] DD arm {dd_a:,.0f} core {dd_b:,.0f}; "
            f"picked on {len(picked_days)}/{len(days)} days, {len(picks_new)} picks "
            f"{dict(by_arm)} -> {out[label]['reading']}"
        )
    (RESULTS / "q2.json").write_text(json.dumps(out, indent=1))
    (RESULTS / "q2_daily.json").write_text(json.dumps(rows_dump))


if __name__ == "__main__":
    main()
