"""BL-133 Amendment 2: which pick the fourth lot doubles (top score, Dir, Widesl) or adds, under
the owner's book stop and the expiring-index rule, for Core, T1 and both accounts together.

As registered in backlog/BL-133 Amendment 2 (descriptive, in-sample). Reads the live store and
replays one-lot paths through `rotation/portfolio.py` (its disk cache); writes only beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl133/fourth_lot_a2.py
"""

from __future__ import annotations

import json
from bisect import bisect_left
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from fourth_lot import BROKERAGE, WINDOWS, read

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, expiry, labels, pick, portfolio
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import runners_up, vix_band
from option_backtesting.rotation.variants import is_dir, is_wide, track_names, variant_names

HERE = Path(__file__).parent
BLOCK, RESAMPLES, SEED, LEVEL = 5, 2000, 20261028, 0.90
BOOK_STOP = {"core_298": 8000.0, "t1": 9000.0}
NO_MTMSL_ADD = 4000.0
RULES = ("R1x2", "Dx2", "Wx2")
ARMS = ("B3", "B4", *RULES, "D+", "W+")
HEAD_TO_HEAD = (("R1x2", "Dx2"), ("R1x2", "Wx2"), ("Dx2", "Wx2"))


def mtmsl(name: str) -> float:
    s = labels._load(name)
    v = None if s is None else s.overall.stop_loss_inr
    return float(v) if v is not None else NO_MTMSL_ADD


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(np.asarray(x, dtype=float), RESAMPLES, BLOCK, SEED, LEVEL)
    return {
        "mean": m,
        "ci90": [lo, hi],
        "reading": "above zero" if lo > 0 else "below zero" if hi < 0 else "includes zero",
    }


def open_span(path: tuple[float, ...]) -> tuple[int, int] | None:
    """First and last minute the one-lot path moves: when the lot is open (approximate)."""
    moves = [i for i in range(len(path)) if path[i] != (path[i - 1] if i else 0.0)]
    return (moves[0], moves[-1]) if moves else None


def lowest_dte(a: dict) -> str:
    vals = [
        7 if x == "7+" else int(x)
        for x in (str(a["dte_n"]), str(a["dte_s"]))
        if x.isdigit() or x == "7+"
    ]
    return str(min(vals)) if vals else "unknown"


