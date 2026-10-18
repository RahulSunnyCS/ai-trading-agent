"""BL-111 Amendment 2, H3b: on an expiry day, allow at most ONE non-expiring core pick (EXP1) and
compare with the unrestricted basket (FREE) and the expiring-only basket (EXP0). Exploratory, in-sample,
as registered in backlog/BL-111 (same population, window, days and read-out as H3).

EXP1 is a capped filter of the same ranking: the unrestricted list-C composite over the full universe,
then the top non-Buy variants in composite order, taking an expiring-index variant always and a
non-expiring one only while fewer than `MAX_OFF` are in; the Widesl minimum is applied as
`score.select` does (the lowest scoring Dir is swapped for the next best Widesl that respects the cap).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl111/h3b_max_one_off.py
"""

from __future__ import annotations

import json
from bisect import bisect_left
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np
from h3_expiring_index import BLOCK, LEVEL, RESAMPLES, SEED, WINDOW, read_gross

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, pick
from option_backtesting.rotation.lists import MIN_WIDE_N, N_CORE
from option_backtesting.rotation.readout import block_bootstrap_mean
from option_backtesting.rotation.score import select
from option_backtesting.rotation.variants import (
    is_buy,
    is_dir,
    is_wide,
    track_names,
    underlying_of,
    variant_names,
)

HERE = Path(__file__).parent
MAX_OFF = 1


def select_capped(comp: np.ndarray, names: list[str], index: str, max_off: int) -> list[str]:
    """Top N_CORE non-Buy variants by composite with at most `max_off` outside `index`."""
    wide = np.array([is_wide(n) for n in names])
    dir_ = np.array([is_dir(n) for n in names])
    buy = np.array([is_buy(n) for n in names])
    order = sorted(np.where(~buy)[0], key=lambda v: (-comp[v], names[v]))
    off = lambda v: underlying_of(names[v]) != index  # noqa: E731
    core: list[int] = []
    n_off = 0
    for v in order:
        if len(core) == N_CORE:
            break
        if not off(v):
            core.append(v)
        elif n_off < max_off:
            core.append(v)
            n_off += 1
    n_wide = int(wide[core].sum())
    while n_wide < MIN_WIDE_N:
        drop = min((v for v in core if dir_[v]), key=lambda v: (comp[v], names[v]))
        core.remove(drop)
        n_off -= 1 if off(drop) else 0
        spare = next(
            v for v in order if wide[v] and v not in core and (not off(v) or n_off < max_off)
        )
        core.append(spare)
        n_off += 1 if off(spare) else 0
        n_wide += 1
    return [names[v] for v in core]


def interval(diff: np.ndarray) -> dict:
    out = {"days": int(diff.size), "sum_per_lot": float(diff.sum()) if diff.size else 0.0}
    if diff.size:
        out["median"] = float(np.median(diff))
        out["share_better"] = float((diff > 0).mean())
    if diff.size >= 2 * BLOCK:  # fewer days than two blocks cannot be bootstrapped
        mean, lo, hi = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
        out.update(
            mean=mean,
            ci90=[lo, hi],
            reading="positive" if lo > 0 else "negative" if hi < 0 else "inconclusive",
        )
        # descriptive: drop the three days MOST FAVOURABLE to the observed sign, keeping date order
        order = np.argsort(diff)
        drop = order[-3:] if mean > 0 else order[:3]
        total = float(diff.sum())
        out["top_3_days_share_of_sum"] = float(diff[drop].sum() / total) if total else None
        m3, l3, h3 = block_bootstrap_mean(np.delete(diff, drop), RESAMPLES, BLOCK, SEED, LEVEL)
        out["without_3_most_favourable_days"] = {"mean": m3, "ci90": [l3, h3]}
    elif diff.size:
        out.update(mean=float(diff.mean()), reading="too few days (fewer than 2 blocks)")
    return out


