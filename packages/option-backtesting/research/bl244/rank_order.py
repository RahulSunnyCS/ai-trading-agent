"""BL-244: does the ranking's order predict results? (Phases 1-3, as registered in the item.)

For every day, list C's composite over a pool is rebuilt from the results before that day; the
top and bottom Widesl and Dir sets, ranks 1-5 and the day's best / worst realised are then read
at 0.5 % slippage. Reads the store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl244/rank_order.py --period new
    TRADING_DATA_ROOT=/Volumes/TradingData/_bl214 uv run python research/bl244/rank_order.py --period old
"""

from __future__ import annotations

import argparse
import csv
import json
from bisect import bisect_left
from collections import Counter
from datetime import date, timedelta
from functools import cache
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, pick, store
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import composite, dte_matrix, family_index, vix_band
from option_backtesting.rotation.variants import (
    is_dir,
    is_wide,
    parts,
    track_names,
    underlying_of,
    variant_names,
)

HERE = Path(__file__).parent
SEED, BLOCK, RESAMPLES, LEVEL = 20261126, 5, 2000, 0.95
SIZES = {"wide": 10, "dir": 5}
RANKS = 5
DROP_BEST = 10
PERIODS = {
    "new": {"from": date(2025, 1, 10), "to": date(2026, 10, 9), "split": date(2025, 10, 9)},
    "old": {"from": date(2021, 11, 1), "to": date(2024, 10, 8), "split": None},
}


def band(tag: str) -> str:
    """The start band `score.family_index` pools by."""
    m = int(tag[:2]) * 60 + int(tag[2:])
    return (
        "09:17-10:02"
        if m <= 602
        else "10:17-12:02"
        if m <= 722
        else "12:17-14:02"
        if m <= 842
        else "14:17-15:17"
    )


def strategy(name: str) -> str:
    index, family, _ = parts(name)
    return f"{index}_{family}"


GROUPS = {
    "strategy": strategy,
    "index": underlying_of,
    "start_band": lambda n: band(parts(n)[2]),
}


def interval(x: np.ndarray) -> dict:
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED, LEVEL)
    return {"days": int(x.size), "mean": m, "lo": lo, "hi": hi}


def stats(x: np.ndarray) -> dict:
    return {
        "mean": float(x.mean()),
        "median": float(np.median(x)),
        "total": float(x.sum()),
        "win_rate": float((x > 0).mean()),
        "worst_day": float(x.min()),
        "max_drawdown": float(max_drawdown(x)),
    }


def read_extra(name: str, root: Path) -> dict[date, tuple[float, int]]:
    """{day: (gross, n_trades)} as stored."""
    with store.result_path(name, root).open() as f:
        return {
            date.fromisoformat(r["day"]): (float(r["gross"]), int(float(r["n_trades"] or 0)))
            for r in csv.DictReader(f)
        }


# the result files do not change during a run; without this every day's check re-reads all of them
_READ_NET = store.read_net
_CACHED_NET = cache(_READ_NET)


def history_from_disk(
    root: Path, names: list[str], day: date, fallback: bool = False
) -> tuple[pick.History, bool]:
    """(history, refused): `pick.load_history`, or the same two reads where it refuses for a known
    reason. On the live store that is only "results end before the last collected day" (the days
    after September 2026's missing results). BL-214's store (`fallback`) has no lake of its own."""
    store.read_net = _CACHED_NET  # used by load_history only, which reads unslipped results
    try:
        return pick.load_history(day, root, names), False
    except pick.PickError as e:
        if not fallback and not str(e).startswith("results end "):
            raise
        m = store.load_matrix(names, root, through=day - timedelta(days=1))
        attrs = store.read_days(root)
        keep = [i for i, d in enumerate(m.days) if d in attrs]
        days = [m.days[i] for i in keep]
        cols = [[attrs[d][k] for d in days] for k in ("weekday", "vix_band", "dte_n", "dte_s")]
        return pick.History(days, list(m.names), m.values[keep], *cols, ""), True
    finally:
        store.read_net = _READ_NET


