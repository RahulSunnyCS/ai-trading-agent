"""BL-207: the doubled Dir's second lot taken later. On T1's non-expiry days with a Dir pick, the
live Dir x2 (N4) against the same Dir 30 / 60 minutes on, the best-ranked Dir at least 30 / 60
minutes later, the best-ranked other Dir at any slot (the control), and the even spread, under the
book stop (9k + the extra lot's own MTM SL), as registered in backlog/BL-207 Phase 0 (descriptive,
in-sample). The book, the replay and the money are BL-204's (`research/bl204/lot_ladder.py`); the
second reading uses the store's 0.5 % slippage copies without the book stop. Reads the live store,
writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl207/dir_spacing.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import daylog, expiry, live_lots, pick, portfolio, sl150_cap, store
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.variants import (
    is_buy,
    is_dir,
    is_wide,
    parts,
    track_names,
    variant_names,
)

HERE = Path(__file__).parent
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261104, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
FIRST = date(2025, 1, 10)
LAST = date(2026, 11, 3)
SPLIT = date(2025, 10, 8)  # BL-202's fit / test boundary (fit <= SPLIT)
LAST_YEAR_FROM = date(2025, 11, 3)
STAMP = "2026-11-06"
SLIP = 0.5
BASE = "N4"
EVEN = "B4"
#: arm -> (gap in minutes, same setting?); the control has no gap
ARMS: dict[str, tuple[int | str | None, bool]] = {
    "same+30": (30, True),
    "same+60": (60, True),
    "rank+30": (30, False),
    "rank+60": (60, False),
    "rank-any": (None, False),
    # amendment 2026-11-06: the best-ranked other Dir whose slot differs from D's (earlier or later)
    "rank-diff": ("diff", False),
}
WINDOWS = {
    "all": (FIRST, LAST),
    "last_year": (LAST_YEAR_FROM, LAST),
    "fit_half": (FIRST, SPLIT),
    "test_half": (date(2025, 10, 9), LAST),
}


def minutes(tag: str) -> int:
    return int(tag[:2]) * 60 + int(tag[2:])


def second_dir(
    comp: np.ndarray, cols: list[str], core: list[str], d: str, gap: int | str | None, same: bool
) -> str | None:
    """Phase 0's second lot for the day: the same setting `gap` minutes on, or the best-ranked
    unpicked Dir whose slot is at least `gap` minutes after D's (any slot when gap is None, any
    slot but D's own when gap is "diff")."""
    score = {n: float(comp[j]) for j, n in enumerate(cols)}
    idx, fam, tag = parts(d)
    t0 = minutes(tag)
    chosen = set(core)
    if same:
        want = t0 + (gap or 0)
        for n in cols:
            i2, f2, t2 = parts(n)
            if n not in chosen and (i2, f2) == (idx, fam) and minutes(t2) == want:
                return n
        return None
    def slot_ok(n: str) -> bool:
        if gap is None:
            return True
        if gap == "diff":
            return minutes(parts(n)[2]) != t0
        return minutes(parts(n)[2]) >= t0 + gap

    cands = [n for n in cols if n not in chosen and is_dir(n) and not is_buy(n) and slot_ok(n)]
    return min(cands, key=lambda n: (-score[n], n)) if cands else None


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
    return {"mean": m, "ci90": [lo, hi],
            "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero"}  # fmt: skip


