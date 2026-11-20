"""BL-238: T1 from scratch. Every strategy re-simulated from the lake, every day re-ranked on those
fresh results, the picks re-run, return and drawdown compared with the stored figures.

    uv run python research/bl238/run.py sim        # fresh simulations of the pool on every usable day (resumable)
    uv run python research/bl238/run.py pick       # attributes + ranking on the fresh results -> picks_by_day.csv
    uv run python research/bl238/run.py paths      # the picks' fresh minute paths, the book under the stop
    uv run python research/bl238/run.py report     # figures, then (only now) the comparison with the stored ones

Registered in backlog/BL-238-t1-from-scratch-audit.md (committed before this ran). The stages `sim`,
`pick` and `paths` read nothing that rotation/ stores: the lake's bars, the strategy files, the
reference CSVs and the data_quality verdict only. `report` opens the stored results last.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
OUT = Path(os.environ.get("BL238_OUT", str(HERE / "out")))  # heavy files, git-ignored
SIM = OUT / "sim"
END = date(2026, 11, 19)
SEARCH_FROM = date(2024, 6, 1)
STOP_INR = 9000.0  # the T1 book stop, per lot of the book
SLIP = 0.5
COMPARE_FROM = date(2025, 1, 10)  # the stored figures' first pick day
WORKERS = int(os.environ.get("BL238_WORKERS", "5"))

_G: dict = {}


def pool_names() -> list[str]:
    from option_backtesting.rotation.variants import track_names, variant_names

    return variant_names() + track_names("t1")


def usable_days() -> list[date]:
    """Weekdays with option + index bars for NIFTY and SENSEX that data_quality does not exclude,
    and an India VIX bar: the lake's own facts (no stored rotation file)."""
    from trading_data import lake

    from option_backtesting.rotation import attrs

    excluded = attrs.excluded_map(ROOT)
    out, d = [], SEARCH_FROM
    while d <= END:
        if (
            attrs.is_collected(ROOT, d, excluded)
            and lake.bars_1m_path(ROOT, "index", attrs.VIX_NAME, d).exists()
        ):
            out.append(d)
        d += timedelta(days=1)
    return out


# -- stage 1: fresh simulations ------------------------------------------------------------------


def _init() -> None:
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.schema import load_legwise
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.rotation.variants import strategy_path, underlying_of

    names = pool_names()
    _G["names"] = names
    _G["specs"] = [load_legwise(strategy_path(n)) for n in names]
    _G["und"] = [underlying_of(n) for n in names]
    _G["ref"] = default_reference_data()
    _G["sizing"] = date.fromisoformat(SIZING_DATE)


def _sim_day(day_iso: str) -> str:
    from option_backtesting.data.reference.loader import MissingReferenceData
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.rotation import attrs
    from option_backtesting.rotation.dte import from_calendar_label

    target = SIM / f"{day_iso}.json"
    if target.exists():
        return day_iso
    day = date.fromisoformat(day_iso)
    loaded = {u: load_day(ROOT, u, day) for u in attrs.UNDERLYINGS}
    rows, errors = [], []
    for name, spec, und in zip(_G["names"], _G["specs"], _G["und"], strict=True):
        try:
            r = simulate_day(spec, loaded[und], _G["ref"], _G["sizing"])
            rows.append([round(r.gross - r.costs, 2), round(r.gross, 2), round(r.costs, 2)])
        except MissingReferenceData as error:
            rows.append([None, None, None])
            errors.append(f"{name}: {error}")
    a = attrs.day_attributes(ROOT, day)
    for key in ("dte_n", "dte_s"):
        a[key] = from_calendar_label(a[key], day)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"day": day_iso, "attrs": a, "rows": rows, "errors": errors}))
    tmp.replace(target)
    return day_iso


def stage_sim() -> None:
    SIM.mkdir(parents=True, exist_ok=True)
    days = usable_days()
    todo = [d.isoformat() for d in days if not (SIM / f"{d.isoformat()}.json").exists()]
    print(f"{len(days)} usable days from {days[0]} to {days[-1]}; {len(todo)} to simulate")
    (OUT / "days.json").write_text(json.dumps([d.isoformat() for d in days]))
    t = time.time()
    with ProcessPoolExecutor(WORKERS, initializer=_init) as pool:
        for i, day in enumerate(pool.map(_sim_day, todo, chunksize=1), 1):
            if i % 20 == 0 or i == len(todo):
                print(f"[{time.time() - t:6.0f}s] {i}/{len(todo)} (last {day})", flush=True)


# -- stage 2: rank every day on the fresh results ---------------------------------------------------