def run_pool(root: Path, names: list[str], period: dict, fallback: bool = False) -> dict:
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cols = rec.cols
    with store.slipped(0.5):
        slip = store.load_matrix(cols, root)
    row_of = {d: i for i, d in enumerate(slip.days)}
    extra = [read_extra(n, root) for n in cols]
    fam = family_index(cols)
    days = [
        d
        for d in rec.days
        if period["from"] <= d <= period["to"] and bisect_left(rec.days, d) >= WARMUP
    ]
    assert days, "no rankable day"
    split = period["split"] or days[len(days) // 2]

    kind_idx = {
        "wide": [v for v, n in enumerate(cols) if is_wide(n)],
        "dir": [v for v, n in enumerate(cols) if is_dir(n)],
    }
    peers = {  # same kind, index and start band
        v: [
            u
            for u in idx
            if underlying_of(cols[u]) == underlying_of(cols[v])
            and band(parts(cols[u])[2]) == band(parts(cols[v])[2])
        ]
        for idx in kind_idx.values()
        for v in idx
    }
    rng = np.random.default_rng(SEED)

    out_days: list[dict] = []
    members: dict[str, dict[str, list[list[str]]]] = {
        k: {s: [] for s in ("top", "bottom", "best_realised", "worst_realised")} for k in kind_idx
    }
    checked = gap_days = 0
    for d in days:
        i = bisect_left(rec.days, d)
        a = rec.attrs[d]
        vix_open = daylog._number(a.get("vix_open"))
        # only rows before d are passed; d's own row is a zero placeholder the ranking never reads
        Pv = np.vstack([rec.values[:i], np.zeros((1, len(cols)))])
        weekday = np.array([*rec.weekday[:i], d.strftime("%a")])
        bands = np.array([*rec.band[:i], vix_band(vix_open)])
        dmat = dte_matrix(
            np.array([*rec.dte_n[:i], a["dte_n"]]), np.array([*rec.dte_s[:i], a["dte_s"]]), cols
        )
        comp = composite(Pv, weekday, bands, dmat, cols, LISTS["C"], fam)

        # every day, an independent path: what the pick job would read from disk
        hist, refused = history_from_disk(root, cols, d, fallback)
        gap_days += refused
        assert hist.days == rec.days[:i], d
        live = next(
            c
            for key, _, c, _ in pick._rank(
                hist, d, vix_open, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )
            if key == "C"
        )
        assert np.allclose(live, comp, rtol=0, atol=1e-9), d
        checked += 1

        j = row_of[d]
        net = slip.values[j]
        gross = np.array([extra[v][d][0] for v in range(len(cols))])
        traded = np.array([extra[v][d][1] > 0 for v in range(len(cols))])
        row: dict = {
            "day": d.isoformat(),
            "half": 1 if d < split else 2,
            "expiry_day": "0" in (a["dte_n"], a["dte_s"]),
        }
        for kind, idx in kind_idx.items():
            size = SIZES[kind]
            order = sorted(idx, key=lambda v: (-comp[v], cols[v]))
            tie = rng.random(len(cols))
            realised = sorted(idx, key=lambda v: (net[v], tie[v]))
            sets = {
                "top": order[:size],
                "bottom": order[-size:],
                "best_realised": realised[-size:],
                "worst_realised": realised[:size],
            }
            for s, vs in sets.items():
                members[kind][s].append([cols[v] for v in vs])
            row[f"{kind}_pool"] = float(net[idx].mean())
            for s in ("top", "bottom"):
                vs = sets[s]
                row[f"{kind}_{s}"] = float(net[vs].mean())
                row[f"{kind}_{s}_gross"] = float(gross[vs].mean())
                row[f"{kind}_{s}_peers"] = float(np.mean([net[peers[v]].mean() for v in vs]))
                row[f"{kind}_{s}_traded"] = float(traded[vs].mean())
            clones: list[int] = []
            seen: set[str] = set()
            for v in order:
                if strategy(cols[v]) not in seen:
                    seen.add(strategy(cols[v]))
                    clones.append(v)
                if len(clones) == RANKS:
                    break
            for r in range(RANKS):
                row[f"{kind}_r{r + 1}"] = float(net[order[r]])
                # a pool with under 5 strategies of a kind (Core's Dir has 4) has no 5th clone
                row[f"{kind}_c{r + 1}"] = float(net[clones[r]]) if r < len(clones) else float("nan")
            row[f"{kind}_distinct_top5"] = len({strategy(cols[v]) for v in order[:RANKS]})
        out_days.append(row)

    return {
        "days": out_days,
        "members": members,
        "split": split.isoformat(),
        "pool": {k: [cols[v] for v in idx] for k, idx in kind_idx.items()},
        "checked_days": checked,
        "days_load_history_refused": gap_days,
    }


def column(rows: list[dict], key: str) -> np.ndarray:
    return np.array([r[key] for r in rows], dtype=float)


def summarise(run: dict) -> dict:
    rows = run["days"]
    halves = {h: [r for r in rows if r["half"] == h] for h in (1, 2)}
    out: dict = {
        "days": len(rows),
        "from": rows[0]["day"],
        "to": rows[-1]["day"],
        "half_split": run["split"],
        "half_days": [len(halves[1]), len(halves[2])],
        "look_ahead_checked_days": run["checked_days"],
        "days_load_history_refused": run["days_load_history_refused"],
    }
    for kind in SIZES:

        def diff(a: str, b: str, rs: list[dict], kind: str = kind) -> np.ndarray:
            return column(rs, f"{kind}_{a}") - column(rs, f"{kind}_{b}")

        def block(a: str, b: str, diff=diff) -> dict:
            return interval(diff(a, b, rows)) | {
                "halves": [float(diff(a, b, halves[h]).mean()) for h in (1, 2)]
            }

        spread = block("top", "bottom")
        trimmed = np.sort(diff("top", "bottom", rows))[:-DROP_BEST]
        spread["mean_without_best_days"] = float(trimmed.mean())
        spread["days_top_ahead"] = float((diff("top", "bottom", rows) > 0).mean())
        peers_gap = block("top", "top_peers")
        set_pass = (
            spread["lo"] > 0 and min(spread["halves"]) > 0 and spread["mean_without_best_days"] > 0
        )

        def order_series(rs: list[dict], p: str, kind: str = kind) -> np.ndarray:
            c = {r: column(rs, f"{kind}_{p}{r}") for r in (1, 2, 4, 5)}
            return (c[1] + c[2]) / 2 - (c[4] + c[5]) / 2

        n_clones = sum(
            not np.isnan(column(rows, f"{kind}_c{r}")).any() for r in range(1, RANKS + 1)
        )
        orders = {}
        for p, label in (("r", "plain"), ("c", "one_per_strategy")):
            if p == "c" and n_clones < RANKS:
                continue
            o = interval(order_series(rows, p))
            o["halves"] = [float(order_series(halves[h], p).mean()) for h in (1, 2)]
            orders[label] = o
        order_pass = orders["plain"]["lo"] > 0 and min(orders["plain"]["halves"]) > 0
        expiry = [r for r in rows if r["expiry_day"]]
        normal = [r for r in rows if not r["expiry_day"]]
        out[kind] = {
            "sets": {
                s: stats(column(rows, f"{kind}_{s}"))
                | {
                    "gross_mean": float(column(rows, f"{kind}_{s}_gross").mean()),
                    "share_traded": float(column(rows, f"{kind}_{s}_traded").mean()),
                    "halves_mean": [float(column(halves[h], f"{kind}_{s}").mean()) for h in (1, 2)],
                }
                for s in ("top", "bottom")
            }
            | {"pool": stats(column(rows, f"{kind}_pool"))},
            "top_minus_bottom": spread,
            "set_verdict": "pass" if set_pass else "not passed",
            "top_minus_peers": peers_gap,
            "bottom_minus_peers": block("bottom", "bottom_peers"),
            "top_minus_pool": block("top", "pool"),
            "pool_minus_bottom": block("pool", "bottom"),
            "ranks": {str(r): stats(column(rows, f"{kind}_r{r}")) for r in range(1, RANKS + 1)},
            "ranks_one_per_strategy": {
                str(r): stats(column(rows, f"{kind}_c{r}")) for r in range(1, n_clones + 1)
            },
            "ranks_halves_mean": {
                str(r): [float(column(halves[h], f"{kind}_r{r}").mean()) for h in (1, 2)]
                for r in range(1, RANKS + 1)
            },
            "order_1_2_minus_4_5": orders,
            "order_verdict": "ordered" if order_pass else "no usable order inside the top 5",
            "distinct_strategies_in_top5": float(column(rows, f"{kind}_distinct_top5").mean()),
            "expiry_days": {
                "days": len(expiry),
                "top_minus_bottom": float(diff("top", "bottom", expiry).mean()),
                "other_days": float(diff("top", "bottom", normal).mean()),
            },
        }
    return out


def concentration(run: dict) -> dict:
    rows = run["days"]
    out: dict = {}
    for kind, sets in run["members"].items():
        pool = run["pool"][kind]
        out[kind] = {}
        for gname, key in GROUPS.items():
            pool_share = {g: n / len(pool) for g, n in Counter(key(x) for x in pool).items()}
            table: dict = {}
            for s, per_day in sets.items():
                shares = {}
                for h in (1, 2):
                    c = Counter(
                        key(x)
                        for r, m in zip(rows, per_day, strict=True)
                        if r["half"] == h
                        for x in m
                    )
                    total = sum(c.values())
                    shares[h] = {g: c.get(g, 0) / total for g in pool_share}
                table[s] = {
                    g: {
                        "pool_share": pool_share[g],
                        "share": [shares[1][g], shares[2][g]],
                        "lift": [shares[h][g] / pool_share[g] for h in (1, 2)],
                        "over": all(
                            shares[h][g] >= 0.10 and shares[h][g] / pool_share[g] >= 1.5
                            for h in (1, 2)
                        ),
                    }
                    for g in sorted(pool_share)
                }
            out[kind][gname] = table
    return out


def show(label: str, s: dict, conc: dict) -> None:
    print(f"\n=== {label}: {s['days']} days {s['from']} to {s['to']}, halves {s['half_days']} "
          f"(split {s['half_split']}), look-ahead rebuilt on {s['look_ahead_checked_days']} days ===")  # fmt: skip
    for kind in SIZES:
        k = s[kind]
        print(f"\n[{kind}]  per lot-day, net of costs, 0.5% slippage")
        print(f"  {'':8}{'mean':>8}{'median':>8}{'total':>10}{'win':>6}{'worst':>9}{'maxDD':>10}")
        rows = [(x, k["sets"][x]) for x in ("top", "pool", "bottom")]
        rows += [(f"rank {r}", v) for r, v in k["ranks"].items()]
        rows += [(f"1/str {r}", v) for r, v in k["ranks_one_per_strategy"].items()]
        for name, v in rows:
            print(f"  {name:8}{v['mean']:>8.0f}{v['median']:>8.0f}{v['total']:>10.0f}"
                  f"{v['win_rate']:>6.0%}{v['worst_day']:>9.0f}{v['max_drawdown']:>10.0f}")  # fmt: skip
        for key in ("top_minus_bottom", "top_minus_pool", "pool_minus_bottom",
                    "top_minus_peers", "bottom_minus_peers"):  # fmt: skip
            v = k[key]
            print(f"  {key:20}{v['mean']:>7.0f} [{v['lo']:.0f}, {v['hi']:.0f}]  halves "
                  f"{v['halves'][0]:.0f} / {v['halves'][1]:.0f}")  # fmt: skip
        t = k["top_minus_bottom"]
        print(f"  without best {DROP_BEST} days {t['mean_without_best_days']:.0f}; top ahead on "
              f"{t['days_top_ahead']:.0%} of days -> {k['set_verdict']}")  # fmt: skip
        for label2, o in k["order_1_2_minus_4_5"].items():
            print(f"  ranks 1-2 minus 4-5 ({label2}) {o['mean']:.0f} [{o['lo']:.0f}, {o['hi']:.0f}] "
                  f"halves {o['halves'][0]:.0f} / {o['halves'][1]:.0f}")  # fmt: skip
        print(f"  order verdict: {k['order_verdict']}; distinct strategies in top 5: "
              f"{k['distinct_strategies_in_top5']:.2f}; expiry days {k['expiry_days']}")  # fmt: skip
        print(f"  traded share top/bottom: {k['sets']['top']['share_traded']:.0%} / "
              f"{k['sets']['bottom']['share_traded']:.0%}")  # fmt: skip
        for gname, table in conc[kind].items():
            for setname, groups in table.items():
                over = [
                    f"{g} {v['share'][0]:.0%}/{v['share'][1]:.0%} (pool {v['pool_share']:.0%})"
                    for g, v in groups.items()
                    if v["over"]
                ]
                if over:
                    print(f"    over-represented in {setname} by {gname}: {'; '.join(over)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", choices=sorted(PERIODS), required=True)
    args = ap.parse_args()
    period = PERIODS[args.period]
    root = data_dir()
    pools = {"t1": [*variant_names(), *track_names("t1")], "core": variant_names()}
    if args.period == "old":  # BL-214's store holds NIFTY only
        pools = {k: [n for n in v if n.startswith("N_")] for k, v in pools.items()}
    report: dict = {"period": args.period, "seed": SEED, "interval": LEVEL}
    (HERE / "out").mkdir(exist_ok=True)
    for label, names in pools.items():
        run = run_pool(root, names, period, fallback=args.period == "old")
        s, conc = summarise(run), concentration(run)
        report[label] = {"variants": len(names), "summary": s, "concentration": conc}
        with (HERE / "out" / f"days_{args.period}_{label}.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(run["days"][0]))
            w.writeheader()
            w.writerows(run["days"])
        show(f"{label} ({len(names)} strategies)", s, conc)
    (HERE / f"results_{args.period}.json").write_text(json.dumps(report, indent=1) + "\n")


if __name__ == "__main__":
    main()
