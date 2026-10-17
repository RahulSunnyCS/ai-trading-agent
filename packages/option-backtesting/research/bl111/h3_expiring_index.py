"""BL-111 Amendment 1, H3: on an expiry day, does keeping only the expiring index's picks change the
result? Exploratory, in-sample (2025-01-10 to 2026-10-08), as registered in backlog/BL-111.

The arm is a FILTER of the comparator's ranking, not a re-ranking: the unrestricted list-C composite is
computed over the full universe, then `select` runs over the expiring index's variants only. Both arms
use core picks only (no Buy add-on) and one lot per strategy.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl111/h3_expiring_index.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, pick, store
from option_backtesting.rotation.readout import block_bootstrap_mean
from option_backtesting.rotation.score import select
from option_backtesting.rotation.variants import track_names, underlying_of, variant_names

HERE = Path(__file__).parent
WINDOW = (date(2025, 1, 10), date(2026, 10, 8))
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261015, 0.90


def read_gross(name: str, root: Path) -> dict[date, tuple[float, int | None]]:
    path = store.result_path(name, root)
    out: dict[date, tuple[float, int | None]] = {}
    if not path.exists():
        return out
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                n = int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else None
                out[date.fromisoformat(r["day"])] = (float(r["gross"]), n)
            except (KeyError, ValueError):
                continue
    return out


def run(root: Path, names: list[str]) -> dict:
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def value(name: str, d: date):
        if name not in cache:
            cache[name] = read_gross(name, root)
        return cache[name].get(d)

    rows = []
    both_expire = 0
    for d in rec.days_available():
        if not (WINDOW[0] <= d <= WINDOW[1]):
            continue
        a = rec.attrs[d]
        n0, s0 = a["dte_n"] == "0", a["dte_s"] == "0"
        if n0 and s0:
            both_expire += 1  # left unrestricted: identical arms, no difference
            continue
        if not (n0 or s0):
            continue
        index = "NIFTY" if n0 else "SENSEX"
        i = bisect_left(rec.days, d)
        hist = pick.History(
            rec.days[:i],
            rec.cols,
            rec.values[:i],
            rec.weekday[:i],
            rec.band[:i],
            rec.dte_n[:i],
            rec.dte_s[:i],
            "",
        )
        vix = daylog._number(a.get("vix_open"))
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for key, cols, comp, picks in pick._rank(hist, d, vix, dte):
            if key != "C":
                continue
            free = list(picks.core)
            keep = [j for j, n in enumerate(cols) if underlying_of(n) == index]
            exp = select(comp[keep], [cols[j] for j in keep]).core
            vals = {}
            for label, basket in (("free", free), ("exp", exp)):
                got = [value(n, d) for n in basket]
                if any(g is None for g in got):
                    vals = {}
                    break
                vals[label] = (
                    float(np.mean([g[0] for g in got])),
                    float(np.mean([g[1] for g in got if g[1] is not None])),
                )
            if not vals:
                continue
            rows.append(
                {
                    "day": d.isoformat(),
                    "index": index,
                    "free": free,
                    "exp": exp,
                    "differs": set(free) != set(exp),
                    "free_gross": vals["free"][0],
                    "exp_gross": vals["exp"][0],
                    "free_trades": vals["free"][1],
                    "exp_trades": vals["exp"][1],
                }
            )

    def summary(subset: list[dict]) -> dict:
        diff = np.array([r["exp_gross"] - r["free_gross"] for r in subset if r["differs"]])
        out = {
            "expiry_days": len(subset),
            "differing_days": int(diff.size),
            "sum_difference_per_lot": float(diff.sum()) if diff.size else 0.0,
            "share_of_differing_days_exp_better": float((diff > 0).mean()) if diff.size else None,
        }
        if diff.size >= 5:
            mean, lo, hi = block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
            out.update(
                mean_difference_per_lot=mean,
                ci90=[lo, hi],
                reading="positive" if lo > 0 else "negative" if hi < 0 else "inconclusive",
            )
        elif diff.size:
            out.update(mean_difference_per_lot=float(diff.mean()), reading="too few days")
        out["mean_trades_on_differing_days"] = {
            "free": float(np.mean([r["free_trades"] for r in subset if r["differs"]]))
            if diff.size
            else None,
            "exp": float(np.mean([r["exp_trades"] for r in subset if r["differs"]]))
            if diff.size
            else None,
        }
        return out

    return {
        "days_with_both_indices_expiring": both_expire,
        "all": summary(rows),
        "NIFTY_expiry_days": summary([r for r in rows if r["index"] == "NIFTY"]),
        "SENSEX_expiry_days": summary([r for r in rows if r["index"] == "SENSEX"]),
        "rows": rows,
    }


def main() -> None:
    root = data_dir()
    report = {
        "window": [d.isoformat() for d in WINDOW],
        "arms": "EXP = filter of the unrestricted list-C ranking to the expiring index (core picks, one lot each)",
        "core_298": run(root, variant_names()),
        "t1": run(root, [*variant_names(), *track_names("t1")]),
        "net_of_charges": "not computed: needs the BL-096 per-trade model; mean trades per differing day reported instead",
    }
    (HERE / "h3_expiring_index_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for label in ("core_298", "t1"):
        r = report[label]
        print(f"\n=== {label}  (both expire: {r['days_with_both_indices_expiring']})")
        for k in ("all", "NIFTY_expiry_days", "SENSEX_expiry_days"):
            s = r[k]
            ci = f" CI90 [{s['ci90'][0]:+.0f}, {s['ci90'][1]:+.0f}]" if "ci90" in s else ""
            mean = s.get("mean_difference_per_lot")
            mean_text = f"{mean:+.0f}" if mean is not None else "n/a"
            print(
                f"{k:20} expiry days {s['expiry_days']:3}  differing {s['differing_days']:3}  "
                f"EXP minus free: mean {mean_text}{ci}  sum {s['sum_difference_per_lot']:+,.0f}  "
                f"EXP better on {s['share_of_differing_days_exp_better']}  -> {s.get('reading')}"
            )


if __name__ == "__main__":
    main()
