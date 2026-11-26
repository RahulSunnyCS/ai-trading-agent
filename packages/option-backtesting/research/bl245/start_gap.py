"""BL-245: a minimum start-time gap between picks of the same kind (as registered in the item).

For every day, list C's composite is rebuilt from the results before that day, and the book is
selected as live (expiry-day rule, SL150% cap) with and without the gap. Reads the store only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl245/start_gap.py --period new
    TRADING_DATA_ROOT=/Volumes/TradingData/_bl214 uv run python research/bl245/start_gap.py --period old

`--counts` prints how many days each arm changes and computes no P&L.
"""

from __future__ import annotations

import argparse
import csv
import json
from bisect import bisect_left
from datetime import date, timedelta
from functools import cache
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, expiry, pick, sl150_cap, store
from option_backtesting.rotation.lists import LISTS, MIN_WIDE_N, N_CORE, WARMUP
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import (
    Picks,
    composite,
    dte_matrix,
    family_index,
    select,
    vix_band,
)
from option_backtesting.rotation.variants import (
    is_buy,
    is_dir,
    is_wide,
    parts,
    track_names,
    underlying_of,
    variant_names,
)

HERE = Path(__file__).parent
SEED, BLOCK, RESAMPLES, LEVEL = 20261126, 5, 2000, 0.95
MIN_CHANGED = 20
PLACEBOS, PLACEBO_POOL = 1000, 15
#: arm name -> (gap in minutes, only same-index picks block). The first two decide.
ARMS = {"G15": (15, False), "G30": (30, False), "G15_same": (15, True), "G30_same": (30, True)}
DECIDING = ("G15", "G30")
PERIODS = {
    "new": {"from": date(2025, 1, 10), "to": date(2026, 10, 9), "split": date(2025, 10, 9)},
    "old": {"from": date(2021, 11, 1), "to": date(2024, 10, 8), "split": None},
}


def minutes(name: str) -> int:
    tag = parts(name)[2]
    return int(tag[:2]) * 60 + int(tag[2:])


def blocks(a: str, b: str, gap: int, same_index: bool) -> bool:
    """Does taking `a` rule out `b`?"""
    same_kind = (is_wide(a) and is_wide(b)) or (is_dir(a) and is_dir(b))
    if not same_kind or (same_index and underlying_of(a) != underlying_of(b)):
        return False
    return abs(minutes(a) - minutes(b)) < gap


def gap_select(comp: np.ndarray, names: list[str], gap: int, same_index: bool) -> list[str]:
    """`score.select`'s core, skipping a candidate a taken pick rules out."""
    order = [
        names[v]
        for v in sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))
        if not is_buy(names[v])
    ]
    score = {n: float(comp[v]) for v, n in enumerate(names)}

    def free(n: str, taken: list[str]) -> bool:
        return n not in taken and not any(blocks(t, n, gap, same_index) for t in taken)

    core: list[str] = []
    for n in order:
        if len(core) == N_CORE:
            break
        if free(n, core):
            core.append(n)
    dropped: set[str] = set()
    while sum(map(is_wide, core)) < MIN_WIDE_N:
        out = min((n for n in core if is_dir(n)), key=lambda n: (score[n], n))
        core.remove(out)
        dropped.add(out)
        core.append(next(n for n in order if is_wide(n) and n not in dropped and free(n, core)))
    assert len(core) == N_CORE, core
    return core


def day_pool(names: list[str], dte_n: str, dte_s: str) -> list[int]:
    """The variants the expiry-day rule allows on a day."""
    index = expiry.expiring_index(dte_n, dte_s)
    return [v for v, n in enumerate(names) if index is None or underlying_of(n) == index]


def capped(dte_n: str, dte_s: str) -> bool:
    """The SL150% cap's condition, as `pick` composes it: never on an expiry-rule day."""
    return expiry.expiring_index(dte_n, dte_s) is None and dte_n not in ("0", "unknown", "None")


