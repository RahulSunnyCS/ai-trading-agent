"""BL-154: replay Adaptive (list C) over Core-298 with shrunk fits and two opening labels, under the
label-shuffle control. The rule it applies is the item's Phase 0. Read-only: it reads the stored
results, `days.csv` and the lake's index bars, and writes only under this folder.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run --with pandas --with pyarrow \\
        python research/bl154/replay.py [--until YYYY-MM-DD]
"""

from __future__ import annotations

import csv
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.pick import History, score_history
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import (
    composite,
    family_index,
    pct_rank,
    recent_score,
    select,
    skewed_fit,
)
from option_backtesting.rotation.variants import underlying_of, variant_names

sys.path.insert(0, str(Path(__file__).parent))
from labels import opening_labels  # noqa: E402

OUT = Path(__file__).parent
P1 = (date(2025, 12, 3), date(2026, 10, 8))  # decides
P2 = (date(2025, 1, 10), date(2025, 8, 29))  # reported
K = 10.0
SHUFFLES = 20
SEED = 20261022
DD_LIMIT = 1.20  # the arm's drawdown may be at most 20% deeper than the comparator's
BROKERAGE_PER_TRADE = 20 * 1.18 * 2  # lot_plans' net: per strategy, x n_trades (reported only)

C = LISTS["C"]
W_C = dict(C.weights)  # recent 15 / weekday 30 / dte 30 / vix 20 / rfam 5
W_SL = {**W_C, "weekday": 0.10, "gap": 0.10, "prng": 0.10}
assert abs(sum(W_SL.values()) - 1) < 1e-9


@dataclass
class Data:
    days: list[date]
    cols: list[str]
    P: np.ndarray  # days x variants, the stored `net` (what the ranking reads)
    gross: np.ndarray
    trades: np.ndarray
    vix_open: list[float | None]
    #: per-day labels (days,) and per-index labels as days x variants
    labels: dict[str, np.ndarray]


def _read_cols(name: str, root: Path) -> dict[date, tuple[float, int]]:
    with store.result_path(name, root).open() as f:
        return {
            date.fromisoformat(r["day"]): (float(r["gross"]), int(r["n_trades"] or 0))
            for r in csv.DictReader(f)
        }


def load(root: Path, until: date | None = None) -> Data:
    names = variant_names()
    m = store.load_matrix(names, root)
    attrs = store.read_days(root, "weekdays")
    keep = [i for i, d in enumerate(m.days) if d in attrs and (until is None or d <= until)]
    days = [m.days[i] for i in keep]
    cols = list(m.names)
    extra = [_read_cols(n, root) for n in cols]
    gross = np.array([[e[d][0] for e in extra] for d in days])
    trades = np.array([[e[d][1] for e in extra] for d in days])
    a = [attrs[d] for d in days]
    nifty = np.array([underlying_of(n) == "NIFTY" for n in cols])
    opening = opening_labels(root)

    def per_index(nv: list[str], sv: list[str]) -> np.ndarray:
        return np.where(nifty[None, :], np.array(nv)[:, None], np.array(sv)[:, None])

    def op(sym: str, j: int) -> list[str]:
        return [opening[sym].get(d, ("unknown", "unknown"))[j] for d in days]

    labels = {
        "weekday": np.array([x["weekday"] for x in a]),
        "vix": np.array([x["vix_band"] for x in a]),
        "dte": per_index([x["dte_n"] for x in a], [x["dte_s"] for x in a]),
        "gap": per_index(op("NIFTY", 0), op("SENSEX", 0)),
        "prng": per_index(op("NIFTY", 1), op("SENSEX", 1)),
    }
    vix = [float(x["vix_open"]) if x.get("vix_open") not in (None, "") else None for x in a]
    return Data(days, cols, m.values[keep], gross, trades, vix, labels)


Fit = Callable[[np.ndarray, np.ndarray, int], np.ndarray]


def fit_skewed(P: np.ndarray, match: np.ndarray, i: int) -> np.ndarray:
    return skewed_fit(P, match, i, C.lookbacks)


def fit_shrunk(k: float, fam: np.ndarray | None = None) -> Fit:
    """Phase 0's fit: per window (cnt x label mean + k x target) / (cnt + k); target = the variant's
    mean over the whole window, or (fam given) its family's mean on the matching days. A window with
    no matching day is left out and the window weights renormalised, as `skewed_fit`."""

    def fit(P: np.ndarray, match: np.ndarray, i: int) -> np.ndarray:
        num = np.zeros(P.shape[1])
        den = np.zeros(P.shape[1])
        for n, w in C.lookbacks:
            lo = max(0, i - n)
            win, m = P[lo:i], match[lo:i]
            cnt = m.sum(axis=0)
            s = (win * m).sum(axis=0)
            if fam is None:
                target = win.mean(axis=0)
            else:
                f_s = np.bincount(fam, weights=s)
                f_c = np.bincount(fam, weights=cnt)
                target = (f_s / np.maximum(f_c, 1))[fam]
            val = target if np.isinf(k) else (s + k * target) / (cnt + k)
            num += w * val * (cnt > 0)
            den += w * (cnt > 0)
        return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)

    return fit


