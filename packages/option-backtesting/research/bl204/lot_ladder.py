"""BL-204: T1's fifth and sixth lot on normal days and a fourth (and fifth) on one-index expiry
days, against the lots live today (N4 = Dir x2; E3 = the expiring index's picks) and an even
spread, under the book stop (9k + each extra lot's own MTM SL). As registered in backlog/BL-204
Phase 0 (descriptive, in-sample). Reads the live store, replays one-lot paths through
`rotation/portfolio.py` (its disk cache); writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl204/lot_ladder.py
"""

from __future__ import annotations

import csv
import json
from bisect import bisect_left
from collections import defaultdict
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
    track_names,
    underlying_of,
    variant_names,
)

HERE = Path(__file__).parent
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261103, 0.90
BROKERAGE = 20.0 * 1.18
BASE_STOP = 9000.0
NO_MTMSL_ADD = 4000.0
FIRST = date(2025, 1, 10)
LAST = date(2026, 10, 30)
LAST_YEAR_FROM = date(2025, 11, 3)
STAMP = "2026-11-03"

# an arm = the extra lots on top of the three 1-lot base picks, by role
NORMAL_ARMS: dict[str, tuple[str, ...]] = {
    "N4": ("D",),
    "N5-D3": ("D", "D"),
    "N5-W1": ("D", "W1"),
    "N5-W2": ("D", "W2"),
    "N5+D": ("D", "D+"),
    "N5+W": ("D", "W+"),
    "N5+R": ("D", "R+"),
    "N6-all2": ("D", "W1", "W2"),
    "N6-D3W1": ("D", "D", "W1"),
    "N6-D4": ("D", "D", "D"),
    "N6+D+W": ("D", "D+", "W+"),
    "N6+D2": ("D", "D+", "D+"),
    "N6-D3+D": ("D", "D", "D+"),
    "N6-W1+D": ("D", "W1", "D+"),
}
EXPIRY_ARMS: dict[str, tuple[str, ...]] = {
    "E3": (),
    "E4-D2": ("D",),
    "E4-W1": ("W1",),
    "E4+D": ("D+",),
    "E4+W": ("W+",),
    "E4+O": ("O+",),
    "E5-D2W1": ("D", "W1"),
    "E5-D3": ("D", "D"),
    "E5+D": ("D", "D+"),
    "E5+O": ("D", "O+"),
}
NORMAL_BASE, EXPIRY_BASE = "N4", "E3"
GROUPS = {  # lot count -> (arms, even-spread lots)
    "normal": {5: [a for a in NORMAL_ARMS if a.startswith("N5")], 6: [a for a in NORMAL_ARMS if a.startswith("N6")]},
    "expiry": {4: [a for a in EXPIRY_ARMS if a.startswith("E4")], 5: [a for a in EXPIRY_ARMS if a.startswith("E5")]},
}  # fmt: skip


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
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {"mean": m, "ci90": [lo, hi],
            "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero"}  # fmt: skip


def open_span(path: tuple[float, ...]) -> tuple[int, int] | None:
    moves = [i for i in range(len(path)) if path[i] != (path[i - 1] if i else 0.0)]
    return (moves[0], moves[-1]) if moves else None


def roles(
    comp: np.ndarray, cols: list[str], core: list[str], index: str | None
) -> dict[str, str | None]:
    """D, W1, W2, D+, W+, R+, O+ for the day (Phase 0's definitions)."""
    score = {n: float(comp[j]) for j, n in enumerate(cols)}
    order = sorted((n for n in cols if not is_buy(n)), key=lambda n: (-score[n], n))
    keep = [n for n in order if index is None or underlying_of(n) == index]
    chosen = set(core)
    wide_core = sorted((n for n in core if is_wide(n)), key=lambda n: (-score[n], n))
    core_dir = next((n for n in core if is_dir(n)), None)
    unpicked_dirs = [n for n in keep if is_dir(n) and n not in chosen]
    unpicked_wides = [n for n in keep if is_wide(n) and n not in chosen]
    d = core_dir or (unpicked_dirs[0] if unpicked_dirs else None)
    d_plus = next((n for n in unpicked_dirs if n != d), None)
    w_plus = unpicked_wides[0] if unpicked_wides else None
    r_plus = None
    if d_plus and w_plus:
        r_plus = max((d_plus, w_plus), key=lambda n: (score[n], n))
    else:
        r_plus = d_plus or w_plus
    o_plus = None
    if index:
        other = [n for n in order if underlying_of(n) != index]
        o_plus = other[0] if other else None
    return {
        "D": d,
        "W1": wide_core[0] if wide_core else None,
        "W2": wide_core[1] if len(wide_core) > 1 else None,
        "D+": d_plus,
        "W+": w_plus,
        "R+": r_plus,
        "O+": o_plus,
    }