def run(root: Path, names: list[str], book: str) -> dict[str, dict]:
    """{day: row} with each arm's gross with and without the book stop, brokerage, lots, peak
    lots open, the doubled strategy per rule, and T1's alternative pick per rule (for `cut`)."""
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    stored: dict[str, dict] = {}

    def trades(n: str, d: date) -> int | None:
        if n not in stored:
            stored[n] = read(n, root)
        got = stored[n].get(d)
        return None if got is None else got[1]

    stop0 = BOOK_STOP[book]
    lo0, hi0 = WINDOWS["two_years"]
    rows: dict[str, dict] = {}
    skipped: list[str] = []
    for d in rec.days_available():
        if not lo0 <= d <= hi0:
            continue
        a = rec.attrs[d]
        is_expiry = "0" in (str(a["dte_n"]), str(a["dte_s"]))
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        vix = daylog._number(a.get("vix_open"))
        for key, cols, comp, picks in pick._rank(hist, d, vix, dte):
            if key != "C":
                continue
            idx = expiry.expiring_index(a["dte_n"], a["dte_s"])
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
                ru = expiry.filtered_runners_up(comp, cols, picks, idx)
            else:
                ru = runners_up(comp, cols, picks)
            score = {n: float(comp[j]) for j, n in enumerate(cols)}
            core = list(picks.core)
            ranked = sorted(core, key=lambda n: (-score[n], n))
            wide = [n for n in ranked if is_wide(n)]
            dirs = [n for n in ranked if is_dir(n)]

            def double(n, core=core):
                return [(m, 2 if m == n else 1) for m in core], n

            def add(n, core=core):
                return ([(m, 1) for m in core] + [(n, 1)], n) if n else (None, None)

            arms: dict[str, tuple] = {"B3": ([(m, 1) for m in core], None)}
            if not is_expiry:
                arms["R1x2"] = double(ranked[0])
                arms["Dx2"] = double(dirs[0]) if dirs else add(ru.get("dir"))
                arms["Wx2"] = double(wide[0]) if wide else add(ru.get("wide"))
                arms["D+"] = add(ru.get("dir"))
                arms["W+"] = add(ru.get("wide"))
                for r in RULES:  # the highest-composite core pick other than the rule's own
                    own = arms[r][1]
                    other = next((m for m in ranked if m != own), None)
                    arms[f"alt_{r}"] = double(other) if other else (None, None)
            try:
                if any(v[0] is None for v in arms.values()):
                    raise portfolio.PortfolioStopError("a runner-up is missing")
                loaded: dict = {}
                need = {m for book_, _ in arms.values() for m, _ in book_}
                paths = {m: portfolio.one_lot_path(root, d, m, loaded) for m in need}
                n_tr = {m: trades(m, d) for m in need}
                if any(v is None for v in n_tr.values()):
                    raise portfolio.PortfolioStopError("a stored result is missing")
            except portfolio.PortfolioStopError as e:
                skipped.append(f"{d}: {e}")
                continue
            row = {
                "day": d.isoformat(),
                "expiry": is_expiry,
                "expiry_index": idx,
                "vix_band": vix_band(vix),
                "dte_low": lowest_dte(a),
                "top_family": "dir"
                if is_dir(ranked[0])
                else "wide"
                if is_wide(ranked[0])
                else "other",
                "arms": {},
            }
            for k, (members, extra) in arms.items():
                stop = stop0 + (mtmsl(extra) if extra else 0.0)
                bd = portfolio.apply_book(
                    [portfolio.Member(m, lots, paths[m]) for m, lots in members], stop
                )
                minute = np.zeros(len(paths[members[0][0]]))
                for m, lots in members:
                    span = open_span(paths[m])
                    if span:
                        minute[span[0] : span[1] + 1] += lots
                row["arms"][k] = {
                    "doubled": extra,
                    "gross_stop": bd.gross_with,
                    "gross_nostop": bd.gross_without,
                    "stop_hit": bd.stop_minute is not None,
                    "brokerage": sum(2 * n_tr[m] * BROKERAGE for m, _ in members),
                    "lots": sum(lots for _, lots in members),
                    "peak_open": int(minute.max()),
                }
            b3 = row["arms"]["B3"]
            f = 1.0 if is_expiry else 4 / 3
            row["arms"]["B4"] = {
                "doubled": None,
                "gross_stop": b3["gross_stop"] * f,
                "gross_nostop": b3["gross_nostop"] * f,
                "stop_hit": b3["stop_hit"],
                "brokerage": b3["brokerage"],
                "lots": 3 if is_expiry else 4,
                "peak_open": b3["peak_open"],
            }
            if is_expiry:
                for k in (*RULES, "D+", "W+"):
                    row["arms"][k] = dict(b3)
            rows[d.isoformat()] = row
    print(f"{book}: {len(rows)} days, {len(skipped)} skipped", *skipped[:10], sep="\n  ")
    return rows


def metrics(net: np.ndarray, lots: np.ndarray, stop_hits: np.ndarray) -> dict:
    eq = np.cumsum(net)
    peak = np.maximum.accumulate(np.maximum(eq, 0.0))
    under, longest = 0, 0
    for e, p in zip(eq, peak, strict=True):
        under = under + 1 if e < p else 0
        longest = max(longest, under)
    mdd = max_drawdown(net)
    k = max(1, int(round(len(net) * 0.05)))
    week = np.convolve(net, np.ones(5), "valid") if len(net) >= 5 else net
    annual = float(net.mean() * 250)
    return {
        "per_day": float(net.mean()),
        "annualised": annual,
        "max_drawdown": mdd,
        "worst_day": float(net.min()),
        "worst_week": float(week.min()),
        "longest_drawdown_days": longest,
        "worst_5pct_mean": float(np.sort(net)[:k].mean()),
        "loss_day_share": float((net < 0).mean()),
        "return_over_drawdown": annual / abs(mdd) if mdd else None,
        "drawdown_per_lot": mdd / float(lots.mean()),
        "book_stop_days": int(stop_hits.sum()),
    }


def series(sub: list[dict], arm: str, stop: bool) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    g = "gross_stop" if stop else "gross_nostop"
    net = np.array([r["arms"][arm][g] - r["arms"][arm]["brokerage"] for r in sub])
    lots = np.array([r["arms"][arm]["lots"] for r in sub], dtype=float)
    hits = np.array([r["arms"][arm]["stop_hit"] and stop for r in sub])
    return net, lots, hits