def load_sim() -> tuple[list[date], list[str], np.ndarray, dict[date, dict]]:
    days = [date.fromisoformat(x) for x in json.loads((OUT / "days.json").read_text())]
    names = pool_names()
    net = np.full((len(days), len(names)), np.nan)
    attrs_by: dict[date, dict] = {}
    for i, d in enumerate(days):
        j = json.loads((SIM / f"{d.isoformat()}.json").read_text())
        attrs_by[d] = j["attrs"]
        for k, row in enumerate(j["rows"]):
            if row[0] is not None:
                net[i, k] = row[0]
    return days, names, net, attrs_by


def stage_pick() -> None:
    from option_backtesting.rotation import expiry
    from option_backtesting.rotation.lists import WARMUP
    from option_backtesting.rotation.pick import History, score_history

    days, names, net, attrs_by = load_sim()
    bad = int(np.isnan(net).sum())
    print(f"{len(days)} days x {len(names)} variants, {bad} cells without a result")
    assert bad == 0, "a variant could not be simulated on a day: see the sim files' errors"
    rows = []
    for i, d in enumerate(days):
        if i < WARMUP:
            continue
        hist_days = days[:i]
        assert hist_days[-1] < d and len(hist_days) == i  # no row of the target day in the history
        a = attrs_by[d]
        hist = History(
            hist_days,
            list(names),
            net[:i],
            [attrs_by[x]["weekday"] for x in hist_days],
            [attrs_by[x]["vix_band"] for x in hist_days],
            [attrs_by[x]["dte_n"] for x in hist_days],
            [attrs_by[x]["dte_s"] for x in hist_days],
            "",
        )
        vix = float(a["vix_open"]) if a["vix_open"] not in ("", None) else None
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        rule = expiry.rule_index(d, dte)
        c = score_history(hist, d, vix, dte, expiry_only=rule)["C"]
        rows.append(
            {
                "day": d.isoformat(),
                "weekday": a["weekday"],
                "dte_n": a["dte_n"],
                "dte_s": a["dte_s"],
                "vix_open": a["vix_open"],
                "expiry_only": rule or "",
                "picks": " ".join(list(c["core"]) + list(c["buy"])),
            }
        )
    with (HERE / "picks_by_day.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} pick days, first {rows[0]['day']}, last {rows[-1]['day']}")


# -- stage 3: the picks run fresh, the book under the stop -----------------------------------------


def stage_paths() -> None:
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import load_legwise
    from option_backtesting.rotation import portfolio, slip_store
    from option_backtesting.rotation.lists import SIZING_DATE
    from option_backtesting.rotation.variants import strategy_path, underlying_of

    picks = list(csv.DictReader((HERE / "picks_by_day.csv").open()))
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    out = []
    t = time.time()
    for n, row in enumerate(picks, 1):
        d = date.fromisoformat(row["day"])
        names = row["picks"].split()
        loaded = {}
        res = {}
        for name in names:
            und = underlying_of(name)
            if und not in loaded:
                loaded[und] = load_day(ROOT, und, d)
            res[name] = simulate_day(load_legwise(strategy_path(name)), loaded[und], ref, sizing)
        entry = {"day": row["day"], "picks": names}
        for tag, slip in (("s0", 0.0), ("s5", SLIP)):
            members = []
            for name in names:
                r = res[name]
                mtm, gross = (r.mtm, r.gross) if not slip else slip_store.slipped_curve(r, slip)
                members.append(portfolio.member_from_curve(name, 1, mtm, gross))
            b = portfolio.apply_book(members, STOP_INR)
            entry[tag] = {
                "picks": {nm: round(m.pnl[-1], 2) for nm, m in zip(names, members, strict=True)},
                "no_stop": round(b.gross_without, 2),
                "stop": round(b.gross_with, 2),
                "stopped_at": b.stop_label,
            }
        out.append(entry)
        if n % 25 == 0 or n == len(picks):
            print(f"[{time.time() - t:6.0f}s] {n}/{len(picks)}", flush=True)
    (OUT / "paths.json").write_text(json.dumps(out))


# -- stage 4: figures, then the comparison -----------------------------------------------------------


def max_dd(x: list[float]) -> float:
    c = peak = worst = 0.0
    for v in x:
        c += v
        peak = max(peak, c)
        worst = max(worst, peak - c)
    return worst


def figures(entries: list[dict], key: str, field: str, since: date | None = None) -> dict:
    sel = [e for e in entries if since is None or date.fromisoformat(e["day"]) >= since]
    x = [e[key][field] for e in sel]
    return {
        "days": len(x),
        "net": round(sum(x), 0),
        "mean_per_lot_day": round(sum(x) / len(x), 1) if x else 0,
        "max_drawdown": round(max_dd(x), 0),
        "drawdown_now": round(_dd_now(x), 0),
    }


def _dd_now(x: list[float]) -> float:
    c = peak = 0.0
    for v in x:
        c += v
        peak = max(peak, c)
    return peak - c