def run(root: Path) -> tuple[dict[str, dict], dict]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, [*variant_names(), *track_names("t1")])
    assert rec.error is None, rec.error
    trades: dict[str, dict[date, int]] = {}
    slipped: dict[str, dict[date, float]] = {}
    rows: dict[str, dict] = {}
    counts = {"expiry": 0, "other": 0, "three_widesl": 0, "normal_with_dir": 0}
    skipped: list[str] = []
    missing: dict[str, int] = {a: 0 for a in ARMS}

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
            if key != "C":
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
            wides = sorted(
                (n for n in core if is_wide(n)), key=lambda n: (-float(comp[cols.index(n)]), n)
            )
            seconds: dict[str, str | None] = {
                arm: second_dir(comp, cols, core, dir_pick, gap, same)
                for arm, (gap, same) in ARMS.items()
            }
            for arm, s in seconds.items():
                if s is None:
                    missing[arm] += 1
            need = set(core) | {s for s in seconds.values() if s}
            try:
                loaded: dict = {}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in need}
                ntr = {m: n_trades(m, d) for m in need}
                sn = {m: slip_net(m, d) for m in need}
                bad = [m for m in need if ntr[m] is None or sn[m] is None]
                if bad:
                    raise portfolio.PortfolioStopError(f"a stored result is missing: {bad}")
            except (portfolio.PortfolioStopError, FileNotFoundError) as e:
                skipped.append(f"{d}: {e}")
                continue
            row = {"day": d.isoformat(), "core": core, "D": dir_pick, "W": wides,
                   "seconds": seconds, "arms": {}}  # fmt: skip

            def book(
                members: dict[str, int],
                stop: float,
                scale: float = 1.0,
                paths=paths,
                ntr=ntr,
                sn=sn,
            ) -> dict:
                # an even spread: the 3-lot book under 9k, then x 4/3 (stop 12k on the scaled path)
                bd = portfolio.apply_book(
                    [portfolio.Member(m, lots, paths[m]) for m, lots in members.items()],
                    stop / scale,
                )
                brokerage = sum(2 * ntr[m] * BROKERAGE for m in members)
                return {
                    "members": {m: lots * scale for m, lots in members.items()},
                    "gross": bd.gross_with * scale,
                    "gross_nostop": bd.gross_without * scale,
                    "stop": stop,
                    "stop_hit": bd.stop_minute is not None,
                    "brokerage": brokerage,
                    "net": bd.gross_with * scale - brokerage,
                    "lots": sum(members.values()) * scale,
                    # the second reading: no book stop, 0.5 % slippage on every fill
                    "net_slip": sum(lots * sn[m] for m, lots in members.items()) * scale
                    - brokerage,
                }

            base_members = {m: 1 for m in core}
            base_members[dir_pick] = 2
            row["arms"][BASE] = book(base_members, BASE_STOP + mtmsl(dir_pick))
            for arm, s in seconds.items():
                if s is None:
                    continue
                members = {m: 1 for m in core}
                members[s] = 1
                row["arms"][arm] = book(members, BASE_STOP + mtmsl(s))
            row["arms"][EVEN] = book({m: 1 for m in core}, BASE_STOP * 4 / 3, 4 / 3)
            rows[d.isoformat()] = row
    return rows, {"counts": counts, "skipped": skipped, "missing_second_lot": missing}


def metrics(net: np.ndarray, hits: np.ndarray, lots: float = 4.0) -> dict:
    week = np.convolve(net, np.ones(5), "valid") if len(net) >= 5 else net
    mdd = max_drawdown(net)
    return {
        "days": int(len(net)),
        "per_day": float(net.mean()),
        "per_lot_day": float(net.mean() / lots),
        "total": float(net.sum()),
        "max_drawdown": mdd,
        "worst_day": float(net.min()),
        "worst_week": float(week.min()),
        "loss_day_share": float((net < 0).mean()),
        "book_stop_days": int(hits.sum()),
    }


def summarise_window(sub: list[dict], field: str) -> dict:
    """Every arm over the days it exists on, paired with N4 and B4 on those same days."""
    out: dict = {}
    for arm in (BASE, EVEN, *ARMS):
        days = [r for r in sub if arm in r["arms"]]
        if not days:
            out[arm] = None
            continue
        net = np.array([r["arms"][arm][field] for r in days])
        hits = np.array([r["arms"][arm]["stop_hit"] for r in days])
        m = metrics(net, hits)
        if arm != BASE:
            base = np.array([r["arms"][BASE][field] for r in days])
            diff = net - base
            m["vs_N4"] = interval(diff)
            m["N4_on_same_days"] = metrics(
                base, np.array([r["arms"][BASE]["stop_hit"] for r in days])
            )
            m["days_beating_N4"] = float((diff > 0).mean())
            order = np.argsort(diff)[::-1]
            for k in (5, 10):
                rest = np.delete(diff, order[:k])
                m[f"vs_N4_without_top_{k}"] = {
                    **interval(rest),
                    "share_of_excess": (
                        float(diff[order[:k]].sum() / diff.sum()) if diff.sum() else None
                    ),
                }
        if arm != EVEN:
            even = np.array([r["arms"][EVEN][field] for r in days])
            m["vs_B4"] = interval(net - even)
        out[arm] = m
    return out