def arm_composite(
    P: np.ndarray, labels: dict[str, np.ndarray], i: int, weights: dict, fit: Fit, fam: np.ndarray
) -> np.ndarray:
    """`score.composite`'s shape for day i (reads P rows < i only), with any fit and criteria."""
    V = P.shape[1]
    crit = {"recent": recent_score(P, i)}
    for key in ("weekday", "dte", "vix", "gap", "prng"):
        if key not in weights:
            continue
        lab = labels[key]
        match = (lab == lab[i]) if lab.ndim == 2 else (lab[:, None] == lab[i]).repeat(V, axis=1)
        crit[key] = fit(P, match, i)
    crit["rfam"] = (np.bincount(fam, weights=crit["recent"]) / np.bincount(fam))[fam]
    return sum(weights[k] * pct_rank(crit[k]) for k in crit if k in weights)


@dataclass
class Run:
    picks: dict[date, list[str]]
    gross: dict[date, float]  # per lot-day
    net: dict[date, float]


def replay(data: Data, weights: dict, fit: Fit, perm: np.ndarray | None = None) -> Run:
    labels = data.labels if perm is None else {k: v[perm] for k, v in data.labels.items()}
    fam = family_index(data.cols)
    col = {n: j for j, n in enumerate(data.cols)}
    run = Run({}, {}, {})
    for i in range(WARMUP, len(data.days)):
        comp = arm_composite(data.P, labels, i, weights, fit, fam)
        p = select(comp, data.cols)
        chosen = [*p.core, *p.buy]
        js = [col[n] for n in chosen]
        d = data.days[i]
        run.picks[d] = chosen
        run.gross[d] = float(data.gross[i, js].mean())
        run.net[d] = float((data.gross[i, js] - BROKERAGE_PER_TRADE * data.trades[i, js]).mean())
    return run


def parity(data: Data, run: Run) -> int:
    """C0 must reproduce `pick.score_history`'s list C picks on every day, and its composite must
    equal `score.composite`'s. Returns the number of days checked; raises on a mismatch."""
    lab = data.labels
    fam = family_index(data.cols)
    for i in range(WARMUP, len(data.days)):
        d = data.days[i]
        hist = History(
            data.days[:i],
            data.cols,
            data.P[:i],
            list(lab["weekday"][:i]),
            list(lab["vix"][:i]),
            [x for x in lab["dte"][:i, _first(data.cols, "NIFTY")]],
            [x for x in lab["dte"][:i, _first(data.cols, "SENSEX")]],
            "",
        )
        dte = {
            "dte_n": lab["dte"][i, _first(data.cols, "NIFTY")],
            "dte_s": lab["dte"][i, _first(data.cols, "SENSEX")],
        }
        live = score_history(hist, d, data.vix_open[i], dte)["C"]
        if [*live["core"], *live["buy"]] != run.picks[d]:
            raise SystemExit(f"PARITY FAIL {d}: {live} vs {run.picks[d]}")
        Pv = np.vstack([data.P[:i], np.zeros((1, data.P.shape[1]))])
        ref = composite(
            Pv, lab["weekday"][: i + 1], lab["vix"][: i + 1], lab["dte"][: i + 1], data.cols, C, fam
        )
        mine = arm_composite(data.P, lab, i, W_C, fit_skewed, fam)
        if not np.allclose(ref, mine, atol=1e-12):
            raise SystemExit(f"PARITY FAIL {d}: composite differs")
    return len(data.days) - WARMUP


def _first(cols: list[str], sym: str) -> int:
    return next(j for j, n in enumerate(cols) if underlying_of(n) == sym)


def in_period(d: date, period: tuple[date, date] | None) -> bool:
    return period is None or period[0] <= d <= period[1]


def series(run: Run, period, net: bool = False) -> tuple[list[date], np.ndarray]:
    src = run.net if net else run.gross
    ds = [d for d in src if in_period(d, period)]
    return ds, np.array([src[d] for d in ds])


def summary(run: Run, period) -> dict:
    _, g = series(run, period)
    _, n = series(run, period, net=True)
    return {
        "days": int(g.size),
        "mean_per_lot_day": round(float(g.mean()), 2),
        "total_per_lot": round(float(g.sum()), 2),
        "max_drawdown_per_lot": round(max_drawdown(g), 2),
        "win_rate": round(float((g > 0).mean()), 4),
        "net_mean_per_lot_day": round(float(n.mean()), 2),
    }


def compare(arm: Run, base: Run, period) -> dict:
    _, a = series(arm, period)
    _, b = series(base, period)
    mean, lo, hi = block_bootstrap_mean(a - b, seed=SEED)
    differ = sum(arm.picks[d] != base.picks[d] for d in arm.picks if in_period(d, period))
    return {
        "mean": round(mean, 2),
        "lo90": round(lo, 2),
        "hi90": round(hi, 2),
        "days_with_different_picks": differ,
        "dd_arm": round(max_drawdown(a), 2),
        "dd_base": round(max_drawdown(b), 2),
    }