def run(root: Path) -> tuple[dict[str, dict], list[str]]:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, [*variant_names(), *track_names("t1")])
    assert rec.error is None, rec.error
    trades: dict[str, dict[date, int]] = {}
    rows: dict[str, dict] = {}
    skipped: list[str] = []

    def n_trades(m: str, d: date) -> int | None:
        if m not in trades:
            trades[m] = read_trades(m, root)
        return trades[m].get(d)

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
                kind = "expiry"
            elif live_lots.summary(core, dte) == "expiry day":
                kind = "other"  # both expire, or a label unknown: 3 lots as live
            else:
                kind = "normal"
            arms_def = NORMAL_ARMS if kind == "normal" else EXPIRY_ARMS if kind == "expiry" else {}
            role = roles(comp, cols, core, idx)
            arms: dict[str, list[str]] = {}
            missing = []
            for name, extras in arms_def.items():
                ex = [role[r] for r in extras]
                if any(x is None for x in ex):
                    missing.append(name)
                    continue
                arms[name] = ex
            need = set(core) | {m for ex in arms.values() for m in ex}
            try:
                loaded: dict = {}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in need}
                ntr = {m: n_trades(m, d) for m in need}
                if any(v is None for v in ntr.values()):
                    bad = [m for m, v in ntr.items() if v is None]
                    raise portfolio.PortfolioStopError(f"a stored result is missing: {bad}")
            except (portfolio.PortfolioStopError, FileNotFoundError) as e:
                skipped.append(f"{d}: {e}")
                continue
            row = {"day": d.isoformat(), "kind": kind, "expiry_index": idx, "core": core,
                   "roles": role, "missing_arms": missing, "arms": {}}  # fmt: skip

            def book(members: dict[str, int], stop: float, paths=paths, ntr=ntr) -> dict:
                bd = portfolio.apply_book(
                    [portfolio.Member(m, lots, paths[m]) for m, lots in members.items()], stop
                )
                minute = np.zeros(len(next(iter(paths.values()))))
                for m, lots in members.items():
                    span = open_span(paths[m])
                    if span:
                        minute[span[0] : span[1] + 1] += lots
                return {
                    "members": members,
                    "gross": bd.gross_with,
                    "gross_nostop": bd.gross_without,
                    "stop": stop,
                    "stop_hit": bd.stop_minute is not None,
                    "brokerage": sum(2 * ntr[m] * BROKERAGE for m in members),
                    "lots": sum(members.values()),
                    "peak_open": int(minute.max()),
                }

            base3 = book({m: 1 for m in core}, BASE_STOP)
            row["arms"]["base3"] = base3
            for name, ex in arms.items():
                members = {m: 1 for m in core}
                for m in ex:
                    members[m] = members.get(m, 0) + 1
                row["arms"][name] = book(members, BASE_STOP + sum(mtmsl(m) for m in ex))
            for k in (4, 5, 6):  # the even spreads: the 3-lot book and its stop x k/3
                f = k / 3
                bd = portfolio.apply_book(
                    [portfolio.Member(m, 1, paths[m]) for m in core], BASE_STOP * f
                )
                row["arms"][f"B{k}"] = {
                    "members": {m: f for m in core},
                    "gross": bd.gross_with * f,
                    "gross_nostop": bd.gross_without * f,
                    "stop": BASE_STOP * f,
                    "stop_hit": bd.stop_minute is not None,
                    "brokerage": base3["brokerage"],
                    "lots": k,
                    "peak_open": base3["peak_open"],
                }
            rows[d.isoformat()] = row
    return rows, skipped


def net_of(r: dict, arm: str) -> float:
    a = r["arms"][arm]
    return a["gross"] - a["brokerage"]


def metrics(net: np.ndarray, lots: np.ndarray, hits: np.ndarray) -> dict:
    k = max(1, int(round(len(net) * 0.05)))
    week = np.convolve(net, np.ones(5), "valid") if len(net) >= 5 else net
    mdd = max_drawdown(net)
    annual = float(net.mean() * 250)
    return {
        "days": int(len(net)),
        "per_day": float(net.mean()),
        "per_lot_day": float(net.sum() / lots.sum()),
        "annualised": annual,
        "max_drawdown": mdd,
        "worst_day": float(net.min()),
        "worst_week": float(week.min()),
        "worst_5pct_mean": float(np.sort(net)[:k].mean()),
        "loss_day_share": float((net < 0).mean()),
        "return_over_drawdown": annual / abs(mdd) if mdd else None,
        "drawdown_per_lot": mdd / float(lots.mean()),
        "book_stop_days": int(hits.sum()),
    }