def stage_report() -> None:
    entries = json.loads((OUT / "paths.json").read_text())
    fresh = {}
    for tag in ("s0", "s5"):
        for field in ("stop", "no_stop"):
            fresh[f"{tag}_{field}"] = {
                "whole": figures(entries, tag, field),
                "from_2025_01_10": figures(entries, tag, field, COMPARE_FROM),
            }
    result = {"fresh": fresh, "first_pick_day": entries[0]["day"], "last_day": entries[-1]["day"]}
    (HERE / "result_fresh.json").write_text(json.dumps(result, indent=1))
    print("fresh figures written (before any stored file is opened)")
    for k, v in fresh.items():
        print(k, v["whole"], "|", v["from_2025_01_10"])

    # -- only now: the stored results ---------------------------------------------------------
    from option_backtesting.rotation import store

    days, names, net, _ = load_sim()
    stored = store.load_matrix(names, ROOT)
    pos = {d: i for i, d in enumerate(stored.days)}
    idx = {n: j for j, n in enumerate(stored.names)}
    diff_cells, same, missing = [], 0, 0
    for i, d in enumerate(days):
        if d not in pos:
            missing += net.shape[1]
            continue
        for k, n in enumerate(names):
            s = stored.values[pos[d], idx[n]]
            if np.isnan(s):
                missing += 1
            elif abs(s - net[i, k]) > 1.0:
                diff_cells.append(
                    (d.isoformat(), n, round(float(net[i, k]), 2), round(float(s), 2))
                )
            else:
                same += 1
    by_day: dict[str, int] = {}
    for d, *_ in diff_cells:
        by_day[d] = by_day.get(d, 0) + 1
    cmp = {
        "cells_same": same,
        "cells_differ_over_1_rupee": len(diff_cells),
        "cells_not_in_stored": missing,
        "days_with_differences": len(by_day),
        "worst_days": sorted(by_day.items(), key=lambda kv: -kv[1])[:15],
        "largest_cells": sorted(diff_cells, key=lambda c: -abs(c[2] - c[3]))[:15],
    }
    # the stored picks and book figures (candles, built from the journal and the stored results)
    stored_book = {}
    for tag, sl in (("s0", "0.0"), ("s5", "0.5")):
        p = Path(os.environ.get("BL238_STORED", "")) / f"n_t1_{sl}.json"
        if p.exists():
            j = json.loads(p.read_text())
            stored_book[tag] = {
                x["day"]: {"pnl": x["pnl"], "picks": sorted(p_["name"] for p_ in x["picks"])}
                for x in j["days"]
            }
    pick_match = {"days_compared": 0, "same_picks": 0, "different": []}
    daily = {"s0": [], "s5": []}
    if stored_book:
        by = {e["day"]: e for e in entries}
        for dd_, sb in stored_book.get("s0", {}).items():
            e = by.get(dd_)
            if e is None or date.fromisoformat(dd_) < COMPARE_FROM:
                continue
            pick_match["days_compared"] += 1
            if sorted(e["picks"]) == sb["picks"]:
                pick_match["same_picks"] += 1
            else:
                pick_match["different"].append([dd_, sorted(e["picks"]), sb["picks"]])
        for tag in ("s0", "s5"):
            for dd_, sb in stored_book.get(tag, {}).items():
                e = by.get(dd_)
                if e is not None and date.fromisoformat(dd_) >= COMPARE_FROM:
                    daily[tag].append((dd_, e[tag]["stop"], sb["pnl"]))
    stored_fig = {}
    for tag in ("s0", "s5"):
        if daily[tag]:
            fr = [a for _, a, _ in daily[tag]]
            st = [b for _, _, b in daily[tag]]
            stored_fig[tag] = {
                "days": len(fr),
                "fresh_net": round(sum(fr), 0),
                "stored_net": round(sum(st), 0),
                "fresh_max_dd": round(max_dd(fr), 0),
                "stored_max_dd": round(max_dd(st), 0),
                "days_pnl_differ_over_1": sum(
                    1 for a, b in zip(fr, st, strict=True) if abs(a - b) > 1
                ),
                "largest_day_gaps": sorted(
                    [(d_, a, b) for d_, a, b in daily[tag] if abs(a - b) > 1],
                    key=lambda t: -abs(t[1] - t[2]),
                )[:10],
            }
    pick_match["share_same"] = (
        round(pick_match["same_picks"] / pick_match["days_compared"], 4)
        if pick_match["days_compared"]
        else None
    )
    result.update({"stored_cells": cmp, "stored_picks": pick_match, "stored_book": stored_fig})
    (HERE / "result.json").write_text(json.dumps(result, indent=1))
    print(json.dumps({k: result[k] for k in ("stored_cells", "stored_book")}, indent=1)[:4000])
    print("picks same on", pick_match["same_picks"], "of", pick_match["days_compared"], "days")


if __name__ == "__main__":
    {"sim": stage_sim, "pick": stage_pick, "paths": stage_paths, "report": stage_report}[
        sys.argv[1]
    ]()