def verdict(arm: Run, base: Run, shuffles: list[Run]) -> dict:
    c = compare(arm, base, P1)
    true_total = summary(arm, P1)["total_per_lot"]
    shuf = [summary(s, P1)["total_per_lot"] for s in shuffles]
    cond = {
        "interval_above_zero": c["lo90"] > 0,
        "above_all_shuffles": true_total > max(shuf),
        # drawdowns are non-positive: "more than 20% deeper" is arm < base x 1.2
        "drawdown_ok": not (c["dd_arm"] < c["dd_base"] * DD_LIMIT),
    }
    return {
        **c,
        "true_total": true_total,
        "shuffles_beating_true": sum(s >= true_total for s in shuf),
        "shuffle_max": max(shuf),
        **cond,
        "pass": all(cond.values()),
    }


def main() -> None:
    root = data_dir()
    # `--until YYYY-MM-DD` replays only the days up to that one (the shuffles permute every day, so
    # a later day changes them): 2026-10-22 reproduces the registered run's span.
    until = date.fromisoformat(sys.argv[sys.argv.index("--until") + 1]) if "--until" in sys.argv else None
    data = load(root, until)
    print(f"{len(data.days)} days {data.days[0]} -> {data.days[-1]}, {len(data.cols)} variants")
    fam = family_index(data.cols)
    arms: dict[str, tuple[dict, Fit]] = {
        "C0": (W_C, fit_skewed),
        "S": (W_C, fit_shrunk(K)),
        "SL": (W_SL, fit_shrunk(K)),
        "M": (W_C, fit_shrunk(np.inf)),
        "S_k5": (W_C, fit_shrunk(5.0)),
        "S_k20": (W_C, fit_shrunk(20.0)),
        "S_family": (W_C, fit_shrunk(K, fam)),
    }
    runs = {name: replay(data, w, f) for name, (w, f) in arms.items()}
    checked = parity(data, runs["C0"])
    print(f"PARITY OK: C0 = score_history's list C on {checked} days")
    perms = [np.random.default_rng(s).permutation(len(data.days)) for s in range(SHUFFLES)]
    shuffled = {
        name: [replay(data, *arms[name], perm=p) for p in perms] for name in ("C0", "S", "SL")
    }
    periods = {"P1": P1, "P2": P2, "all": None}
    report: dict = {
        "phase0": "backlog/BL-154-adaptive-fit-shrinkage.md",
        "data_root": str(root),
        "days": [data.days[WARMUP].isoformat(), data.days[-1].isoformat()],
        "variants": len(data.cols),
        "k": K,
        "boot": {"resamples": 2000, "block": 5, "seed": SEED, "level": 0.9},
        "parity_days": checked,
        "arms": {n: {p: summary(r, per) for p, per in periods.items()} for n, r in runs.items()},
        "vs": {},
        "shuffles": {
            n: {
                p: sorted(summary(s, per)["total_per_lot"] for s in ss)
                for p, per in periods.items()
            }
            for n, ss in shuffled.items()
        },
    }
    pairs = [
        ("S", "C0"),
        ("SL", "S"),
        ("SL", "C0"),
        ("M", "C0"),
        ("S_k5", "C0"),
        ("S_k20", "C0"),
        ("S_family", "C0"),
        ("S", "M"),
    ]
    for a, b in pairs:
        report["vs"][f"{a}-{b}"] = {p: compare(runs[a], runs[b], per) for p, per in periods.items()}
    report["decision"] = {
        "H1_shrinkage_S_vs_C0": verdict(runs["S"], runs["C0"], shuffled["S"]),
        "H2_labels_SL_vs_S": verdict(runs["SL"], runs["S"], shuffled["SL"]),
        "C0_true_vs_its_shuffles_P1": {
            "true_total": summary(runs["C0"], P1)["total_per_lot"],
            "shuffles_beating_true": sum(
                summary(s, P1)["total_per_lot"] >= summary(runs["C0"], P1)["total_per_lot"]
                for s in shuffled["C0"]
            ),
        },
    }
    stamp = data.days[-1].isoformat()
    (OUT / f"replay_{stamp}.json").write_text(json.dumps(report, indent=1) + "\n")
    with (OUT / f"replay_daily_{stamp}.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["day", *[f"{n}_gross" for n in runs], "picks_C0", "picks_S", "picks_SL"])
        for d in runs["C0"].gross:
            w.writerow(
                [
                    d.isoformat(),
                    *[round(r.gross[d], 2) for r in runs.values()],
                    " ".join(runs["C0"].picks[d]),
                    " ".join(runs["S"].picks[d]),
                    " ".join(runs["SL"].picks[d]),
                ]
            )
    print(json.dumps(report["decision"], indent=1))


if __name__ == "__main__":
    main()