def series(sub: list[dict], arm: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    net = np.array([net_of(r, arm) for r in sub])
    lots = np.array([r["arms"][arm]["lots"] for r in sub], dtype=float)
    hits = np.array([r["arms"][arm]["stop_hit"] for r in sub])
    return net, lots, hits


def summarise_kind(sub: list[dict], kind: str) -> dict:
    """One day type's arms over its days (only days where every arm could be built)."""
    arms_def = NORMAL_ARMS if kind == "normal" else EXPIRY_ARMS
    base = NORMAL_BASE if kind == "normal" else EXPIRY_BASE
    days = [r for r in sub if r["kind"] == kind]
    usable = [r for r in days if not r["missing_arms"]]
    out: dict = {"days": len(days), "usable_days": len(usable),
                 "days_with_missing_arms": len(days) - len(usable)}  # fmt: skip
    if not usable:
        return out
    base_net = series(usable, base)[0]
    even = {k: series(usable, f"B{k}")[0] for k in (4, 5, 6)}
    for arm in arms_def:
        net, lots, hits = series(usable, arm)
        k = int(round(lots.mean()))
        e: dict = metrics(net, lots, hits) | {
            "peak_open_max": int(max(r["arms"][arm]["peak_open"] for r in usable)),
            "days_all_open": int(sum(r["arms"][arm]["peak_open"] >= k for r in usable)),
        }
        if arm != base:
            e["vs_base"] = interval(net - base_net)
        if k in even and arm not in ("E3",):
            e["vs_even"] = interval(net - even[k])
        out[arm] = e
    for k in (4, 5, 6):
        net, lots, hits = series(usable, f"B{k}")
        out[f"B{k}"] = metrics(net, lots, hits)
    out["best"] = {}
    for k, arms in GROUPS[kind].items():
        ranked = sorted(arms, key=lambda a: -out[a]["per_day"])
        best, second = ranked[0], ranked[1]
        excess = series(usable, best)[0] - even[k]
        order = np.argsort(excess)[::-1]
        total = float(excess.sum())
        out["best"][str(k)] = {
            "best": best,
            "second": second,
            "best_minus_second": interval(series(usable, best)[0] - series(usable, second)[0]),
            "ranking": ranked,
            **{
                f"vs_even_without_top_{t}": interval(np.delete(excess, order[:t]))
                | {"share_of_excess": float(excess[order[:t]].sum() / total) if total else None}
                for t in (5, 10)
            },
        }
    return out


def whole_book(sub: list[dict]) -> dict:
    """All days: a normal arm with E3 on expiry days; an expiry arm with N4 on normal days; the
    pairs of every normal and expiry arm (per day only). Days with a missing arm fall back to
    the day type's base."""

    def pick_net(r: dict, normal: str, exp: str) -> tuple[float, float, bool]:
        if r["kind"] == "normal":
            arm = normal if normal in r["arms"] else NORMAL_BASE
        elif r["kind"] == "expiry":
            arm = exp if exp in r["arms"] else EXPIRY_BASE
        else:
            arm = "base3"
        a = r["arms"][arm]
        return a["gross"] - a["brokerage"], a["lots"], a["stop_hit"]

    def whole(normal: str, exp: str) -> dict:
        vals = [pick_net(r, normal, exp) for r in sub]
        net = np.array([v[0] for v in vals])
        lots = np.array([v[1] for v in vals], dtype=float)
        hits = np.array([v[2] for v in vals])
        return metrics(net, lots, hits)

    live = whole(NORMAL_BASE, EXPIRY_BASE)
    live_net = np.array([pick_net(r, NORMAL_BASE, EXPIRY_BASE)[0] for r in sub])
    out: dict = {"live": live, "normal_arms_with_E3": {}, "expiry_arms_with_N4": {}, "pairs": {}}
    for arm in NORMAL_ARMS:
        if arm == NORMAL_BASE:
            continue
        w = whole(arm, EXPIRY_BASE)
        w["vs_live"] = interval(
            np.array([pick_net(r, arm, EXPIRY_BASE)[0] for r in sub]) - live_net
        )
        out["normal_arms_with_E3"][arm] = w
    for arm in EXPIRY_ARMS:
        if arm == EXPIRY_BASE:
            continue
        w = whole(NORMAL_BASE, arm)
        w["vs_live"] = interval(
            np.array([pick_net(r, NORMAL_BASE, arm)[0] for r in sub]) - live_net
        )
        out["expiry_arms_with_N4"][arm] = w
    for n in NORMAL_ARMS:
        for e in EXPIRY_ARMS:
            if n == NORMAL_BASE and e == EXPIRY_BASE:
                continue
            out["pairs"][f"{n} + {e}"] = whole(n, e)
    return out


def summarise(rows: dict[str, dict]) -> dict:
    out = {}
    for wname, lo in (("all", FIRST), ("last_year", LAST_YEAR_FROM)):
        sub = [r for k, r in sorted(rows.items()) if k >= lo.isoformat()]
        kinds = defaultdict(int)
        for r in sub:
            kinds[r["kind"]] += 1
        out[wname] = {
            "from": sub[0]["day"],
            "to": sub[-1]["day"],
            "days": len(sub),
            "by_kind": dict(kinds),
            "normal": summarise_kind(sub, "normal"),
            "expiry": summarise_kind(sub, "expiry"),
            "whole_book": whole_book(sub),
        }
    return out


def fmt_iv(v: dict | None) -> str:
    if not v:
        return ""
    return f"{v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}]"


def main() -> None:
    root = data_dir()
    rows, skipped = run(root)
    report = {"summary": summarise(rows), "skipped": skipped,
              "note": "T1 list C, expiry rule + SL150 cap as live; book stop 9k + each extra lot's MTM SL; even spread = 3-lot book x k/3 under 9k x k/3; net = gross - brokerage"}  # fmt: skip
    (HERE / f"lot_ladder_{STAMP}.json").write_text(json.dumps(report, indent=1) + "\n")
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / f"rows_{STAMP}.json").write_text(json.dumps(rows) + "\n")
    print(f"{len(rows)} days, {len(skipped)} skipped", *skipped[:20], sep="\n  ")
    for wname, w in report["summary"].items():
        print(f"== {wname} {w['from']}..{w['to']} {w['days']}d {w['by_kind']}")
        for kind in ("normal", "expiry"):
            s = w[kind]
            print(
                f"  -- {kind}: {s['days']} days, usable {s['usable_days']}, with a missing arm {s['days_with_missing_arms']}"
            )
            arms_def = NORMAL_ARMS if kind == "normal" else EXPIRY_ARMS
            for arm in [*arms_def, "B4", "B5", "B6"]:
                x = s.get(arm)
                if not x:
                    continue
                print(
                    f"  {arm:8} {x['per_day']:+7.0f}/d {x['per_lot_day']:+6.0f}/lot DD {x['max_drawdown']:>8,.0f} "
                    f"DD/lot {x['drawdown_per_lot']:>7,.0f} worst {x['worst_day']:>8,.0f} wk {x['worst_week']:>8,.0f} "
                    f"loss {x['loss_day_share']:.0%} R/DD {x['return_over_drawdown'] or 0:5.1f} stops {x['book_stop_days']:3} "
                    f"| vs base {fmt_iv(x.get('vs_base')):>22} | vs even {fmt_iv(x.get('vs_even')):>22}"
                )
            for k, b in s.get("best", {}).items():
                print(
                    f"  best {k} lots: {b['best']} > {b['second']}: {fmt_iv(b['best_minus_second'])}; "
                    f"vs even w/o top5 {fmt_iv(b['vs_even_without_top_5'])} ({(b['vs_even_without_top_5']['share_of_excess'] or 0):.0%}) "
                    f"w/o top10 {fmt_iv(b['vs_even_without_top_10'])} ({(b['vs_even_without_top_10']['share_of_excess'] or 0):.0%}); order {b['ranking']}"
                )
        wb = w["whole_book"]
        x = wb["live"]
        print(
            f"  -- whole book live (N4 + E3): {x['per_day']:+.0f}/d DD {x['max_drawdown']:,.0f} worst {x['worst_day']:,.0f} R/DD {x['return_over_drawdown']:.1f} DD/lot {x['drawdown_per_lot']:,.0f}"
        )
        for label, key in (
            ("normal arm + E3", "normal_arms_with_E3"),
            ("N4 + expiry arm", "expiry_arms_with_N4"),
        ):
            for arm, x in wb[key].items():
                print(
                    f"     {label:16} {arm:8} {x['per_day']:+7.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} R/DD {x['return_over_drawdown'] or 0:5.1f} DD/lot {x['drawdown_per_lot']:>7,.0f} vs live {fmt_iv(x['vs_live'])}"
                )


if __name__ == "__main__":
    main()