def peak_open(sub: list[dict], arm: str) -> dict:
    normal = [r["arms"][arm]["peak_open"] for r in sub if not r["expiry"]]
    return {
        "max_peak_open_lots": int(max(normal)) if normal else 0,
        "normal_days_4_open": int(sum(p >= 4 for p in normal)),
        "normal_days": len(normal),
    }


def day_net(r: dict, arm: str) -> float:
    return r["arms"][arm]["gross_stop"] - r["arms"][arm]["brokerage"]


def steadiness(sub: list[dict], arm: str) -> dict:
    out: dict = {}
    for label, keyf in (
        ("quarter", lambda r: f"{r['day'][:4]}Q{(int(r['day'][5:7]) - 1) // 3 + 1}"),
        ("vix_band", lambda r: r["vix_band"]),
        ("dte_low", lambda r: r["dte_low"]),
    ):
        groups: dict[str, list] = defaultdict(list)
        for r in sub:
            if r["expiry"]:
                continue
            groups[keyf(r)].append(
                (day_net(r, arm) - day_net(r, "B3"), day_net(r, arm) - day_net(r, "B4"))
            )
        out[label] = {
            g: {
                "days": len(v),
                "vs_B3": float(np.mean([x[0] for x in v])),
                "vs_B4": float(np.mean([x[1] for x in v])),
            }
            for g, v in sorted(groups.items())
        }
    return out


def summarise(rows: dict[str, dict]) -> dict:
    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sub = [r for k, r in sorted(rows.items()) if lo.isoformat() <= k <= hi.isoformat()]
        normal = [r for r in sub if not r["expiry"]]
        w: dict = {
            "days": len(sub),
            "expiry_days": len(sub) - len(normal),
            "top_pick_family": {
                f: sum(r["top_family"] == f for r in normal) for f in ("dir", "wide", "other")
            },
        }
        b3 = {s: series(sub, "B3", s)[0] for s in (True, False)}
        b4 = {s: series(sub, "B4", s)[0] for s in (True, False)}
        for arm in ARMS:
            entry: dict = {"peak_open": peak_open(sub, arm)}
            for s, tag in ((True, "stop"), (False, "nostop")):
                net, lots, hits = series(sub, arm, s)
                entry[tag] = metrics(net, lots, hits)
                if arm not in ("B3", "B4"):
                    entry[tag]["vs_B3"] = interval(net - b3[s])
                    entry[tag]["vs_B4"] = interval(net - b4[s])
            if arm in ("R1x2", "Dx2"):
                excess = series(sub, arm, True)[0] - b4[True]
                order = np.argsort(excess)[::-1]
                total = float(excess.sum())
                for top in (5, 10):
                    entry["stop"][f"vs_B4_without_top_{top}"] = interval(
                        np.delete(excess, order[:top])
                    ) | {
                        "share_of_excess": float(excess[order[:top]].sum() / total)
                        if total
                        else None
                    }
            if arm in RULES:
                entry["steadiness"] = steadiness(sub, arm)
            w[arm] = entry
        w["head_to_head"] = {
            f"{x}-{y}": interval(series(sub, x, True)[0] - series(sub, y, True)[0])
            for x, y in HEAD_TO_HEAD
        }
        out[wname] = w
    return out


