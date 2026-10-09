"""BL-057: daily four-criteria rotation over the 66 NIFTY + SENSEX start-time variants.

Rule, comparators and pass/kill as pre-registered in
backlog/BL-057-daily-four-criteria-rotation.md. Do not edit after a result is seen.

    uv run --with pandas --with numpy --with duckdb python research/bl057/rotate.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl056"))
sys.path.insert(0, str(HERE.parent / "common"))
import analyse as A  # noqa: E402  (day_features, load, VIX bands, WD)
import varlib  # noqa: E402  (live_csv: the comparator inputs)

WINDOW_FROM = "2025-09-01"
WARMUP = 63
LOOKBACKS = [(5, 0.4), (21, 0.3), (63, 0.3)]
W_CRIT = {"recent": 0.33, "weekday": 0.25, "dte": 0.25, "vix": 0.17}
BUY_TOP = 10


# Named baskets (BL-064): `--basket DRB-6W2` = the whole-day Daily Ranked Basket, 6 core lots, at least
# 2 Widesl, up to 2 Buy. DRB-<core lots>W<minimum Widesl>; DRB-5W2 is the BL-062 run.
# DRB-6W2L2 = the same 6 core lots as 3 strategies of 2 lots each (BL-065).
BASKETS = {
    f"DRB-{core}W{wide}" + (f"L{per}" if per > 1 else ""): [
        "--whole-day",
        "--core",
        str(core),
        "--min-wide",
        str(wide),
        "--buy-max",
        "2",
        "--lots-per",
        str(per),
    ]
    for core in (3, 4, 5, 6, 7, 8)
    for wide in (0, 1, 2, 3, 4)
    for per in (1, 2, 3)
    if core % per == 0
}
if "--basket" in sys.argv:
    _i = sys.argv.index("--basket")
    _name = sys.argv[_i + 1].upper()
    if _name not in BASKETS:
        raise SystemExit(
            f"unknown basket {_name}; choose from DRB-<3..8>W<0..4>[L<2|3>], e.g. DRB-6W2L2"
        )
    sys.argv[_i : _i + 2] = BASKETS[_name]


def _arg(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


CORE = _arg("--core", 5)  # 5 = first block; 3 = small-book block
BUY_MAX = _arg("--buy-max", 2)  # 2 = first block; 1 = small-book block
LOTS_PER = _arg("--lots-per", 1)  # BL-065: lots traded in each picked strategy (1 = one lot each)
assert CORE % LOTS_PER == 0, "--core must be a multiple of --lots-per"
N_CORE = CORE // LOTS_PER  # core strategies a day
N_BUY = max(1, BUY_MAX // LOTS_PER)  # Buy strategies a day (2 Buy lots = 1 Buy strategy of 2 lots)
N_RUNS, SEED = 1000, 57
# BL-061: add the closest-premium Widesl (NIFTY 80 / 100, SENSEX 250 / 320) to the candidate list
WHOLE_DAY = "--whole-day" in sys.argv  # BL-062: every start time 09:17..15:17 (248 variants)
# BL-065 (second block): drop the closest-premium Widesl from the list, leaving the OTM-strike
# Widesl, Dir and Buy (148 variants whole-day)
NO_CLOSEST = "--no-closest" in sys.argv
CLOSEST = ("--closest" in sys.argv or WHOLE_DAY) and not NO_CLOSEST
CLOSEST_FAMILIES = ("p80", "p100", "p250", "p320")
# BL-065 (third block): `--prefilter 25` keeps, in each family (Widesl incl. closest-premium, Dir,
# Buy), the top 25% of variants by total P&L, winning-day % and max drawdown over the warm-up days
# only (the 63 days before the first selection day); the pool is fixed after that
PREFILTER = _arg("--prefilter", 0)
# BL-065 (fourth block): `--prefilter-window 42` re-ranks the families every selection day on the
# trailing 42 sessions (2 months) instead of fixing the pool on the warm-up days
PREFILTER_WINDOW = _arg("--prefilter-window", 0)
# BL-065 (fifth block): `--grid 30` keeps only the start times on a 30-minute grid from 09:17
# (09:17, 09:47, ... 15:17): half the whole-day list, 128 variants
GRID = _arg("--grid", 0)
# BL-067: `--weights R,W,D,V` overrides the criteria weights (recent, weekday, days to expiry, VIX
# band; whole percents summing to 100). Unset = the BL-057 weights 33/25/25/17
WEIGHTS = None
# BL-068: controls on the "recent" criterion and a placebo on the fit labels.
#   --recent-window N   recent = plain sum of the last N days (unset: 2/3 x last 5 + 1/3 x the 5 before)
#   --recent-lag L      recent reads the window ending L days before the day (skips the latest L days)
#   --reverse           pick the LOWEST composite instead of the highest (bottom-ranked basket)
#   --shuffle-labels S  permute the days' weekday / VIX band / days-to-expiry labels with seed S
RECENT_WINDOW = _arg("--recent-window", 0)
RECENT_LAG = _arg("--recent-lag", 0)
REVERSE = "--reverse" in sys.argv
SHUFFLE = _arg("--shuffle-labels", -1)
if "--weights" in sys.argv:
    WEIGHTS = tuple(int(x) for x in sys.argv[sys.argv.index("--weights") + 1].split(","))
    assert len(WEIGHTS) == 4 and sum(WEIGHTS) == 100, WEIGHTS
    W_CRIT = {k: w / 100 for k, w in zip(W_CRIT, WEIGHTS, strict=True)}


def on_grid(name: str) -> bool:
    """True when the variant's start time lies on the --grid minute grid from 09:17."""
    if not GRID:
        return True
    tag = name.split("_")[2]
    minutes = int(tag[:2]) * 60 + int(tag[2:]) - (9 * 60 + 17)
    return minutes % GRID == 0
