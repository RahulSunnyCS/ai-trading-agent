"""BL-212: Dir x2 only when the Dir pick's own score is high: a causal gate on T1's fourth lot.

T1's list C on its normal days with a Dir pick (BL-207's replay: picks re-derived as live, the
expiring-index filter and the SL150 % cap), three kinds of book under the book stop: x1 (2 Widesl
+ 1 Dir, stop 9k), x2 (2 Widesl + 2 Dir, stop 9k + the Dir's MTM SL: what runs today) and
gate(p, q) = x2 on a day predictor p is at or above its trailing q-quantile, x1 otherwise. Ten gate
arms as registered in backlog/BL-212 Phase 0 (conf / rank / dirwin at 50 / 67 / 75 %, and VIX <= 15);
the primary arm is conf @ 50 %. Every predictor reads only days before D. Judged on how much of x2's
extra net over x1 an arm keeps and how much of x2's extra drawdown and worst day it takes on.
Reads the live store, writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl212/dir_gate.py
"""

from __future__ import annotations

import csv
import json
import sys
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import daylog, expiry, live_lots, pick, portfolio, sl150_cap, store
from option_backtesting.rotation.lists import LISTS
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import dte_matrix, pct_rank
from option_backtesting.rotation.variants import is_wide, track_names, variant_names

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from pick_confidence import basket_confidence  # noqa: E402

LIST_KEY = "C"
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261105, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
FIRST = date(2025, 1, 10)
LAST = date.today()
SPLIT = date(2025, 10, 8)  # BL-202 / BL-207's fit / test boundary (fit <= SPLIT)
LAST_YEAR_FROM = date(2025, 11, 5)
STAMP = LAST.isoformat()
SLIP = 0.5
TRAIL_DAYS = 250  # the trailing window the quantile is taken over
MIN_TRAIL = 63  # fewer earlier values than this: the gate is on (x2)
QUANTILES = {"50": 0.50, "67": 0.67, "75": 0.75}
SCORED = ("conf", "rank", "dirwin")
VIX_CAP = 15.0
PRIMARY = "conf@50"
KEEP_MIN, TAKE_MAX = 0.5, 0.5  # Phase 0's pass rule
WINDOWS = {
    "all": (FIRST, LAST),
    "last_year": (LAST_YEAR_FROM, LAST),
    "fit_half": (FIRST, SPLIT),
    "test_half": (date(2025, 10, 9), LAST),
}


def arm_names() -> list[str]:
    return [f"{p}@{q}" for p in SCORED for q in QUANTILES] + ["vix"]


# ---------------------------------------------------------------------------------------------
# Stored figures the books need (as BL-207)
# ---------------------------------------------------------------------------------------------
def read_trades(name: str, root: Path) -> dict[date, int]:
    out = {}
    with store.result_path(name, root).open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                out[date.fromisoformat(r["day"])] = (
                    int(float(r["n_trades"])) if r.get("n_trades") not in (None, "") else 0
                )
            except (KeyError, ValueError):
                continue
    return out


_mtmsl: dict[str, float] = {}


def mtmsl(name: str) -> float:
    if name not in _mtmsl:
        v = load_legwise(portfolio.strategy_file(name)).overall.stop_loss_inr
        _mtmsl[name] = float(v) if v is not None else NO_MTMSL_ADD
    return _mtmsl[name]


def interval(x: np.ndarray) -> dict:
    x = np.asarray(x, dtype=float)
    if len(x) < BLOCK:
        return {
            "mean": float(x.mean()) if len(x) else None,
            "ci90": None,
            "reading": "too few days",
        }
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


# ---------------------------------------------------------------------------------------------
# The predictors of one day, from rows strictly before it
# ---------------------------------------------------------------------------------------------
def predictors(
    rec, i: int, cols: list[str], comp: np.ndarray, dir_pick: str, a: dict, labels
) -> dict:
    j = cols.index(dir_pick)
    weekday = np.array([*rec.weekday[:i], a["weekday"]])
    band = np.array([*rec.band[:i], a["vix_band"]])
    dmat = dte_matrix(
        np.array([*rec.dte_n[:i], labels[0]]), np.array([*rec.dte_s[:i], labels[1]]), cols
    )
    conf = basket_confidence(rec.values, [j], i, weekday, band, dmat, LISTS[LIST_KEY])
    last21 = rec.values[max(0, i - 21) : i, j]
    vix = daylog._number(a.get("vix_open"))
    return {
        "conf": conf["confidence"],
        "rank": float(pct_rank(comp)[j]),
        "dirwin": float((last21 > 0).mean()) if len(last21) else float("nan"),
        "vix_open": vix,
        "vix": bool(vix is not None and not np.isnan(vix) and vix <= VIX_CAP),
        "conf_detail": conf.get("criteria"),
    }