def reading(w: dict, halves: tuple[dict, dict], last_year: dict, arm: str) -> str:
    """Phase 0's verdict for one arm from the primary reading."""
    m = w.get(arm)
    if not m or not m["vs_N4"].get("ci90"):
        return "no evidence"
    base = m["N4_on_same_days"]
    lo = m["vs_N4"]["ci90"][0]
    means_up = all(
        x.get(arm) and x[arm]["vs_N4"]["mean"] is not None and x[arm]["vs_N4"]["mean"] > 0
        for x in (*halves, last_year)
    )
    if lo > 0 and means_up and m["max_drawdown"] >= base["max_drawdown"]:
        return "beats live"
    if (
        m["vs_N4"]["reading"] == "includes zero"
        and abs(m["max_drawdown"]) <= 0.8 * abs(base["max_drawdown"])
        and abs(m["worst_day"]) <= 0.8 * abs(base["worst_day"])
    ):
        return "matches live with less risk"
    return "no evidence"


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
                "arms": summarise_window(sub, field),
            }
        verdicts = {
            arm: reading(
                per_window["all"]["arms"],
                (per_window["fit_half"]["arms"], per_window["test_half"]["arms"]),
                per_window["last_year"]["arms"],
                arm,
            )
            for arm in ARMS
        }
        out[field] = {"windows": per_window, "verdict": verdicts}
    return out


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
        "second_lot_names": _second_lot_counts(rows),
        "note": (
            "T1 list C, expiry rule + SL150 cap as live; normal days with a Dir pick only; 4 lots an arm; "
            "book stop 9k + the extra lot's MTM SL; net = gross under the stop at 0% slippage - brokerage; "
            "net_slip = sum of the 0.5%-slippage stored nets x lots - brokerage, no book stop"
        ),
    }
    (HERE / f"dir_spacing_{STAMP}.json").write_text(json.dumps(report, indent=1) + "\n")
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / f"rows_{STAMP}.json").write_text(json.dumps(rows) + "\n")
    print(
        f"{len(rows)} days kept; counts {info['counts']}; missing second lot {info['missing_second_lot']}"
    )
    for s in info["skipped"][:20]:
        print("  skipped", s)
    for field, block in report["summary"].items():
        print(
            f"\n#### {field} ({'book stop, 0% slippage' if field == 'net' else 'no stop, 0.5% slippage'})"
        )
        for wname, w in block["windows"].items():
            print(f"== {wname} {w['from']}..{w['to']} {w['days']}d")
            for arm, x in w["arms"].items():
                if not x:
                    continue
                print(
                    f"  {arm:9} n {x['days']:3} {x['per_day']:+7.0f}/d DD {x['max_drawdown']:>8,.0f} "
                    f"worst {x['worst_day']:>8,.0f} wk {x['worst_week']:>8,.0f} loss {x['loss_day_share']:.0%} "
                    f"stops {x['book_stop_days']:3} | vs N4 {fmt_iv(x.get('vs_N4')):>24} "
                    f"win {x.get('days_beating_N4', float('nan')):.0%} | vs B4 {fmt_iv(x.get('vs_B4')):>24}"
                )
        print("  verdicts:", block["verdict"])
    print(
        "\nsecond-lot names (all days):", json.dumps(report["second_lot_names"], indent=None)[:1500]
    )


def _second_lot_counts(rows: dict[str, dict]) -> dict:
    out: dict = {}
    for arm in ARMS:
        c: dict[str, int] = {}
        for r in rows.values():
            s = r["seconds"].get(arm)
            if s:
                c[s] = c.get(s, 0) + 1
        out[arm] = dict(sorted(c.items(), key=lambda kv: -kv[1])[:8])
    d: dict[str, int] = {}
    for r in rows.values():
        d[r["D"]] = d.get(r["D"], 0) + 1
    out["D"] = dict(sorted(d.items(), key=lambda kv: -kv[1])[:8])
    return out


if __name__ == "__main__":
    main()
