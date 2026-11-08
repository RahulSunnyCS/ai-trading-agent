"""BL-216: a range-band fit in list C's composite, replayed on T1 and Core (Phase 0 in the item).

Each day D, every variant gets `skewed_fit` over the earlier days whose last-5 range band (calm / mid /
wide, by its own index) equals D's; arms R20 / R10 blend its percentile into list C's composite at 20 / 10 %.
Picks day by day from the unslipped stored results; money = each pick at one lot, net after 0.5 % slippage.
Reads the live store and the lake, writes only `range_fit_<stamp>.json` beside itself.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl216/range_fit.py
"""

from __future__ import annotations

import json
from bisect import bisect_left
from datetime import date
from pathlib import Path

import duckdb
import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import expiry, journal, sl150_cap, store
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown
from option_backtesting.rotation.score import (
    composite,
    dte_matrix,
    family_index,
    pct_rank,
    select,
    skewed_fit,
)
from option_backtesting.rotation.variants import track_names, underlying_of, variant_names

HERE = Path(__file__).parent
LST = LISTS["C"]
ARMS = {"base": 0.0, "R20": 0.20, "R10": 0.10}
PRIMARY = "R20"
LAST5, CUT_SESSIONS = 5, 250
SLIP = 0.5
SEED = 20261108
WINDOWS = {
    "2y": (date(2025, 1, 10), date(2026, 11, 6)),
    "1y": (date(2025, 11, 7), date(2026, 11, 6)),
}
JOURNAL_FROM = {"core": date(2026, 10, 12), "t1": date(2026, 10, 19)}
AGREE_MIN = 0.90
DD_SLACK = 1.10


def index_ranges(root: Path) -> dict[str, dict[date, float]]:
    """{index: {session: (high - low) / open * 100}} over 09:17-15:29 from the lake's 1-minute bars."""
    c = duckdb.connect()
    c.execute("SET TimeZone='Asia/Kolkata'")
    out = {}
    for sym in ("NIFTY", "SENSEX"):
        glob = root / "lake" / "bars_1m" / "asset=index" / f"symbol={sym}" / "date=*" / "*.parquet"
        rows = c.sql(
            f"""select cast(ts as date) d, arg_min(open, ts) o, max(high) h, min(low) l
            from read_parquet('{glob}', hive_partitioning=true)
            where hour(ts) * 60 + minute(ts) between 9 * 60 + 17 and 15 * 60 + 29
            group by d order by d"""
        ).fetchall()
        out[sym] = {d: (h - lo) / o * 100 for d, o, h, lo in rows if o}
    return out


def band_of(rng: dict[date, float], day: date) -> str:
    """calm / mid / wide for `day` from the sessions before it only."""
    sess = sorted(s for s in rng if s < day)
    vals = np.array([rng[s] for s in sess])
    k = len(sess)
    if k < LAST5 + CUT_SESSIONS:
        return "unknown"
    last5 = np.array([vals[j - LAST5 : j].mean() for j in range(k - CUT_SESSIONS, k + 1)])
    today, past = last5[-1], last5[:-1]
    q1, q2 = np.quantile(past, [1 / 3, 2 / 3])
    return "calm" if today <= q1 else "wide" if today > q2 else "mid"


def bands(rng: dict[date, float], days: list[date]) -> list[str]:
    """band_of for many days in one pass; the look-ahead check compares it with band_of."""
    sess = sorted(rng)
    vals = np.array([rng[s] for s in sess])
    l5 = np.full(len(sess) + 1, np.nan)  # l5[k] = mean of sessions k-5..k-1
    for k in range(LAST5, len(sess) + 1):
        l5[k] = vals[k - LAST5 : k].mean()
    out = []
    for d in days:
        k = bisect_left(sess, d)
        if k < LAST5 + CUT_SESSIONS:
            out.append("unknown")
            continue
        past = l5[k - CUT_SESSIONS : k]
        q1, q2 = np.quantile(past, [1 / 3, 2 / 3])
        out.append("calm" if l5[k] <= q1 else "wide" if l5[k] > q2 else "mid")
    return out