class Trailing:
    """The trailing quantile gates: on when today's value is at or above the quantile of the last
    TRAIL_DAYS values (days with a Dir pick), on while fewer than MIN_TRAIL values exist."""

    def __init__(self) -> None:
        self.seen: dict[str, list[float]] = {p: [] for p in SCORED}

    def decide(self, values: dict) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for p in SCORED:
            prev = [v for v in self.seen[p][-TRAIL_DAYS:] if not np.isnan(v)]
            v = values[p]
            for qname, q in QUANTILES.items():
                if len(prev) < MIN_TRAIL or np.isnan(v):
                    out[f"{p}@{qname}"] = {"on": True, "threshold": None}
                else:
                    thr = float(np.quantile(prev, q))
                    out[f"{p}@{qname}"] = {"on": bool(v >= thr), "threshold": round(thr, 3)}
        out["vix"] = {"on": values["vix"], "threshold": VIX_CAP}
        return out

    def record(self, values: dict) -> None:
        for p in SCORED:
            self.seen[p].append(float(values[p]))


# ---------------------------------------------------------------------------------------------
def run(root: Path) -> tuple[dict[str, dict], dict]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, [*variant_names(), *track_names("t1")])
    assert rec.error is None, rec.error
    trades: dict[str, dict[date, int]] = {}
    slipped: dict[str, dict[date, float]] = {}
    rows: dict[str, dict] = {}
    counts = {"expiry": 0, "other": 0, "three_widesl": 0, "normal_with_dir": 0, "gate_warmup": 0}
    skipped: list[str] = []
    trailing = Trailing()
    lookahead_checks: list[bool] = []

    def n_trades(m: str, d: date) -> int | None:
        if m not in trades:
            trades[m] = read_trades(m, root)
        return trades[m].get(d)

    def slip_net(m: str, d: date) -> float | None:
        if m not in slipped:
            with store.slipped(SLIP):
                slipped[m] = store.read_net(m, root)
        return slipped[m].get(d)

    for d in rec.days_available():
        if d < FIRST or d > LAST:
            continue
        a = rec.attrs[d]
        labels = (str(a["dte_n"]), str(a["dte_s"]))
        dte = {"NIFTY": labels[0], "SENSEX": labels[1]}
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        vix = daylog._number(a.get("vix_open"))
        for key, cols, comp, picks in pick._rank(
            hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        ):
            if key != LIST_KEY:
                continue
            idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(labels[0]) and labels[0] != "0":
                picks = sl150_cap.cap_picks(comp, cols, picks)
            core = list(picks.core)
            if idx:
                counts["expiry"] += 1
                continue
            if live_lots.summary(core, dte) == "expiry day":
                counts["other"] += 1
                continue
            dir_pick = live_lots.dir_pick(core)
            if dir_pick is None:
                counts["three_widesl"] += 1
                continue
            counts["normal_with_dir"] += 1
            values = predictors(rec, i, cols, comp, dir_pick, a, labels)
            gates = trailing.decide(values)
            trailing.record(values)
            if gates[PRIMARY]["threshold"] is None:
                counts["gate_warmup"] += 1
            # look-ahead spot check: the predictors do not change when rows from D on are blanked
            if len(lookahead_checks) < 20 and i % 23 == 0:
                blank = rec.values.copy()
                blank[i:] = np.nan
                again = basket_confidence(
                    blank, [cols.index(dir_pick)], i,
                    np.array([*rec.weekday[:i], a["weekday"]]), np.array([*rec.band[:i], a["vix_band"]]),
                    dte_matrix(np.array([*rec.dte_n[:i], labels[0]]), np.array([*rec.dte_s[:i], labels[1]]), cols),
                    LISTS[LIST_KEY],
                )  # fmt: skip
                lookahead_checks.append(again["confidence"] == values["conf"])
            try:
                loaded: dict = {}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in core}
                ntr = {m: n_trades(m, d) for m in core}
                sn = {m: slip_net(m, d) for m in core}
                bad = [m for m in core if ntr[m] is None or sn[m] is None]
                if bad:
                    raise portfolio.PortfolioStopError(f"a stored result is missing: {bad}")
            except (portfolio.PortfolioStopError, FileNotFoundError) as e:
                skipped.append(f"{d}: {e}")
                continue

            def book(members: dict[str, int], stop: float, paths=paths, ntr=ntr, sn=sn) -> dict:
                bd = portfolio.apply_book(
                    [portfolio.Member(m, lots, paths[m]) for m, lots in members.items()], stop
                )
                brokerage = sum(2 * ntr[m] * lots * BROKERAGE for m, lots in members.items())
                return {
                    "gross": bd.gross_with,
                    "stop": stop,
                    "stop_hit": bd.stop_minute is not None,
                    "net": bd.gross_with - brokerage,
                    "lots": sum(members.values()),
                    "net_slip": sum(lots * sn[m] for m, lots in members.items()) - brokerage,
                }

            x1 = book({m: 1 for m in core}, BASE_STOP)
            x2 = book({**{m: 1 for m in core}, dir_pick: 2}, BASE_STOP + mtmsl(dir_pick))
            rows[d.isoformat()] = {
                "day": d.isoformat(),
                "core": core,
                "D": dir_pick,
                "W": sorted(n for n in core if is_wide(n)),
                "predictors": {k: values[k] for k in ("conf", "rank", "dirwin", "vix_open", "vix")},
                "gates": gates,
                "x1": x1,
                "x2": x2,
            }
    assert lookahead_checks and all(lookahead_checks), "a predictor read the day's own rows"
    return rows, {"counts": counts, "skipped": skipped, "lookahead_checks": len(lookahead_checks)}


