"""BL-210: an absolute 0-100 confidence beside the rotation rank, tested as research.

For every day of each book (Core: list C over Core-298; T1: list C over Core-298 + the T1 track)
the picks are re-derived from the stored results as the morning ranking does, the picked basket's
own history (the three core picks' net per lot summed, slippage 0) is read on the ranking's own
matched days and windows, and a blend of win rate and rupees per criterion gives C(D) in [0, 100],
exactly as registered in backlog/BL-210 Phase 0. C(D) is then set against the basket's net on D:
Spearman and tercile spread with 5-day block-bootstrap 90 % intervals on the research set, the
halves, and the forward set (held out of the verdict), plus the one declared skip rule (C < 40),
descriptive. Reads the live store, writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl210/confidence.py
"""

from __future__ import annotations

import csv
import json
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import expiry, journal, sl150_cap, store
from option_backtesting.rotation.dte import entry_labels
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.readout import max_drawdown
from option_backtesting.rotation.score import composite, dte_matrix, family_index, select
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from pick_confidence import CRITERIA, SCALE, basket_confidence  # noqa: E402

LIST_KEY = "C"
SKIP_BELOW = 40.0  # the one declared skip rule, descriptive only
FIRST = date(2025, 1, 10)  # first day with WARMUP earlier days of results
FORWARD_FROM = date(2026, 10, 12)  # the journal's first entry: held out of the verdict
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261105, 0.90
SPREAD_MIN = 500.0  # tercile spread a pass needs, rupees per basket-day
BOOKS = {"core": None, "t1": "t1"}


# ---------------------------------------------------------------------------------------------
# The ranking's inputs for one book, as rankic._prepared builds them
# ---------------------------------------------------------------------------------------------
def prepare(track: str | None):
    """The ranking's inputs for one book, as `rankic._prepared` builds them, read through
    `store.load_matrix` (which routes a track's variants to `track_<t>/results/`; `explain`'s
    snapshot reads the live folder only) and the book's own journal for recorded attributes."""
    root = data_dir()
    names = variant_names() + (track_names(track) if track else [])
    with store.slipped(0.0):  # the ranking never reads the slippage copy
        m = store.load_matrix(names, root)
    attrs = store.read_days(root)
    rows = [i for i, d in enumerate(m.days) if d in attrs]
    days = [m.days[i] for i in rows]
    jpath = store.journal_path(root, track)
    problems = list(journal.verify(jpath)) if jpath.exists() else ["no journal"]
    entries = {} if problems else {e["day"]: e for e in journal.read(jpath)}
    return {
        "names": list(m.names),
        "days": days,
        "attrs": attrs,
        "net": m.values[rows],
        "weekday": np.array([attrs[d]["weekday"] for d in days]),
        "band": np.array([attrs[d]["vix_band"] for d in days]),
        "dmat": dte_matrix(
            np.array([attrs[d]["dte_n"] for d in days]),
            np.array([attrs[d]["dte_s"] for d in days]),
            list(m.names),
        ),
        "fam": family_index(list(m.names)),
        "entries": entries,
    }