# Case A's Widesl minimum: 2 is the first pre-registered block; 3 is the later block (BL-057).
MIN_WIDE = int(sys.argv[sys.argv.index("--min-wide") + 1]) if "--min-wide" in sys.argv else 2
MIN_WIDE_N = -(-MIN_WIDE // LOTS_PER)  # the minimum in whole strategies, rounded up


def read_net(path) -> pd.Series:
    return pd.read_csv(path, parse_dates=["day"]).set_index("day").net


def whole_day_columns(underlying: str, pfx: str) -> pd.DataFrame:
    """BL-062: every variant of one index at the 25 start times 09:17..15:17: Widesl, Dir and Buy
    (no Buy at 15:17: it exits 15:14) with the OTM strike, and the closest-premium Widesl (NIFTY 80 /
    100, SENSEX 250 / 320). Per-day results come from the folder of the item that ran each start time."""
    research = HERE.parent
    nifty = underlying == "NIFTY"
    morning = research / ("bl054" if nifty else "bl056") / "results"
    premiums = () if NO_CLOSEST else ((80, 100) if nifty else (250, 320))
    cols = {}
    for slot in varlib.SLOTS_MORNING + varlib.SLOTS_LATE + [varlib.SLOT_LAST]:
        tag = slot.replace(":", "")
        early, last = slot in varlib.SLOTS_MORNING, slot == varlib.SLOT_LAST
        for fam in ("wide", "dir", "buy"):
            if fam == "buy" and last:
                continue
            folder = morning if early else research / ("bl062" if last else "bl059") / "results"
            name = f"{fam}_{tag}.csv" if early else f"{pfx}{fam}_{tag}.csv"
            cols[f"{pfx}{fam}_{tag}"] = read_net(folder / name)
        for premium in premiums:
            if early:
                path = (
                    research / ("bl061" if nifty else "bl060") / "results" / f"p{premium}_{tag}.csv"
                )
            elif last or nifty:
                path = research / "bl062" / "results" / f"{pfx}p{premium}_{tag}.csv"
            else:
                path = research / "bl060" / "results" / f"p{premium}_{tag}.csv"
            cols[f"{pfx}p{premium}_{tag}"] = read_net(path)
    df = pd.DataFrame(cols).sort_index()
    assert not df.isna().any().any(), f"{underlying}: whole-day variants do not cover the same days"
    return df


def closest_columns(underlying: str, pfx: str, days: pd.DatetimeIndex) -> pd.DataFrame:
    """Per-day net P&L of the closest-premium Widesl variants of one index at the 11 morning start
    times: NIFTY 80 / 100 (research/bl061) or SENSEX 250 / 320 (research/bl060)."""
    folder, premiums = ("bl061", (80, 100)) if underlying == "NIFTY" else ("bl060", (250, 320))
    cols = {}
    for premium in premiums:
        for slot in varlib.SLOTS_MORNING:
            tag = slot.replace(":", "")
            path = HERE.parent / folder / "results" / f"p{premium}_{tag}.csv"
            cols[f"{pfx}p{premium}_{tag}"] = varlib.require(
                path,
                f"cd packages/option-backtesting && uv run python research/{folder}/gen_variants.py && "
                f"uv run python research/{folder}/run_variant.py research/{folder}/variants/p{premium}_{tag}.yaml",
            ).reindex(days)
    return pd.DataFrame(cols, index=days)


def load_all():
    frames, feats = [], {}
    for u, pfx in (("NIFTY", "N_"), ("SENSEX", "S_")):
        df = whole_day_columns(u, pfx) if WHOLE_DAY else A.load(u)
        df = df[df.index >= pd.Timestamp(WINDOW_FROM)]
        f = A.day_features(u, df.index)
        wk = f.weekday.isin(A.WD).values
        df, f = df[wk], f[wk]
        if not WHOLE_DAY:
            df.columns = [pfx + c for c in df.columns]
        if CLOSEST and not WHOLE_DAY:
            df = df.join(closest_columns(u, pfx, df.index))
        frames.append(df)
        feats[u] = f
    # keep only the days both indices have (two days each side are missing one index's data)
    common = frames[0].index.intersection(frames[1].index)
    dropped = sorted(set(frames[0].index.symmetric_difference(frames[1].index)).difference(common))
    print("days in one index only, dropped:", [d.strftime("%d-%b-%y") for d in dropped])
    frames = [x.loc[common] for x in frames]
    feats = {u: x.loc[common] for u, x in feats.items()}
    P = pd.concat(frames, axis=1)
    expected = (148 if NO_CLOSEST else 248) if WHOLE_DAY else (110 if CLOSEST else 66)
    assert P.shape[1] == expected and not P.isna().any().any(), (P.shape[1], expected)
    assert feats["NIFTY"].index.equals(feats["SENSEX"].index)
    f = feats["NIFTY"][["weekday", "vix_band"]].copy()
    f["dte_N"] = feats["NIFTY"].dte_label
    f["dte_S"] = feats["SENSEX"].dte_label
    return P, f


def skewed_fit(P: np.ndarray, match: np.ndarray, i: int) -> np.ndarray:
    """P: days x variants; match: days x variants bool (day's attribute == day i's attribute,
    per variant); average P&L on matching days in the last 5 / 21 / 63 days, weights 40/30/30
    renormalised over the windows that have a matching day."""
    num = np.zeros(P.shape[1])
    den = np.zeros(P.shape[1])
    for n, w in LOOKBACKS:
        m = match[i - n : i]
        cnt = m.sum(axis=0)
        avg = np.where(cnt > 0, (P[i - n : i] * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
        num += w * avg * (cnt > 0)
        den += w * (cnt > 0)
    return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)


def pct_rank(x: np.ndarray) -> np.ndarray:
    return pd.Series(x).rank(pct=True, method="average").to_numpy()


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def variant_masks(names):
    """(is_wide, is_dir, is_buy, is_nifty) boolean arrays over the variants; is_wide includes the
    closest-premium Widesl (BL-061), which count toward the minimum number of Widesl."""
    fam = [n.split("_")[1] for n in names]
    return (
        np.array([x == "wide" or x in CLOSEST_FAMILIES for x in fam]),
        np.array([x == "dir" for x in fam]),
        np.array([x == "buy" for x in fam]),
        np.array([n.startswith("N_") for n in names]),
    )


def pool_mask(window: np.ndarray, names, pct: int, verbose: str = "") -> np.ndarray:
    """True for the top `pct` % of each family (Widesl incl. closest-premium, Dir, Buy) ranked on the
    rows of `window` (days x variants): the mean of the within-family percentile ranks of total P&L,
    winning-day % and max drawdown (shallower ranks higher). Rounded up: a family of 50 keeps 13 at 25%."""
    fam = pd.Series(
        ["wide" if n.split("_")[1] in CLOSEST_FAMILIES else n.split("_")[1] for n in names],
        index=list(names),
    )
    stats = pd.DataFrame(
        {
            "total": window.sum(axis=0),
            "win": (window > 0).mean(axis=0),
            "mdd": [mdd(window[:, v]) for v in range(window.shape[1])],
        },
        index=list(names),
    )
    keep = set()
    for f in ("wide", "dir", "buy"):
        s = stats[fam == f]
        score = s.rank(pct=True).mean(axis=1)  # every column: higher is better (mdd is <= 0)
        n = -(-len(s) * pct // 100)
        chosen = score.sort_values(ascending=False).index[:n]
        keep.update(chosen)
        if verbose:
            print(f"prefilter {f}: {n} of {len(s)} kept on {verbose} -> " + ", ".join(chosen))
    return np.array([n in keep for n in names])


def prefilter(P: pd.DataFrame, pct: int) -> pd.DataFrame:
    """The pool fixed once on the first WARMUP days (BL-065 third block)."""
    mask = pool_mask(P.iloc[:WARMUP].to_numpy(), P.columns, pct, f"the {WARMUP} warm-up days")
    return P[P.columns[mask]]


def masked_composite(crit, allowed: np.ndarray) -> np.ndarray:
    """The composite scored within the pool only (percentile ranks over the allowed variants);
    -inf outside it, so select_picks never chooses an excluded variant."""
    comp = np.full(len(allowed), -np.inf)
    comp[allowed] = sum(W_CRIT[k] * pct_rank(crit[k][allowed]) for k in W_CRIT)
    return comp


def closest_mask(names):
    """True for the closest-premium Widesl variants (names like N_p80_0917)."""
    return np.array([n.split("_")[1] in CLOSEST_FAMILIES for n in names])


def day_inputs(f, names):
    """Per-day attribute arrays for score_day: weekday and VIX band (one per day) and days to
    expiry (days x variants: each variant uses its own index's)."""
    is_nifty = variant_masks(names)[3]
    wd = f.weekday.to_numpy()
    vb = f.vix_band.astype(str).to_numpy()
    dte = np.where(is_nifty[None, :], f.dte_N.to_numpy()[:, None], f.dte_S.to_numpy()[:, None])
    return wd, vb, dte


def recent_score(Pv: np.ndarray, i: int) -> np.ndarray:
    """The recent criterion for the day at row i: 2/3 x the last 5 days + 1/3 x the 5 before (BL-057),
    or the plain sum of the last RECENT_WINDOW days; both end RECENT_LAG days before the day."""
    end = i - RECENT_LAG
    if RECENT_WINDOW:
        return Pv[end - RECENT_WINDOW : end].sum(axis=0)
    return (2 / 3) * Pv[end - 5 : end].sum(axis=0) + (1 / 3) * Pv[end - 10 : end - 5].sum(axis=0)


def score_day(Pv, wd, vb, dte, i):
    """The four criteria and the composite for the day at row i.

    Look-ahead: only rows before i of Pv are read; row i contributes its own weekday, VIX band
    and days to expiry (known before the first entry). Pv[i] itself is never used, so a caller
    scoring a day that has no results yet can pass a zero row there."""
    crit = {
        "recent": recent_score(Pv, i),
        "weekday": skewed_fit(Pv, (wd[:, None] == wd[i]).repeat(Pv.shape[1], axis=1), i),
        "dte": skewed_fit(Pv, dte == dte[i][None, :], i),
        "vix": skewed_fit(Pv, (vb[:, None] == vb[i]).repeat(Pv.shape[1], axis=1), i),
    }
    comp = sum(W_CRIT[k] * pct_rank(crit[k]) for k in W_CRIT)
    return crit, (-comp if REVERSE else comp)


def select_picks(comp, names, masks, min_wide=None, core=None, buy_max=None):
    """(core_a, core_b, buy, overridden): the top `core` Widesl/Dir variants, case A with at
    least `min_wide` Widesl (lowest-scoring Dir swapped for the next-best Widesl), case B with no
    minimum, plus up to `buy_max` Buy variants that are in the overall top BUY_TOP.
    Defaults are the module settings (--min-wide / --core / --buy-max / --lots-per), counted in
    strategies: with 2 lots per strategy a core of 6 lots is 3 strategies."""
    min_wide = MIN_WIDE_N if min_wide is None else min_wide
    core = N_CORE if core is None else core
    buy_max = N_BUY if buy_max is None else buy_max
    is_wide, is_dir, is_buy, _ = masks
    pool = np.where(~is_buy & np.isfinite(comp))[0]  # -inf = outside the day's pool
    order = sorted(pool, key=lambda v: (-comp[v], names[v]))
    core_b = order[:core]
    core_a = list(core_b)
    overridden = False
    n_wide = int(is_wide[core_a].sum())
    if n_wide < min_wide:
        overridden = True
        spare = [v for v in order if is_wide[v] and v not in core_a]
        while n_wide < min_wide:
            drop = min((v for v in core_a if is_dir[v]), key=lambda v: (comp[v], names[v]))
            core_a.remove(drop)
            core_a.append(spare.pop(0))
            n_wide += 1
    top = sorted(np.where(np.isfinite(comp))[0], key=lambda v: (-comp[v], names[v]))[:BUY_TOP]
    buy = [v for v in top if is_buy[v]][:buy_max]
    return core_a, core_b, buy, overridden


START_WINDOWS = ["09:17-09:47", "10:02-10:47", "11:02-11:47", "12:02-13:47", "14:02-15:17"]


def start_window(slot: str) -> str:
    for label, edge in zip(START_WINDOWS[:-1], ("10:02", "11:02", "12:02", "14:02"), strict=True):
        if slot < edge:
            return label
    return START_WINDOWS[-1]


def closest_report(picks_a, names, Pv, wd, vb, dte, days):
    """BL-061: how much of the daily core the closest-premium Widesl take, and on which days."""
    is_closest = closest_mask(names)
    is_wide, is_dir, _, is_nifty = variant_masks(names)
    rows = []
    for j, core in enumerate(picks_a):
        i = WARMUP + j
        for v in core:
            rows.append(
                dict(
                    day=days[i],
                    variant=names[v],
                    closest=bool(is_closest[v]),
                    widesl=bool(is_wide[v]),
                    index="NIFTY" if is_nifty[v] else "SENSEX",
                    weekday=wd[i],
                    dte=str(dte[i, v]),
                    vix=vb[i],
                    pnl=Pv[i, v],
                )
            )
    t = pd.DataFrame(rows)
    n_days = len(picks_a)
    pool = np.where(~variant_masks(names)[2])[0]
    base_core = is_closest[pool].mean()
    base_wide = is_closest[pool][is_wide[pool]].mean()
    print(
        f"\n=== BL-061: closest-premium Widesl in the daily core (case A), {n_days} selection days ==="
    )
    print(
        f"reference: closest-premium variants are {100 * base_core:.0f}% of the core candidates and "
        f"{100 * base_wide:.0f}% of the Widesl candidates, so a blind pick would give about those shares"
    )
    per_day = t.groupby("day").closest.sum()
    print(
        f"share of core lots: {100 * t.closest.mean():.0f}%  (average {t.closest.sum() / n_days:.2f} of {CORE} lots a day; "
        f"at least one on {int((per_day > 0).sum())} of {n_days} days = {100 * (per_day > 0).mean():.0f}%; "
        f"lots per day: {per_day.value_counts().sort_index().to_dict()})"
    )
    w = t[t.widesl]
    print(
        f"share of the Widesl lots: {100 * w.closest.mean():.0f}% closest premium, {100 * (1 - w.closest.mean()):.0f}% OTM strike "
        f"({len(w)} Widesl lots; Dir lots {int((~t.widesl).sum())})"
    )
    for label, col in (("index", "index"),):
        g = t.groupby(col).agg(lots=("closest", "size"), closest_share=("closest", "mean"))
        g["closest_share"] *= 100
        print(f"\nby {label} (share of that index's core lots that are closest premium, %):")
        print(g.round(0).to_string(float_format=lambda x: f"{x:,.0f}"))
    day_order = {"weekday": A.WD, "vix": A.VIX_LABELS + ["unknown"]}
    for label, col in (
        ("weekday", "weekday"),
        ("own index days to expiry (0 = expiry day)", "dte"),
        ("VIX band", "vix"),
    ):
        g = t.groupby(col).agg(
            days=("day", "nunique"), lots=("closest", "size"), closest_share=("closest", "mean")
        )
        wg = w.groupby(col).closest.mean()
        g["closest_share"] *= 100
        g["of Widesl lots %"] = 100 * wg
        order = day_order.get(col) or sorted(
            g.index, key=lambda x: 99 if x in ("7+", "unknown") else int(x)
        )
        g = g.reindex([o for o in order if o in g.index])
        print(f"\nby {label}:")
        print(g.round(0).to_string(float_format=lambda x: f"{x:,.0f}"))
    pl = t.assign(
        kind=np.where(
            t.closest, "closest-premium Widesl", np.where(t.widesl, "OTM Widesl", "Dir ATM")
        )
    )
    pl["slot"] = pl.variant.str.split("_").str[2].map(lambda x: f"{x[:2]}:{x[2:]}")
    pl["window"] = pl.slot.map(start_window)
    wins = [w_ for w_ in START_WINDOWS if w_ in set(pl.window)]
    share = pl.groupby(["window", "kind"]).size().unstack(fill_value=0).reindex(wins)
    total_lots = share.to_numpy().sum()
    print("\nshare of core lots by start-time window and strike rule (% of all core lots):")
    print((100 * share / total_lots).round(1).to_string(float_format=lambda x: f"{x:,.1f}"))
    print("  window totals:", {w_: f"{100 * share.loc[w_].sum() / total_lots:.0f}%" for w_ in wins})
    avg = pl.groupby(["window", "kind"]).pnl.mean().unstack().reindex(wins)
    print("average P&L per lot by start-time window and strike rule (1 lot, before charges):")
    print(avg.round(0).to_string(float_format=lambda x: f"{x:,.0f}"))
    g = pl.groupby("kind").agg(
        lots=("pnl", "size"),
        avg_pnl=("pnl", "mean"),
        win_pct=("pnl", lambda x: 100 * (x > 0).mean()),
    )
    print("\naverage P&L per lot when picked (1 lot, before charges):")
    print(g.round(0).to_string(float_format=lambda x: f"{x:,.0f}"))
    t.to_csv(HERE / "closest_core_lots.csv", index=False)


def main() -> None:
    P, f = load_all()
    if GRID:
        P = P[[c for c in P.columns if on_grid(c)]]
        print(f"grid {GRID} min from 09:17: {P.shape[1]} variants kept")
    if PREFILTER and not PREFILTER_WINDOW:
        P = prefilter(P, PREFILTER)
    names = list(P.columns)
    Pv = P.to_numpy()
    masks = variant_masks(names)
    is_wide, is_dir, is_buy, is_nifty = masks
    core_pool = np.where(~is_buy)[0]
    wd, vb, dte = day_inputs(f, names)
    if SHUFFLE >= 0:
        # placebo: every day keeps its P&L but takes another day's labels (one permutation for all
        # three, over every row including the warm-up)
        perm = np.random.default_rng(SHUFFLE).permutation(len(wd))
        wd, vb, dte = wd[perm], vb[perm], dte[perm]
        print(f"labels shuffled with seed {SHUFFLE}")
    days = P.index
    print(
        f"{len(names)} variants, {len(days)} weekdays {days[0].date()} -> {days[-1].date()}; selection from day {WARMUP + 1} = {days[WARMUP].date()}"
    )

    crit_names = list(W_CRIT)
    pers = {k: [] for k in crit_names + ["composite"]}
    picks_A, picks_B, buy_days, rows = [], [], [], []
    allowed_days = []  # per selection day: the variants in that day's pool
    for i in range(WARMUP, len(days)):
        crit, comp = score_day(Pv, wd, vb, dte, i)
        if PREFILTER and PREFILTER_WINDOW:
            # rolling pool: the top PREFILTER % of each family on the PREFILTER_WINDOW sessions
            # before this day (rows i-W .. i-1 only; never row i)
            allowed = pool_mask(Pv[i - PREFILTER_WINDOW : i], names, PREFILTER)
            comp = masked_composite(crit, allowed)
        else:
            allowed = np.ones(len(names), bool)
        allowed_days.append(allowed)
        today = Pv[i]
        for k in crit_names:
            pers[k].append(pd.Series(crit[k]).rank().corr(pd.Series(today).rank()))
        pers["composite"].append(pd.Series(comp).rank().corr(pd.Series(today).rank()))
        core_a, core_b, buy, overridden = select_picks(comp, names, masks)
        picks_A.append(core_a)
        picks_B.append(core_b)
        buy_days.append(buy)
        rows.append(
            dict(
                day=days[i],
                pnl_A=LOTS_PER * (today[core_a].sum() + today[buy].sum()),
                pnl_B=LOTS_PER * (today[core_b].sum() + today[buy].sum()),
                lots=LOTS_PER * (N_CORE + len(buy)),
                n_buy=len(buy),
                buy_pnl=LOTS_PER * today[buy].sum(),
                buy_alt=LOTS_PER
                * today[
                    [v for v in sorted(np.where(is_buy)[0], key=lambda v: -comp[v])][:N_BUY]
                ].sum(),
                wide_A=int(is_wide[core_a].sum()),
                wide_B=int(is_wide[core_b].sum()),
                nifty_A=int(is_nifty[core_a].sum()),
                overridden=overridden,
                changes_A=np.nan if len(picks_A) < 2 else len(set(core_a) ^ set(picks_A[-2])) / 2,
            )
        )
    R = pd.DataFrame(rows).set_index("day")
    sel = np.arange(WARMUP, len(days))
    today_all = Pv[sel]

    # comparators
    buy_lots = R.n_buy.to_numpy()
    # E and R draw from each day's pool (the whole list unless a rolling prefilter is on)
    day_pools = [np.where(m & ~is_buy)[0] for m in allowed_days]
    day_pools_b = [np.where(m & is_buy)[0] for m in allowed_days]
    E = np.array(
        [
            CORE * today_all[j, day_pools[j]].mean()
            + LOTS_PER * buy_lots[j] * today_all[j, day_pools_b[j]].mean()
            for j in range(len(sel))
        ]
    )
    b54 = HERE.parent / "bl054" / "results"
    live_w = varlib.live_csv(b54, "nifty_widesl_917_otm1")
    live_d = varlib.live_csv(b54, "nifty_dir_924_itm1_sl21_recost")
    # the live mix at this size (60 / 40 Widesl / Dir, rounded): 5 lots 3W+2D, 3 lots 2W+1D, 6 lots 4W+2D
    live_sizes = {3: (2, 1), 4: (2, 2), 5: (3, 2), 6: (4, 2), 7: (4, 3), 8: (5, 3)}
    nw, nd = live_sizes[CORE]
    B2 = (nw * live_w + nd * live_d).reindex(R.index).to_numpy()
    # a selection day missing from the live-strategy CSVs would make every comparison with B2 False
    assert not np.isnan(B2).any(), "live-mix CSVs do not cover every selection day"
    rng = np.random.default_rng(SEED)

    def random_total(min_wide: int):
        tot, dd = np.empty(N_RUNS), np.empty(N_RUNS)
        for r in range(N_RUNS):
            d = np.empty(len(sel))
            for j, i in enumerate(sel):
                while True:
                    ix = rng.choice(day_pools[j], N_CORE, replace=False)
                    if is_wide[ix].sum() >= min_wide:
                        break
                v = Pv[i, ix].sum()
                if buy_lots[j]:
                    v += Pv[i, rng.choice(day_pools_b[j], buy_lots[j], replace=False)].sum()
                d[j] = LOTS_PER * v
            tot[r], dd[r] = d.sum(), mdd(d)
        return tot, dd

    def stats(s):
        s = np.asarray(s)
        wk = pd.Series(s, index=R.index).groupby(R.index.to_period("W")).sum()
        return dict(
            total=s.sum(),
            avg_day=s.mean(),
            win_pct=100 * (s > 0).mean(),
            maxDD=mdd(s),
            worst_day=s.min(),
            worst_wk=wk.min(),
        )

    lots_avg = R.lots.mean()
    print(
        f"\nselection days: {len(R)}; Buy add-on fired on {int((R.n_buy > 0).sum())} days "
        f"({int((R.n_buy == 1).sum())} with 1 lot, {int((R.n_buy == 2).sum())} with 2); lots/day avg {lots_avg:.2f}"
    )
    print("per-lot-day = avg/day divided by that line's avg lots/day")
    label_a = (
        f"A (>={MIN_WIDE} Widesl lots = {MIN_WIDE_N} strategies)"
        if LOTS_PER > 1
        else f"A (>={MIN_WIDE} Widesl)"
    )
    cases = [(label_a, "pnl_A", MIN_WIDE_N)]
    if MIN_WIDE_N > 0:  # with no minimum, case B is case A: do not simulate the baseline twice
        cases.append(("B (no minimum)", "pnl_B", 0))
    for case, col, min_w in cases:
        tot, dd = random_total(min_w)
        S = pd.DataFrame(
            {
                f"ROTATION case {case}": stats(R[col]),
                "E equal-weight": stats(E),
                f"B live {nw}xW917+{nd}xD924 ({CORE} lots)": stats(B2),
            }
        ).T
        S["lots/day"] = [lots_avg, lots_avg, CORE]
        S["per-lot-day"] = S.avg_day / S["lots/day"]
        print(
            f"\n{'=' * 100}\nCASE {case}{'   <- VERDICT CASE' if min_w == MIN_WIDE_N else '   (reported only)'}\n{'=' * 100}"
        )
        print(S.to_string(float_format=lambda x: f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"))
        p90, p50 = np.percentile(tot, 90), np.percentile(tot, 50)
        total = R[col].sum()
        d = mdd(R[col])
        c1 = total >= p90
        c2 = total > E.sum() and d >= mdd(E)
        c3 = total > B2.sum() and d >= mdd(B2)
        print(
            f"R random (n={N_RUNS}): total P50 {p50:,.0f} | P90 {p90:,.0f} | max {tot.max():,.0f}; maxDD P50 {np.percentile(dd, 50):,.0f}; "
            f"rotation beats {100 * (tot < total).mean():.0f}% of random runs"
        )
        print(
            f"(1) total >= R P90: {c1} | (2) beats E on total and DD: {c2} | (3) beats B2 on total and DD: {c3}"
        )
        if min_w == MIN_WIDE_N:
            print(
                "VERDICT:", "PASS" if (c1 and c2 and c3) else ("KILL" if not c1 else "INCONCLUSIVE")
            )

    print(
        "\n--- signal in each criterion: Spearman(criterion rank, same-day P&L) across the variants, averaged over selection days ---"
    )
    for k, v in pers.items():
        v = np.array(v)
        print(
            f"  {k:10s} mean {np.nanmean(v):+.3f}   positive on {100 * np.nanmean(v > 0):.0f}% of days"
        )
    print(
        f"\n--- picks: case A Widesl count per day {R.wide_A.value_counts().sort_index().to_dict()}, override fired {int(R.overridden.sum())} days; "
        f"case B Widesl count {R.wide_B.value_counts().sort_index().to_dict()}"
    )
    print(
        f"    NIFTY share of core picks (case A): {100 * R.nifty_A.sum() / (N_CORE * len(R)):.0f}%; "
        f"core members changed per day (case A): avg {R.changes_A.mean():.2f} of {N_CORE}"
    )
    fired = R[R.n_buy > 0]
    idle = R[R.n_buy == 0]
    print(
        f"    Buy add-on: on the {len(fired)} days it fired its lots made {fired.buy_pnl.sum():,.0f} (avg {fired.buy_pnl.mean():,.0f}/day); "
        f"the top-{BUY_MAX} Buy variants on the {len(idle)} days it stayed out would have made {idle.buy_alt.sum():,.0f} (avg {idle.buy_alt.mean():,.0f}/day)"
    )
    counts = pd.Series([names[v] for c in picks_A for v in c]).value_counts().head(10)
    print(
        "    most-picked core variants (case A):", ", ".join(f"{k}x{v}" for k, v in counts.items())
    )
    if CLOSEST:
        closest_report(picks_A, names, Pv, wd, vb, dte, days)
    hind = sorted(core_pool, key=lambda v: -today_all[:, v].sum())[:N_CORE]
    print(
        f"    HINDSIGHT ceiling (look-ahead, best fixed {N_CORE} over the selection days): {LOTS_PER * today_all[:, hind].sum():,.0f} -> {[names[v] for v in hind]}"
    )
    R.assign(
        core_A=[",".join(names[v] for v in c) for c in picks_A],
        buy=[",".join(names[v] for v in b) for b in buy_days],
    ).to_csv(
        HERE
        / (
            "daily_picks.csv"
            if (MIN_WIDE, CORE, BUY_MAX, CLOSEST, LOTS_PER) == (2, 5, 2, False, 1)
            else f"daily_picks_min{MIN_WIDE}_core{CORE}_buy{BUY_MAX}{f'L{LOTS_PER}' if LOTS_PER > 1 else ''}{'_whole_day' if WHOLE_DAY else '_closest' if CLOSEST else ''}{'_otm_only' if NO_CLOSEST else ''}{f'_top{PREFILTER}' if PREFILTER else ''}{f'r{PREFILTER_WINDOW}' if PREFILTER_WINDOW else ''}{f'_grid{GRID}' if GRID else ''}{('_w' + '_'.join(map(str, WEIGHTS))) if WEIGHTS else ''}{f'_rw{RECENT_WINDOW}' if RECENT_WINDOW else ''}{f'_lag{RECENT_LAG}' if RECENT_LAG else ''}{'_rev' if REVERSE else ''}{f'_shuf{SHUFFLE}' if SHUFFLE >= 0 else ''}.csv"
        )
    )


if __name__ == "__main__":
    main()