# ---------------------------------------------------------------------------------------------
def series(rows: list[dict], arm: str, field: str) -> tuple[np.ndarray, np.ndarray]:
    if arm in ("x1", "x2"):
        net = np.array([r[arm][field] for r in rows])
        hits = np.array([r[arm]["stop_hit"] for r in rows])
    else:
        net = np.array([(r["x2"] if r["gates"][arm]["on"] else r["x1"])[field] for r in rows])
        hits = np.array([(r["x2"] if r["gates"][arm]["on"] else r["x1"])["stop_hit"] for r in rows])
    return net, hits


def metrics(net: np.ndarray, hits: np.ndarray) -> dict:
    week = np.convolve(net, np.ones(5), "valid") if len(net) >= 5 else net
    return {
        "days": int(len(net)),
        "per_day": float(net.mean()),
        "total": float(net.sum()),
        "max_drawdown": max_drawdown(net),
        "worst_day": float(net.min()),
        "worst_week": float(week.min()),
        "loss_day_share": float((net < 0).mean()),
        "book_stop_days": int(hits.sum()),
    }


def share(part: float, whole: float) -> float | None:
    return float(part / whole) if whole else None


def summarise_window(sub: list[dict], field: str) -> dict:
    out: dict = {}
    x1, h1 = series(sub, "x1", field)
    x2, h2 = series(sub, "x2", field)
    m1, m2 = metrics(x1, h1), metrics(x2, h2)
    out["x1"], out["x2"] = m1, m2
    m2["vs_x1"] = interval(x2 - x1)
    extra_net = (x2 - x1).mean()
    extra_dd = (
        m2["max_drawdown"] - m1["max_drawdown"]
    )  # drawdowns are non-positive: more negative = deeper
    extra_worst = m2["worst_day"] - m1["worst_day"]
    extra_week = m2["worst_week"] - m1["worst_week"]
    for arm in arm_names():
        net, hits = series(sub, arm, field)
        m = metrics(net, hits)
        on = np.array([r["gates"][arm]["on"] for r in sub])
        m["days_on"] = int(on.sum())
        m["share_on"] = float(on.mean()) if len(on) else None
        m["vs_x1"] = interval(net - x1)
        m["vs_x2"] = interval(net - x2)
        m["extra_net_kept"] = share((net - x1).mean(), extra_net)
        m["extra_drawdown_taken"] = share(m["max_drawdown"] - m1["max_drawdown"], extra_dd)
        m["extra_worst_day_taken"] = share(m["worst_day"] - m1["worst_day"], extra_worst)
        m["extra_worst_week_taken"] = share(m["worst_week"] - m1["worst_week"], extra_week)
        # the Dir's x2 days that were off: did the gate skip the bad ones? (x2 - x1 on off days)
        off = ~on
        m["x2_minus_x1_on_off_days"] = float((x2 - x1)[off].sum()) if off.any() else 0.0
        m["x2_minus_x1_on_on_days"] = float((x2 - x1)[on].sum()) if on.any() else 0.0
        out[arm] = m
    return out