def picks_for(
    prep: dict, i: int
) -> tuple[list[str], np.ndarray, np.ndarray, np.ndarray, bool | None]:
    """The three core picks list C would record on day i (rows strictly before i, the day's own
    attributes; a journal day: the entry's recorded attributes and its recorded expiry-only rule,
    as `rankic.day_row`), with the SL150 % cap as the day itself decides it. The last value says
    whether a journal day's re-derived picks equal the recorded ones (None: not a journal day)."""
    names = prep["names"]
    day: date = prep["days"][i]
    weekday, band = prep["weekday"][: i + 1].copy(), prep["band"][: i + 1].copy()
    dmat = prep["dmat"][: i + 1].copy()
    entry = prep["entries"].get(day.isoformat())
    if entry is not None:
        weekday[-1] = entry["weekday"]
        band[-1] = entry["vix_band"]
        lab = entry_labels(entry)
        dte_n, dte_s = str(lab.get("NIFTY", "unknown")), str(lab.get("SENSEX", "unknown"))
        dmat[-1] = dte_matrix(np.array([dte_n]), np.array([dte_s]), names)[0]
        rule = entry.get("expiry_only")
    else:
        dte_n, dte_s = str(prep["attrs"][day]["dte_n"]), str(prep["attrs"][day]["dte_s"])
        rule = expiry.rule_index(day, {"dte_n": dte_n, "dte_s": dte_s})
    P = np.vstack([prep["net"][:i], np.zeros((1, len(names)))])  # row i is never read
    assert P.shape[0] == i + 1
    comp = composite(P, weekday, band, dmat, names, LISTS[LIST_KEY], prep["fam"])
    picks = select(comp, names)
    if rule and LIST_KEY in expiry.RULE_LISTS:
        picks = expiry.filter_picks(comp, names, picks, rule)
    elif sl150_cap.applies(day, dte_n) and LIST_KEY in expiry.RULE_LISTS:
        picks = sl150_cap.cap_picks(comp, names, picks)
    matches = None
    if entry is not None:
        rec = ((entry.get("lists") or {}).get(LIST_KEY) or {}).get("core")
        matches = rec is not None and set(rec) == set(picks.core)
    return list(picks.core), weekday, band, dmat, matches


# ---------------------------------------------------------------------------------------------
# The confidence (the definition lives in research/common/pick_confidence.py since BL-212)
# ---------------------------------------------------------------------------------------------
def confidence(prep: dict, i: int, core: list[str], weekday, band, dmat) -> dict:
    """C(D) for day i from the basket's own days in list C's windows (Phase 0 definitions)."""
    idx = [prep["names"].index(n) for n in core]
    return basket_confidence(prep["net"], idx, i, weekday, band, dmat, LISTS[LIST_KEY], SCALE)


# ---------------------------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------------------------
def _rank(x: np.ndarray) -> np.ndarray:
    order = np.argsort(x, kind="stable")
    _, start, counts = np.unique(x[order], return_index=True, return_counts=True)
    ranks = np.empty(len(x))
    ranks[order] = np.repeat(start + (counts + 1) / 2, counts)
    return ranks


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    rx, ry = _rank(x), _rank(y)
    if rx.std() == 0 or ry.std() == 0:
        return float("nan")
    return float(np.corrcoef(rx, ry)[0, 1])