def combined(core: dict[str, dict], t1: dict[str, dict]) -> dict:
    """Both accounts: Core's rule + T1's rule, three ways when they double the same strategy."""
    days = sorted(set(core) & set(t1))
    out = {}
    for wname, (lo, hi) in WINDOWS.items():
        sel = [d for d in days if lo.isoformat() <= d <= hi.isoformat()]
        w: dict = {"days": len(sel)}

        def net(r, k):
            a = r["arms"][k]
            return a["gross_stop"] - a["brokerage"]

        base = np.array([net(core[d], "B3") + net(t1[d], "B3") for d in sel])
        lots_base = np.full(len(sel), 6.0)
        w["B3+B3"] = metrics(base, lots_base, np.zeros(len(sel), bool))
        for r in RULES:
            same = [
                d for d in sel
                if not core[d]["expiry"] and core[d]["arms"][r]["doubled"] == t1[d]["arms"][r]["doubled"]
            ]  # fmt: skip
            ways = {}
            for way in ("both", "cut", "skip"):
                vals, lots = [], []
                for d in sel:
                    c, t = core[d], t1[d]
                    tk = r
                    if d in same and way == "cut":
                        tk = f"alt_{r}"
                    elif d in same and way == "skip":
                        tk = "B3"
                    vals.append(net(c, r) + net(t, tk))
                    lots.append(c["arms"][r]["lots"] + t["arms"][tk]["lots"])
                v = np.array(vals)
                ways[way] = metrics(v, np.array(lots, float), np.zeros(len(sel), bool)) | {
                    "vs_B3+B3": interval(v - base)
                }
            ways["both-cut"] = interval(
                np.array([net(core[d], r) + net(t1[d], r) for d in sel])
                - np.array(
                    [net(core[d], r) + net(t1[d], f"alt_{r}" if d in same else r) for d in sel]
                )
            )
            w[r] = {
                "same_strategy_days": len(same),
                "normal_days": sum(not core[d]["expiry"] for d in sel),
            } | ways
        out[wname] = w
    return out


def main() -> None:
    root = data_dir()
    rows = {
        "core_298": run(root, variant_names(), "core_298"),
        "t1": run(root, [*variant_names(), *track_names("t1")], "t1"),
    }
    report = {
        "core_298": summarise(rows["core_298"]),
        "t1": summarise(rows["t1"]),
        "both_accounts": combined(rows["core_298"], rows["t1"]),
        "note": "net = replayed one-lot paths x lots under the book stop (8k Core, 9k T1, + the extra lot's MTM SL) - brokerage; expiring-index rule applied; 3 lots on expiry days",
    }
    (HERE / "fourth_lot_a2_2026-10-28.json").write_text(json.dumps(report, indent=1) + "\n")
    (HERE / "out").mkdir(exist_ok=True)  # per-day rows, git-ignored
    (HERE / "out" / "fourth_lot_a2_rows_2026-10-28.json").write_text(json.dumps(rows) + "\n")
    for book in ("core_298", "t1"):
        for wname, w in report[book].items():
            print(
                f"== {book} {wname} {w['days']}d ({w['expiry_days']} expiry) top pick {w['top_pick_family']}"
            )
            for arm in ARMS:
                x = w[arm]["stop"]
                line = (
                    f"  {arm:5} net {x['per_day']:+6.0f}/d DD {x['max_drawdown']:>8,.0f} worst {x['worst_day']:>8,.0f} "
                    f"wk {x['worst_week']:>8,.0f} R/DD {x['return_over_drawdown'] or 0:4.1f} DD/lot {x['drawdown_per_lot']:>7,.0f} "
                    f"stops {x['book_stop_days']:3} | nostop {w[arm]['nostop']['per_day']:+6.0f}/d DD {w[arm]['nostop']['max_drawdown']:>8,.0f}"
                )
                if "vs_B4" in x:
                    v, b = x["vs_B4"], x["vs_B3"]
                    line += f" | vsB3 {b['mean']:+.0f} [{b['ci90'][0]:+.0f},{b['ci90'][1]:+.0f}] vsB4 {v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}]"
                print(line)
            for k, v in w["head_to_head"].items():
                print(
                    f"  {k}: {v['mean']:+.0f} [{v['ci90'][0]:+.0f},{v['ci90'][1]:+.0f}] {v['reading']}"
                )
    for wname, w in report["both_accounts"].items():
        print(
            f"== both accounts {wname} {w['days']}d  B3+B3 {w['B3+B3']['per_day']:+.0f}/d DD {w['B3+B3']['max_drawdown']:,.0f}"
        )
        for r in RULES:
            x = w[r]
            print(
                f"  {r}: same strategy on {x['same_strategy_days']}/{x['normal_days']} normal days"
            )
            for way in ("both", "cut", "skip"):
                m = x[way]
                print(
                    f"    {way:4} {m['per_day']:+6.0f}/d DD {m['max_drawdown']:>8,.0f} worst {m['worst_day']:>8,.0f} "
                    f"vs 6 lots {m['vs_B3+B3']['mean']:+.0f} [{m['vs_B3+B3']['ci90'][0]:+.0f},{m['vs_B3+B3']['ci90'][1]:+.0f}]"
                )


if __name__ == "__main__":
    main()
