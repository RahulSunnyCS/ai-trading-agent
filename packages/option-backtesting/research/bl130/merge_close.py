"""BL-130: merge two same-index Widesl picks entered within 30 minutes into one two-lot entry.

As registered in backlog/BL-130 (descriptive, in-sample). Reads the live store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl130/merge_close.py
"""

from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import is_wide, track_names, variant_names

HERE = Path(__file__).parent
WINDOWS = {
    "two_years": (date(2025, 1, 10), date(2026, 10, 16)),
    "last_year": (date(2025, 10, 9), date(2026, 10, 16)),
}
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261022, 0.90
BROKERAGE = 20.0 * 1.18  # per order, with GST
GAP = 30  # minutes, inclusive


def read(name: str, root: Path) -> dict[date, tuple[float, int]]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                n = int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else 0
                out[date.fromisoformat(r["day"])] = (float(r["gross"]), n)
            except (KeyError, ValueError):
                continue
    return out


def minutes(name: str) -> int:
    slot = name.rsplit("_", 1)[1]
    return int(slot[:2]) * 60 + int(slot[2:])


def merge(core: list[str], identical: bool) -> dict[str, int]:
    """{entry: lots} after merging Widesl picks within GAP minutes of an earlier anchor."""
    lots = {n: 1 for n in core if not is_wide(n)}
    anchors: list[str] = []
    for n in sorted((n for n in core if is_wide(n)), key=lambda n: (minutes(n), n)):
        for a in anchors:
            same_index = a.split("_", 1)[0] == n.split("_", 1)[0]
            same_strategy = a.rsplit("_", 1)[0] == n.rsplit("_", 1)[0]
            if same_index and (same_strategy or not identical) and minutes(n) - minutes(a) <= GAP:
                lots[a] += 1
                break
        else:
            anchors.append(n)
            lots[n] = 1
    assert sum(lots.values()) == len(core)
    return lots


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "interval_reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def run(root: Path, names: list[str]) -> dict:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cache: dict[str, dict] = {}

    def val(n, d):
        if n not in cache:
            cache[n] = read(n, root)
        return cache[n].get(d)

    rows = []
    for d in rec.days_available():
        if not (WINDOWS["two_years"][0] <= d <= WINDOWS["two_years"][1]):
            continue
        core = rec.picks(d)["C"]["core"]
        got = {n: val(n, d) for n in core}
        if any(v is None for v in got.values()):
            continue
        row = {"day": d.isoformat()}
        for book, lots in (
            ("A", {n: 1 for n in core}),
            ("M1", merge(core, identical=True)),
            ("M2", merge(core, identical=False)),
        ):
            gross = sum(k * got[n][0] for n, k in lots.items())
            brokerage = sum(2 * got[n][1] * BROKERAGE for n in lots)
            row[book] = {
                "gross": gross,
                "net": gross - brokerage,
                "entries": len(lots),
                "lots": list(lots.values()),
            }
        rows.append(row)

    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for r in rows if lo.isoformat() <= r["day"] <= hi.isoformat()]
        a_net = np.array([r["A"]["net"] for r in sub])
        a_gross = np.array([r["A"]["gross"] for r in sub])
        w = {
            "days": len(sub),
            "A": {
                "net_per_day": float(a_net.mean()),
                "net_max_drawdown": max_drawdown(a_net),
                "net_worst_day": float(a_net.min()),
                "gross_max_drawdown": max_drawdown(a_gross),
                "gross_worst_day": float(a_gross.min()),
            },
        }
        for book in ("M1", "M2"):
            m_net = np.array([r[book]["net"] for r in sub])
            m_gross = np.array([r[book]["gross"] for r in sub])
            w[book] = {
                "days_merged": int(sum(r[book]["entries"] < r["A"]["entries"] for r in sub)),
                "net_per_day": float(m_net.mean()),
                "m_minus_a_net": interval(m_net - a_net),
                "m_minus_a_gross_per_day": float((m_gross - a_gross).mean()),
                "brokerage_saved_per_day": float(((m_net - m_gross) - (a_net - a_gross)).mean()),
                "net_max_drawdown": max_drawdown(m_net),
                "net_worst_day": float(m_net.min()),
                "gross_max_drawdown": max_drawdown(m_gross),
                "gross_worst_day": float(m_gross.min()),
                "three_lot_days": int(sum(max(r[book]["lots"]) == 3 for r in sub)),
            }
            m = w[book]
            m["reading"] = (
                "positive"
                if m["m_minus_a_net"]["ci90"][0] > 0
                and m["net_max_drawdown"] >= w["A"]["net_max_drawdown"]
                else "not positive"
            )
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    report = {
        "core_298": run(root, variant_names()),
        "t1": run(root, [*variant_names(), *track_names("t1")]),
        "note": "one lot per pick, core only; net = gross minus brokerage (turnover charges equal in all books)",
    }
    (HERE / "merge_close_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for u in ("core_298", "t1"):
        for wname, w in report[u].items():
            a = w["A"]
            print(
                f"{u:8} {wname:9} {w['days']} days | A net {a['net_per_day']:+.0f}/day "
                f"DD {a['net_max_drawdown']:,.0f} worst {a['net_worst_day']:,.0f}"
            )
            for book in ("M1", "M2"):
                m = w[book]
                d = m["m_minus_a_net"]
                print(
                    f"   {book}: merged on {m['days_merged']} days | net {m['net_per_day']:+.0f}/day "
                    f"| M-A net {d['mean']:+.0f} [{d['ci90'][0]:+.0f},{d['ci90'][1]:+.0f}] {d['interval_reading']} -> {m['reading']} (3-lot days {m['three_lot_days']}) "
                    f"(gross {m['m_minus_a_gross_per_day']:+.0f}, brokerage saved {m['brokerage_saved_per_day']:.0f}) "
                    f"| DD {m['net_max_drawdown']:,.0f} worst {m['net_worst_day']:,.0f}"
                )


if __name__ == "__main__":
    main()