def run(root: Path, names: list[str]) -> dict:
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def value(name: str, d: date):
        if name not in cache:
            cache[name] = read_gross(name, root)
        return cache[name].get(d)

    rows, skipped, both = [], 0, 0
    for d in rec.days_available():
        if not (WINDOW[0] <= d <= WINDOW[1]):
            continue
        a = rec.attrs[d]
        n0, s0 = a["dte_n"] == "0", a["dte_s"] == "0"
        if n0 and s0:
            both += 1
            continue
        if not (n0 or s0):
            continue
        index = "NIFTY" if n0 else "SENSEX"
        i = bisect_left(rec.days, d)
        hist = pick.History(
            rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
            rec.dte_n[:i], rec.dte_s[:i], "",
        )  # fmt: skip
        vix = daylog._number(a.get("vix_open"))
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, vix, dte):
            if key != "C":
                continue
            free = list(picks.core)
            keep = [j for j, n in enumerate(cols) if underlying_of(n) == index]
            baskets = {
                "free": free,
                "exp1": select_capped(comp, cols, index, MAX_OFF),
                "exp0": select(comp[keep], [cols[j] for j in keep]).core,
            }
            got = {k: [value(n, d) for n in b] for k, b in baskets.items()}
            if any(g is None for gs in got.values() for g in gs):
                skipped += 1
                continue
            row = {
                "day": d.isoformat(),
                "index": index,
                "off_in_free": sum(underlying_of(n) != index for n in free),
            }
            for k, b in baskets.items():
                row[k] = b
                row[f"{k}_gross"] = float(np.mean([g[0] for g in got[k]]))
                trades = [g[1] for g in got[k] if g[1] is not None]
                row[f"{k}_trades"] = float(np.mean(trades)) if trades else None
            rows.append(row)

    def diffs(subset, a, b):
        return np.array(
            [r[f"{a}_gross"] - r[f"{b}_gross"] for r in subset if set(r[a]) != set(r[b])]
        )

    def trades(subset, a, b):
        """Mean trades per strategy-day of each arm on the days the two baskets differ."""
        sel = [r for r in subset if set(r[a]) != set(r[b])]

        def mean(k):
            vals = [r[f"{k}_trades"] for r in sel if r[f"{k}_trades"] is not None]
            return float(np.mean(vals)) if vals else None

        return {a: mean(a), b: mean(b)}

    def by_count(subset):
        """EXP1 minus EXP0 on the days they differ, by how many non-expiring picks FREE holds."""
        out = {}
        for n in sorted({r["off_in_free"] for r in subset}):
            d = [
                r["exp1_gross"] - r["exp0_gross"]
                for r in subset
                if r["off_in_free"] == n and set(r["exp1"]) != set(r["exp0"])
            ]
            if d:
                out[str(n)] = {"days": len(d), "mean": float(np.mean(d))}
        return out

    def block(subset):
        return {
            "expiry_days": len(subset),
            "mean_gross_all_expiry_days": {
                k: float(np.mean([r[f"{k}_gross"] for r in subset]))
                for k in ("free", "exp1", "exp0")
            },
            "free_basket_non_expiring_picks": dict(
                sorted(Counter(r["off_in_free"] for r in subset).items())
            ),
            "exp1_minus_free": interval(diffs(subset, "exp1", "free"))
            | {"mean_trades_per_strategy_day": trades(subset, "exp1", "free")},
            "exp1_minus_exp0": interval(diffs(subset, "exp1", "exp0"))
            | {"mean_trades_per_strategy_day": trades(subset, "exp1", "exp0")},
            "exp1_minus_exp0_by_free_non_expiring_picks": by_count(subset),
            "exp0_minus_free": interval(diffs(subset, "exp0", "free"))
            | {"mean_trades_per_strategy_day": trades(subset, "exp0", "free")},
        }

    return {
        "days_with_both_indices_expiring": both,
        "expiry_days_skipped_for_missing_results": skipped,
        "all": block(rows),
        "NIFTY_expiry_days": block([r for r in rows if r["index"] == "NIFTY"]),
        "SENSEX_expiry_days": block([r for r in rows if r["index"] == "SENSEX"]),
        "rows": rows,
    }


def main() -> None:
    root = data_dir()
    report = {
        "window": [d.isoformat() for d in WINDOW],
        "max_non_expiring": MAX_OFF,
        "core_298": run(root, variant_names()),
        "t1": run(root, [*variant_names(), *track_names("t1")]),
        "net_of_charges": "not computed (as in H3)",
    }
    (HERE / "h3b_max_one_off_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for label in ("core_298", "t1"):
        r = report[label]
        print(f"\n=== {label}  skipped {r['expiry_days_skipped_for_missing_results']}")
        for k in ("all", "NIFTY_expiry_days", "SENSEX_expiry_days"):
            b = r[k]
            m = b["mean_gross_all_expiry_days"]
            print(
                f"{k}: {b['expiry_days']} expiry days | mean gross per lot-day FREE {m['free']:+.0f}  EXP1 {m['exp1']:+.0f}  EXP0 {m['exp0']:+.0f} | non-expiring picks in FREE {b['free_basket_non_expiring_picks']}"
            )
            for name in ("exp1_minus_free", "exp1_minus_exp0", "exp0_minus_free"):
                x = b[name]
                ci = f" CI90 [{x['ci90'][0]:+.0f}, {x['ci90'][1]:+.0f}]" if "ci90" in x else ""
                w3 = x.get("without_3_most_favourable_days")
                w3t = (
                    f" | w/o 3 most favourable days {w3['mean']:+.0f} [{w3['ci90'][0]:+.0f}, {w3['ci90'][1]:+.0f}]"
                    if w3
                    else ""
                )
                mean = x.get("mean")
                print(
                    f"   {name:16} differing {x['days']:3}  mean {mean if mean is None else format(mean, '+.0f')}{ci}  -> {x.get('reading')}{w3t}"
                )


if __name__ == "__main__":
    main()