def replay(book: str, root: Path, rng: dict[str, dict[date, float]]) -> dict:
    names = variant_names() + (track_names("t1") if book == "t1" else [])
    with store.slipped(0.0):
        m = store.load_matrix(names, root)
    with store.slipped(SLIP):
        ms = store.load_matrix(names, root)
    assert list(ms.names) == list(m.names) and ms.days == m.days
    attrs = store.read_days(root, "weekdays")
    keep = [i for i, d in enumerate(m.days) if d in attrs]
    days = [m.days[i] for i in keep]
    cols = list(m.names)
    P, PS = m.values[keep], ms.values[keep]
    col = {n: j for j, n in enumerate(cols)}

    weekday = np.array([attrs[d]["weekday"] for d in days])
    vband = np.array([attrs[d]["vix_band"] for d in days])
    dmat = dte_matrix(
        np.array([attrs[d]["dte_n"] for d in days]),
        np.array([attrs[d]["dte_s"] for d in days]),
        cols,
    )
    fam = family_index(cols)
    rb = {s: np.array(bands(rng[s], days)) for s in rng}
    for s in rng:  # look-ahead check: the one-pass bands equal the cut-to-the-day ones
        for d, b in zip(days, rb[s], strict=True):
            assert b == band_of(rng[s], d), (s, d)
    nifty = np.array([underlying_of(n) == "NIFTY" for n in cols])
    rmat = np.where(nifty[None, :], rb["NIFTY"][:, None], rb["SENSEX"][:, None])

    picks: dict[str, dict[date, list[str]]] = {a: {} for a in ARMS}
    for i, d in enumerate(days):
        if i < WARMUP:
            continue
        Pv = np.vstack([P[:i], np.zeros((1, len(cols)))])
        base = composite(Pv, weekday[: i + 1], vband[: i + 1], dmat[: i + 1], cols, LST, fam)
        fit = pct_rank(skewed_fit(Pv, rmat[: i + 1] == rmat[i][None, :], i, LST.lookbacks))
        dte = {"dte_n": attrs[d]["dte_n"], "dte_s": attrs[d]["dte_s"]}
        idx = expiry.rule_index(d, dte)
        cap = sl150_cap.applies(d, dte["dte_n"])
        for arm, w in ARMS.items():
            comp = (1 - w) * base + w * fit
            p = select(comp, cols)
            if idx:
                p = expiry.filter_picks(comp, cols, p, idx)
            elif cap:
                p = sl150_cap.cap_picks(comp, cols, p)
            picks[arm][d] = list(p.core) + list(p.buy)

    # the base arm against the journal's recorded list C
    track = "t1" if book == "t1" else None
    rec = {
        date.fromisoformat(e["day"]): list(e["lists"]["C"]["core"])
        + list(e["lists"]["C"].get("buy") or [])
        for e in journal.read(store.journal_path(root, track))
    }
    checked = [d for d in picks["base"] if d >= JOURNAL_FROM[book] and d in rec]
    mism = [
        {"day": str(d), "replay": picks["base"][d], "journal": rec[d]}
        for d in checked
        if sorted(picks["base"][d]) != sorted(rec[d])
    ]
    agree = 1 - len(mism) / len(checked) if checked else float("nan")

    row = {d: i for i, d in enumerate(days)}
    net = {
        a: {d: float(sum(PS[row[d], col[n]] for n in ps)) for d, ps in picks[a].items()}
        for a in ARMS
    }
    out = {
        "variants": len(cols),
        "band_counts": {
            s: {b: int((rb[s] == b).sum()) for b in ("calm", "mid", "wide", "unknown")} for s in rb
        },
        "journal_check": {"days": len(checked), "agree": agree, "mismatches": mism},
        "windows": {},
    }
    for wname, (lo, hi) in WINDOWS.items():
        ds = [d for d in sorted(net["base"]) if lo <= d <= hi]
        b = np.array([net["base"][d] for d in ds])
        w = {"days": len(ds), "from": str(ds[0]), "to": str(ds[-1]), "arms": {}}
        for a in ARMS:
            x = np.array([net[a][d] for d in ds])
            stats = {
                "total": float(x.sum()),
                "mean": float(x.mean()),
                "win": float((x > 0).mean()),
                "worst": float(x.min()),
                "max_dd": max_drawdown(x),
            }
            if a != "base":
                mean, lo_, hi_ = block_bootstrap_mean(x - b, seed=SEED)
                stats["diff"] = {"mean": mean, "lo": lo_, "hi": hi_}
                stats["days_changed"] = float(
                    np.mean([sorted(picks[a][d]) != sorted(picks["base"][d]) for d in ds])
                )
            w["arms"][a] = stats
        out["windows"][wname] = w
    two, one = out["windows"]["2y"]["arms"], out["windows"]["1y"]["arms"]
    p = two[PRIMARY]
    out["verdict"] = {
        "lower_bound_2y_above_0": p["diff"]["lo"] > 0,
        "mean_1y_above_0": one[PRIMARY]["diff"]["mean"] > 0,
        "dd_within_10pct": p["max_dd"] >= DD_SLACK * two["base"]["max_dd"],
    }
    out["verdict"]["pass"] = all(out["verdict"].values())
    return out


def main() -> None:
    root = data_dir()
    rng = index_ranges(root)
    res = {"stamp": date.today().isoformat(), "books": {}}
    for book in ("t1", "core"):
        r = replay(book, root, rng)
        res["books"][book] = r
        jc = r["journal_check"]
        print(f"{book}: journal check {jc['days']} days, agree {jc['agree']:.0%}")
        if jc["agree"] < AGREE_MIN:
            print(json.dumps(jc["mismatches"], indent=1))
            raise SystemExit("base arm does not reproduce the journal: stopping before any result")
    for book, r in res["books"].items():
        for wname, w in r["windows"].items():
            for a, s in w["arms"].items():
                extra = ""
                if "diff" in s:
                    dd = s["diff"]
                    extra = f" | diff {dd['mean']:+.0f} [{dd['lo']:+.0f}, {dd['hi']:+.0f}] changed {s['days_changed']:.0%}"
                print(
                    f"{book:4s} {wname} {a:4s} n={w['days']} total {s['total']:+,.0f} avg {s['mean']:+.0f} "
                    f"win {s['win']:.0%} worst {s['worst']:+,.0f} dd {s['max_dd']:+,.0f}{extra}"
                )
        print(book, "verdict", r["verdict"])
    path = HERE / f"range_fit_{res['stamp']}.json"
    path.write_text(json.dumps(res, indent=1, default=str))
    print("wrote", path)


if __name__ == "__main__":
    main()
