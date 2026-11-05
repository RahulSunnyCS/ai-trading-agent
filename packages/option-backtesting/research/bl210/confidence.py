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
LIST_KEY = "C"
SCALE = 3000.0  # rupees per basket-day that read 0 (-) and 100 (+): fixed in Phase 0
SKIP_BELOW = 40.0  # the one declared skip rule, descriptive only
FIRST = date(2025, 1, 10)  # first day with WARMUP earlier days of results
FORWARD_FROM = date(2026, 10, 12)  # the journal's first entry: held out of the verdict
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261105, 0.90
SPREAD_MIN = 500.0  # tercile spread a pass needs, rupees per basket-day
CRITERIA = ("recent", "weekday", "dte", "vix")
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


def picks_for(prep: dict, i: int) -> list[str] | None:
    """The three core picks list C would record on day i (rows strictly before i, the day's own
    attributes; a journal day: the entry's recorded attributes), with the expiry-only rule and
    the SL150 % cap as the day itself decides them."""
    names = prep["names"]
    day: date = prep["days"][i]
    weekday, band = prep["weekday"][: i + 1].copy(), prep["band"][: i + 1].copy()
    dmat = prep["dmat"][: i + 1].copy()
    entry = prep["entries"].get(day.isoformat())
    if entry is not None:
        weekday[-1] = entry["weekday"]
        band[-1] = entry["vix_band"]
        lab = entry_labels(entry)
        dmat[-1] = dte_matrix(
            np.array([str(lab.get("NIFTY", "unknown"))]),
            np.array([str(lab.get("SENSEX", "unknown"))]),
            names,
        )[0]
    P = np.vstack([prep["net"][:i], np.zeros((1, len(names)))])  # row i is never read
    assert P.shape[0] == i + 1
    comp = composite(P, weekday, band, dmat, names, LISTS[LIST_KEY], prep["fam"])
    picks = select(comp, names)
    dte_n = (
        str(prep["attrs"][day]["dte_n"]) if entry is None else str(entry_labels(entry).get("NIFTY"))
    )
    dte_s = (
        str(prep["attrs"][day]["dte_s"])
        if entry is None
        else str(entry_labels(entry).get("SENSEX"))
    )
    rule = expiry.rule_index(day, {"dte_n": dte_n, "dte_s": dte_s})
    if rule and LIST_KEY in expiry.RULE_LISTS:
        picks = expiry.filter_picks(comp, names, picks, rule)
    elif sl150_cap.applies(day, dte_n) and LIST_KEY in expiry.RULE_LISTS:
        picks = sl150_cap.cap_picks(comp, names, picks)
    return list(picks.core), weekday, band, dmat


# ---------------------------------------------------------------------------------------------
# The confidence
# ---------------------------------------------------------------------------------------------
def _blend(b: np.ndarray) -> tuple[float, float, float]:
    """(win %, rupee score, c) of a basket series on matched days."""
    win = 100.0 * float((b > 0).mean())
    rup = float(np.clip(50.0 + 50.0 * b.mean() / SCALE, 0.0, 100.0))
    return win, rup, (win + rup) / 2.0


def confidence(prep: dict, i: int, core: list[str], weekday, band, dmat) -> dict:
    """C(D) for day i from the basket's own days in list C's windows (Phase 0 definitions)."""
    names = prep["names"]
    idx = [names.index(n) for n in core]
    P = prep["net"][:i]  # rows strictly before i
    b = P[:, idx].sum(axis=1)  # the basket's series (every variant has a result on common days)
    lst = LISTS[LIST_KEY]
    out: dict = {}
    crit: dict[str, float] = {}
    # recent: the last 10 days, 2/3 on the last 5, 1/3 on the 5 before (as score.recent_score)
    if i >= 10:
        last5, prev5 = b[i - 5 : i], b[i - 10 : i - 5]
        w5, r5, c5 = _blend(last5)
        w10, r10, c10 = _blend(prev5)
        crit["recent"] = (2 / 3) * c5 + (1 / 3) * c10
        out["recent"] = {
            "win": round((2 / 3) * w5 + (1 / 3) * w10, 1),
            "rupee": round((2 / 3) * r5 + (1 / 3) * r10, 1),
            "days": 10,
        }
    # the fit criteria: matched days per lookback window, blended by the lookback weights and
    # renormalised over the windows with a matching day (as score.skewed_fit)
    matches = {
        "weekday": weekday[:i] == weekday[i],
        "vix": band[:i] == band[i],
        # dte: every pick's own label matches the day's (a NIFTY pick dte_n, a SENSEX pick dte_s)
        "dte": np.all(dmat[:i][:, idx] == dmat[i][idx][None, :], axis=1),
    }
    for k, m in matches.items():
        num = den = 0.0
        wins = rups = 0.0
        n_days = 0
        for n, w in lst.lookbacks:
            lo = max(0, i - n)
            mm = m[lo:i]
            if not mm.any():
                continue
            win, rup, c = _blend(b[lo:i][mm])
            num += w * c
            wins += w * win
            rups += w * rup
            den += w
            n_days = max(n_days, int(mm.sum()))
        if den > 0:
            crit[k] = num / den
            out[k] = {"win": round(wins / den, 1), "rupee": round(rups / den, 1), "days": n_days}
    weights = {k: lst.weights[k] for k in CRITERIA if k in crit}
    total = sum(weights.values())
    c = sum(weights[k] / total * crit[k] for k in weights) if total else float("nan")
    out["confidence"] = round(float(c), 2)
    out["criteria"] = {k: round(v, 2) for k, v in crit.items()}
    return out


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
        core, weekday, band, dmat = picks_for(prep, i)
        if len(core) == 0:
            continue
        conf = confidence(prep, i, core, weekday, band, dmat)
        idx = [prep["names"].index(n) for n in core]
        net = float(prep["net"][i, idx].sum())  # read AFTER C(D): the day's own result
        rows.append({"day": day.isoformat(), "picks": core, "net": round(net, 0), **conf})
    research = [r for r in rows if date.fromisoformat(r["day"]) < FORWARD_FROM]
    forward = [r for r in rows if date.fromisoformat(r["day"]) >= FORWARD_FROM]
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
                        *(
                            r.get(k, {}).get(m, "")
                            for k in CRITERIA
                            for m in ("win", "rupee", "days")
                        ),
                    ]
                )
        print(f"\n== {book} ({result['variants']} variants) -> {result['verdict'].upper()}")
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
    (HERE / f"confidence_{today}.json").write_text(json.dumps(report, indent=1))
    print(f"\nVERDICT: {overall.upper()}  -> {HERE / f'confidence_{today}.json'}")


if __name__ == "__main__":
    main()