def book(
    comp: np.ndarray, names: list[str], dte_n: str, dte_s: str, gap: int, same_index: bool
) -> list[str]:
    keep = day_pool(names, dte_n, dte_s)
    c, n = np.asarray(comp)[keep], [names[v] for v in keep]
    core = gap_select(c, n, gap, same_index)
    if capped(dte_n, dte_s):
        again = sl150_cap._keep(c, n, core)
        if again is not None:
            core = gap_select(c[again], [n[v] for v in again], gap, same_index)
    return core


def live_book(comp: np.ndarray, names: list[str], dte_n: str, dte_s: str) -> list[str]:
    """The same day through the live functions."""
    picks: Picks = select(comp, names)
    index = expiry.expiring_index(dte_n, dte_s)
    if index:
        return expiry.filter_picks(comp, names, picks, index).core
    if capped(dte_n, dte_s):
        return sl150_cap.cap_picks(comp, names, picks).core
    return picks.core


# the result files do not change during a run; without this every day's check re-reads all of them
_READ_NET = store.read_net
_CACHED_NET = cache(_READ_NET)


def history_from_disk(
    root: Path, names: list[str], day: date, fallback: bool
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


def select_days(root: Path, names: list[str], period: dict, fallback: bool) -> dict:
    """Every day's books. No result of the day itself is read."""
    daylog._recon_cache.clear()
    rec = daylog.reconstruction(root, names)
    assert rec.error is None, rec.error
    cols = rec.cols
    fam = family_index(cols)
    days = [
        d
        for d in rec.days
        if period["from"] <= d <= period["to"] and bisect_left(rec.days, d) >= WARMUP
    ]
    assert days, "no rankable day"
    out = []
    gap_days = 0
    for d in days:
        i = bisect_left(rec.days, d)
        a = rec.attrs[d]
        vix_open = daylog._number(a.get("vix_open"))
        dn, ds = str(a["dte_n"]), str(a["dte_s"])
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
        ranked = next(
            c
            for key, _, c, _ in pick._rank(
                hist, d, vix_open, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )
            if key == "C"
        )
        assert np.allclose(ranked, comp, rtol=0, atol=1e-9), d

        free = live_book(comp, cols, dn, ds)
        assert sorted(book(comp, cols, dn, ds, 0, False)) == sorted(free), (d, free)
        books = {"FREE": free} | {a_: book(comp, cols, dn, ds, *spec) for a_, spec in ARMS.items()}
        keep = day_pool(cols, dn, ds)
        next_wide = [
            cols[v]
            for v in sorted(keep, key=lambda v: (-comp[v], cols[v]))
            if is_wide(cols[v]) and cols[v] not in free
        ][:PLACEBO_POOL]
        out.append(
            {
                "day": d,
                "books": books,
                "next_wide": next_wide,
                "no_expiry": "0" not in (dn, ds),
                "expiry_rule": expiry.expiring_index(dn, ds) is not None,
            }
        )
    return {
        "cols": cols,
        "days": out,
        "split": period["split"] or days[len(days) // 2],
        "days_load_history_refused": gap_days,
    }


def counts(run: dict) -> dict:
    out = {}
    for arm in ARMS:
        changed = [r for r in run["days"] if set(r["books"][arm]) != set(r["books"]["FREE"])]
        out[arm] = {
            "changed_days": len(changed),
            "halves": [
                sum(r["day"] < run["split"] for r in changed),
                sum(r["day"] >= run["split"] for r in changed),
            ],
            "picks_replaced": sum(
                len(set(r["books"]["FREE"]) - set(r["books"][arm])) for r in changed
            ),
            "dir_changed_days": sum(
                {n for n in r["books"]["FREE"] if is_dir(n)}
                != {n for n in r["books"][arm] if is_dir(n)}
                for r in changed
            ),
        }
    return out


def drawdown(x: np.ndarray) -> dict:
    eq = np.cumsum(x)
    under = eq < np.maximum.accumulate(np.maximum(eq, 0.0))
    longest = run = 0
    for u in under:
        run = run + 1 if u else 0
        longest = max(longest, run)
    return {
        "mean": float(x.mean()),
        "median": float(np.median(x)),
        "total": float(x.sum()),
        "win_rate": float((x > 0).mean()),
        "max_drawdown": float(max_drawdown(x)),
        "longest_under_water": longest,
        "worst_day": float(x.min()),
        "worst_5_days": float(np.convolve(x, np.ones(5), "valid").min()),
    }


def read_gross(name: str, root: Path) -> dict[date, float]:
    with store.result_path(name, root).open() as f:
        return {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}


def evaluate(root: Path, run: dict) -> dict:
    cols, rows, split = run["cols"], run["days"], run["split"]
    col = {n: v for v, n in enumerate(cols)}
    with store.slipped(0.5):
        slip = store.load_matrix(cols, root)
    row_of = {d: i for i, d in enumerate(slip.days)}
    net = np.array([slip.values[row_of[r["day"]]] for r in rows])  # days x variants
    gross_by = {n: read_gross(n, root) for n in cols}

    def series(arm: str) -> np.ndarray:
        return np.array(
            [np.mean([net[t, col[n]] for n in r["books"][arm]]) for t, r in enumerate(rows)]
        )

    def traded(arm: str) -> np.ndarray:
        """The book's rupees with the Dir pick at 2 lots on days neither index expires."""
        return np.array(
            [
                sum(
                    net[t, col[n]] * (2 if is_dir(n) and r["no_expiry"] else 1)
                    for n in r["books"][arm]
                )
                for t, r in enumerate(rows)
            ]
        )

    half = np.array([1 if r["day"] < split else 2 for r in rows])
    parts_of = {"all": np.ones(len(rows), bool), "h1": half == 1, "h2": half == 2}
    free = series("FREE")
    free_stats = {p: drawdown(free[m]) for p, m in parts_of.items()}
    free_traded = traded("FREE")
    out: dict = {
        "days": len(rows),
        "from": rows[0]["day"].isoformat(),
        "to": rows[-1]["day"].isoformat(),
        "split": split.isoformat(),
        "days_load_history_refused": run["days_load_history_refused"],
        "counts": counts(run),
        "FREE": {
            "stats": free_stats,
            "traded": {p: drawdown(free_traded[m]) for p, m in parts_of.items()},
        },
    }
    for arm in ARMS:
        x = series(arm)
        changed = np.array([set(r["books"][arm]) != set(r["books"]["FREE"]) for r in rows])
        d = x - free
        m, lo, hi = block_bootstrap_mean(d[changed], RESAMPLES, BLOCK, SEED, LEVEL)
        halves = [float(d[changed & (half == h)].mean()) for h in (1, 2)]
        st = {p: drawdown(x[mask]) for p, mask in parts_of.items()}
        deeper = {
            p: st[p]["max_drawdown"] / free_stats[p]["max_drawdown"] - 1 for p in parts_of
        }  # < 0 = shallower
        return_pass = lo > 0 and min(halves) > 0 and deeper["all"] <= 0.10
        risk_parts = {
            p: deeper[p] <= -0.10
            and st[p]["mean"] >= 0.95 * free_stats[p]["mean"]
            and st[p]["worst_day"] >= free_stats[p]["worst_day"]
            for p in parts_of
        }
        enough = int(changed.sum()) >= MIN_CHANGED
        rng = np.random.default_rng(SEED)
        base = np.array([net[t] for t in range(len(rows))])
        placebo = np.tile(free, (PLACEBOS, 1))
        for t in np.flatnonzero(changed):
            r = rows[t]
            lost = sorted(set(r["books"]["FREE"]) - set(r["books"][arm]))
            pool = np.array([base[t, col[n]] for n in r["next_wide"]])
            picks = np.argsort(rng.random((PLACEBOS, pool.size)), axis=1)[:, : len(lost)]
            out_sum = sum(base[t, col[n]] for n in lost)
            placebo[:, t] += (pool[picks].sum(axis=1) - out_sum) / N_CORE
        pdd = np.array([max_drawdown(p) for p in placebo])
        pmean = placebo.mean(axis=1)
        out[arm] = {
            "stats": st,
            "traded": {p: drawdown(traded(arm)[mask]) for p, mask in parts_of.items()},
            "gross_mean": float(
                np.mean([np.mean([gross_by[n][r["day"]] for n in r["books"][arm]]) for r in rows])
            ),
            "minus_free_changed_days": {
                "days": int(changed.sum()),
                "mean": m,
                "lo": lo,
                "hi": hi,
                "halves": halves,
            },
            "minus_free_all_days_mean": float(d.mean()),
            "drawdown_change": deeper,
            "placebo": {
                "share_drawdown_at_least_as_shallow": float(
                    (pdd >= st["all"]["max_drawdown"] - 1e-9).mean()
                ),
                "share_mean_at_least_as_high": float((pmean >= x.mean() - 1e-9).mean()),
                "median_max_drawdown": float(np.median(pdd)),
                "median_mean": float(np.median(pmean)),
            },
            "return_pass": bool(enough and return_pass),
            "risk_pass": bool(enough and all(risk_parts.values())),
            "risk_parts": {p: bool(v) for p, v in risk_parts.items()},
            "hurts": bool(hi < 0),
        }
    return out


def show(label: str, s: dict) -> None:
    print(f"\n=== {label}: {s['days']} days {s['from']} to {s['to']}, split {s['split']} ===")
    print(f"  {'arm':10}{'chg':>5}{'mean':>7}{'total':>9}{'maxDD':>9}{'DD h1':>9}{'DD h2':>9}"
          f"{'under':>6}{'worst':>8}{'worst5':>8}")  # fmt: skip
    for arm in ("FREE", *ARMS):
        st = s[arm]["stats"]
        a = st["all"]
        chg = "" if arm == "FREE" else s["counts"][arm]["changed_days"]
        print(f"  {arm:10}{chg:>5}{a['mean']:>7.0f}{a['total']:>9.0f}{a['max_drawdown']:>9.0f}"
              f"{st['h1']['max_drawdown']:>9.0f}{st['h2']['max_drawdown']:>9.0f}"
              f"{a['longest_under_water']:>6}{a['worst_day']:>8.0f}{a['worst_5_days']:>8.0f}")  # fmt: skip
    for arm in ARMS:
        v = s[arm]
        g = v["minus_free_changed_days"]
        print(f"  {arm}: arm - FREE on {g['days']} changed days {g['mean']:.0f} [{g['lo']:.0f}, "
              f"{g['hi']:.0f}] halves {g['halves'][0]:.0f} / {g['halves'][1]:.0f}; drawdown change "
              + ", ".join(f"{p} {c:+.0%}" for p, c in v["drawdown_change"].items())
              + f"; placebo DD as shallow {v['placebo']['share_drawdown_at_least_as_shallow']:.0%}; "
              f"return {v['return_pass']} risk {v['risk_pass']} hurts {v['hurts']}")  # fmt: skip
    print("  Dir x2 sizing (book rupees): " + "; ".join(
        f"{arm} mean {s[arm]['traded']['all']['mean']:.0f} DD {s[arm]['traded']['all']['max_drawdown']:.0f}"
        for arm in ("FREE", *ARMS)))  # fmt: skip


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", choices=sorted(PERIODS), required=True)
    ap.add_argument("--counts", action="store_true", help="changed days only, no P&L")
    args = ap.parse_args()
    period = PERIODS[args.period]
    root = data_dir()
    pools = {"t1": [*variant_names(), *track_names("t1")], "core": variant_names()}
    if args.period == "old":  # BL-214's store holds NIFTY only
        pools = {k: [n for n in v if n.startswith("N_")] for k, v in pools.items()}
    report: dict = {"period": args.period, "seed": SEED, "interval": LEVEL}
    for label, names in pools.items():
        run = select_days(root, names, period, fallback=args.period == "old")
        if args.counts:
            print(label, len(run["days"]), "days;", run["days_load_history_refused"], "refused;")
            print(" ", json.dumps(counts(run)))
            continue
        report[label] = evaluate(root, run)
        show(f"{label} ({len(names)} strategies)", report[label])
        (HERE / "out").mkdir(exist_ok=True)
        with (HERE / "out" / f"books_{args.period}_{label}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["day", *run["days"][0]["books"]])
            for r in run["days"]:
                w.writerow([r["day"], *(" ".join(b) for b in r["books"].values())])
    if not args.counts:
        (HERE / f"results_{args.period}.json").write_text(json.dumps(report, indent=1) + "\n")


if __name__ == "__main__":
    main()