def block_indices(n: int, resamples: int, block: int, seed: int) -> np.ndarray:
    nb = -(-n // block)
    rng = np.random.default_rng(seed)
    starts = rng.integers(0, n, size=(resamples, nb))
    return ((starts[:, :, None] + np.arange(block)[None, None, :]) % n).reshape(resamples, -1)[
        :, :n
    ]


def boot(stat, c: np.ndarray, net: np.ndarray) -> tuple[float, float, float]:
    """(value, lower, upper) of `stat(c, net)` under circular moving blocks of BLOCK days."""
    n = len(c)
    if n < 2 * BLOCK:
        return float("nan"), float("nan"), float("nan")
    idx = block_indices(n, RESAMPLES, BLOCK, SEED)
    vals = np.array([stat(c[r], net[r]) for r in idx])
    vals = vals[~np.isnan(vals)]
    lo, hi = np.percentile(vals, [(1 - LEVEL) / 2 * 100, (1 + LEVEL) / 2 * 100])
    return float(stat(c, net)), float(lo), float(hi)


def tercile_spread(c: np.ndarray, net: np.ndarray) -> float:
    lo, hi = np.percentile(c, [100 / 3, 200 / 3])
    bottom, top = net[c <= lo], net[c >= hi]
    if len(bottom) == 0 or len(top) == 0:
        return float("nan")
    return float(top.mean() - bottom.mean())


def describe(rows: list[dict], label: str) -> dict:
    c = np.array([r["confidence"] for r in rows], dtype=float)
    net = np.array([r["net"] for r in rows], dtype=float)
    keep = ~np.isnan(c)
    c, net = c[keep], net[keep]
    rho = boot(spearman, c, net)
    spread = boot(tercile_spread, c, net)
    lo_cut, hi_cut = np.percentile(c, [100 / 3, 200 / 3]) if len(c) else (np.nan, np.nan)
    terciles = {
        "bottom": {
            "n": int((c <= lo_cut).sum()),
            "mean_net": round(float(net[c <= lo_cut].mean()), 0) if (c <= lo_cut).any() else None,
            "max_c": round(float(lo_cut), 1),
        },
        "middle": {
            "n": int(((c > lo_cut) & (c < hi_cut)).sum()),
            "mean_net": round(float(net[(c > lo_cut) & (c < hi_cut)].mean()), 0)
            if ((c > lo_cut) & (c < hi_cut)).any()
            else None,
        },
        "top": {
            "n": int((c >= hi_cut).sum()),
            "mean_net": round(float(net[c >= hi_cut].mean()), 0) if (c >= hi_cut).any() else None,
            "min_c": round(float(hi_cut), 1),
        },
    }
    skip = c < SKIP_BELOW
    kept = np.where(skip, 0.0, net)
    rule = {
        "days_skipped": int(skip.sum()),
        "skipped_days_net": round(float(net[skip].sum()), 0),
        "net_all": round(float(net.sum()), 0),
        "net_with_skip": round(float(kept.sum()), 0),
        "max_drawdown_all": round(float(max_drawdown(net)), 0) if len(net) else None,
        "max_drawdown_with_skip": round(float(max_drawdown(kept)), 0) if len(net) else None,
    }
    return {
        "label": label,
        "days": int(len(c)),
        "first": rows[0]["day"] if rows else None,
        "last": rows[-1]["day"] if rows else None,
        "confidence": {
            "mean": round(float(c.mean()), 1) if len(c) else None,
            "min": round(float(c.min()), 1) if len(c) else None,
            "max": round(float(c.max()), 1) if len(c) else None,
        },
        "spearman": {"value": round(rho[0], 4), "lo": round(rho[1], 4), "hi": round(rho[2], 4)},
        "tercile_spread": {
            "value": round(spread[0], 0),
            "lo": round(spread[1], 0),
            "hi": round(spread[2], 0),
        },
        "terciles": terciles,
        "skip_rule": rule,
    }


def verdict(research: dict) -> str:
    rho, spread = research["spearman"], research["tercile_spread"]
    if rho["value"] > 0 and rho["lo"] > 0 and spread["value"] > SPREAD_MIN and spread["lo"] > 0:
        return "pass"
    return "kill"


# ---------------------------------------------------------------------------------------------
def run_book(book: str, track: str | None) -> dict:
    prep = prepare(track)
    days = prep["days"]
    rows = []
    for i, day in enumerate(days):
        if i < WARMUP or day < FIRST:
            continue
        core, weekday, band, dmat, matches = picks_for(prep, i)
        conf = confidence(prep, i, core, weekday, band, dmat)
        idx = [prep["names"].index(n) for n in core]
        net = float(prep["net"][i, idx].sum())  # read AFTER C(D): the day's own result
        rows.append(
            {
                "day": day.isoformat(),
                "picks": core,
                "net": round(net, 0),
                "matches_entry": matches,
                **conf,
            }
        )
    research = [r for r in rows if date.fromisoformat(r["day"]) < FORWARD_FROM]
    # a forward day counts only when the re-derived picks are the ones the journal recorded; any
    # other journal day (results repaired since, a late entry) is listed, never a forward observation
    forward = [
        r
        for r in rows
        if date.fromisoformat(r["day"]) >= FORWARD_FROM and r["matches_entry"] is True
    ]
    unmatched = [
        r["day"]
        for r in rows
        if date.fromisoformat(r["day"]) >= FORWARD_FROM and r["matches_entry"] is not True
    ]
    half = len(research) // 2
    out = {
        "book": book,
        "variants": len(prep["names"]),
        "research": describe(research, "research set"),
        "first_half": describe(research[:half], "first half"),
        "second_half": describe(research[half:], "second half"),
        "forward": describe(forward, "forward (held out)")
        if len(forward) >= 2 * BLOCK
        else {"label": "forward (held out)", "days": len(forward)},
        "forward_unmatched": unmatched,
    }
    out["verdict"] = verdict(out["research"])
    return out, rows


def main() -> None:
    today = date.today().isoformat()
    report = {"run": today, "scale": SCALE, "skip_below": SKIP_BELOW, "list": LIST_KEY, "books": {}}
    for book, track in BOOKS.items():
        result, rows = run_book(book, track)
        report["books"][book] = result
        with (HERE / f"confidence_{book}_{today}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(
                [
                    "day",
                    "picks",
                    "confidence",
                    "net",
                    "matches_entry",
                    *(f"{k}_{m}" for k in CRITERIA for m in ("win", "rupee", "days")),
                ]
            )
            for r in rows:
                w.writerow(
                    [
                        r["day"],
                        " ".join(r["picks"]),
                        r["confidence"],
                        r["net"],
                        r["matches_entry"],
                        *(
                            r.get(k, {}).get(m, "")
                            for k in CRITERIA
                            for m in ("win", "rupee", "days")
                        ),
                    ]
                )
        print(f"\n== {book} ({result['variants']} variants) -> {result['verdict'].upper()}")
        if result["forward_unmatched"]:
            print(
                f"  forward days whose re-derived picks differ from the journal (not counted): {', '.join(result['forward_unmatched'])}"
            )
        for part in ("research", "first_half", "second_half", "forward"):
            d = result[part]
            if "spearman" not in d or d["days"] == 0:
                print(f"  {d['label']}: {d['days']} days (too few)")
                continue
            print(
                f"  {d['label']:18} {d['days']:3} days {d['first']}..{d['last']}  C mean {d['confidence']['mean']} "
                f"[{d['confidence']['min']}, {d['confidence']['max']}]  rho {d['spearman']['value']:+.3f} "
                f"[{d['spearman']['lo']:+.3f}, {d['spearman']['hi']:+.3f}]  spread {d['tercile_spread']['value']:+,.0f} "
                f"[{d['tercile_spread']['lo']:+,.0f}, {d['tercile_spread']['hi']:+,.0f}]"
            )
            t = d["terciles"]
            print(
                f"  {'':18} terciles bottom {t['bottom']['mean_net']} (C<={t['bottom']['max_c']}) · middle {t['middle']['mean_net']} · top {t['top']['mean_net']} (C>={t['top']['min_c']})"
            )
            s = d["skip_rule"]
            if s["max_drawdown_all"] is not None:
                print(
                    f"  {'':18} skip C<{SKIP_BELOW:.0f}: {s['days_skipped']} days skipped (net {s['skipped_days_net']:+,.0f}); all {s['net_all']:+,.0f} dd {s['max_drawdown_all']:,.0f} -> with skip {s['net_with_skip']:+,.0f} dd {s['max_drawdown_with_skip']:,.0f}"
                )
    books = report["books"]
    overall = (
        "pass"
        if all(b["verdict"] == "pass" for b in books.values())
        else "kill"
        if all(b["verdict"] == "kill" for b in books.values())
        else "inconclusive"
    )
    report["verdict"] = overall

    def _no_nan(x):
        if isinstance(x, float) and math.isnan(x):
            return None
        if isinstance(x, dict):
            return {k: _no_nan(v) for k, v in x.items()}
        if isinstance(x, list):
            return [_no_nan(v) for v in x]
        return x

    (HERE / f"confidence_{today}.json").write_text(json.dumps(_no_nan(report), indent=1))
    print(f"\nVERDICT: {overall.upper()}  -> {HERE / f'confidence_{today}.json'}")


if __name__ == "__main__":
    main()