def verdict(all_w: dict, test_w: dict) -> dict:
    m = all_w[PRIMARY]
    t = test_w[PRIMARY]
    kept, dd, worst = m["extra_net_kept"], m["extra_drawdown_taken"], m["extra_worst_day_taken"]
    ci = m["vs_x1"].get("ci90")
    checks = {
        "kept_at_least_half": kept is not None and kept >= KEEP_MIN,
        "vs_x1_above_zero": bool(ci and ci[0] > 0),
        "drawdown_taken_at_most_half": dd is not None and dd <= TAKE_MAX,
        "worst_day_taken_at_most_half": worst is not None and worst <= TAKE_MAX,
        "test_half_same_signs": bool(
            t["extra_net_kept"] is not None
            and t["extra_net_kept"] > 0
            and t["extra_drawdown_taken"] is not None
            and t["extra_drawdown_taken"] < 1
        ),
    }
    return {"arm": PRIMARY, "checks": checks, "result": "pass" if all(checks.values()) else "kill"}


def summarise(rows: dict[str, dict]) -> dict:
    out: dict = {}
    for field in ("net", "net_slip"):
        per_window = {}
        for wname, (lo, hi) in WINDOWS.items():
            sub = [r for k, r in sorted(rows.items()) if lo.isoformat() <= k <= hi.isoformat()]
            per_window[wname] = {
                "from": sub[0]["day"] if sub else None,
                "to": sub[-1]["day"] if sub else None,
                "days": len(sub),
                "arms": summarise_window(sub, field) if sub else {},
            }
        out[field] = {
            "windows": per_window,
            "verdict": verdict(per_window["all"]["arms"], per_window["test_half"]["arms"]),
        }
    return out


def fmt_share(x: float | None) -> str:
    return "   n/a" if x is None else f"{x:+6.2f}"


def fmt_iv(v: dict | None) -> str:
    if not v or v.get("ci90") is None:
        return "" if not v or v.get("mean") is None else f"{v['mean']:+.0f} [n/a]"
    return f"{v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}]"


def main() -> None:
    root = data_dir()
    rows, info = run(root)
    report = {
        "summary": summarise(rows),
        **info,
        "primary": PRIMARY,
        "note": (
            "T1 list C, expiry rule + SL150 cap as live; normal days with a Dir pick only; x1 = 3 lots stop 9k, "
            "x2 = Dir doubled, stop 9k + the Dir's MTM SL; gate = x2 when the predictor is at or above its trailing "
            f"{TRAIL_DAYS}-day quantile (on while under {MIN_TRAIL} values); net = gross under the stop at 0% "
            "slippage - brokerage; net_slip = 0.5%-slippage stored nets x lots - brokerage, no stop. "
            "extra_*_taken: (arm - x1) / (x2 - x1) of that figure; drawdowns negative."
        ),
    }
    (HERE / f"dir_gate_{STAMP}.json").write_text(json.dumps(report, indent=1) + "\n")
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / f"rows_{STAMP}.json").write_text(json.dumps(rows) + "\n")
    print(
        f"{len(rows)} days kept; counts {info['counts']}; look-ahead checks {info['lookahead_checks']} ok"
    )
    for s in info["skipped"][:10]:
        print("  skipped", s)
    for field, block in report["summary"].items():
        print(
            f"\n#### {field} ({'book stop, 0% slippage' if field == 'net' else 'no stop, 0.5% slippage'})"
        )
        for wname, w in block["windows"].items():
            print(f"== {wname} {w['from']}..{w['to']} {w['days']}d")
            print(
                f"  {'arm':9} {'on':>5} {'/day':>7} {'total':>9} {'DD':>8} {'worst':>8} {'week':>8} stops  kept  DDtk  WDtk | vs x1"
            )
            for arm, x in w["arms"].items():
                print(
                    f"  {arm:9} {x.get('share_on', 1.0):5.0%} {x['per_day']:+7.0f} {x['total']:+9,.0f} {x['max_drawdown']:8,.0f} "
                    f"{x['worst_day']:8,.0f} {x['worst_week']:8,.0f} {x['book_stop_days']:5} "
                    f"{fmt_share(x.get('extra_net_kept'))} {fmt_share(x.get('extra_drawdown_taken'))} "
                    f"{fmt_share(x.get('extra_worst_day_taken'))} | {fmt_iv(x.get('vs_x1'))}"
                )
        print("  verdict:", json.dumps(block["verdict"]))


if __name__ == "__main__":
    main()
