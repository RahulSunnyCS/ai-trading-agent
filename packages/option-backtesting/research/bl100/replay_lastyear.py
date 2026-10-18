"""BL-100 comparison only: lists A/B/C/REF over the stored results, full pool vs BL-099-family pools.

Read-only. Nothing is written except a CSV in this folder. Window scored: 2025-10-09 .. 2026-10-09
(earlier stored days are history for the rankings). In-sample for the lists' weights and for the
BL-099 cells, so this is a comparison, not a test. Stored results carry costs = 0 (gross)."""

import csv
from datetime import date
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import base as base_mod
from option_backtesting.rotation import store
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.score import composite, dte_matrix, family_index, select
from option_backtesting.rotation.variants import parts, variant_names

START = date(2025, 10, 9)
root = data_dir()
names = variant_names()
m = store.load_matrix(names, root)
attrs = store.read_days(root, "calendar")  # BL-100 was a calendar-day record
keep = [i for i, d in enumerate(m.days) if d in attrs]
days = [m.days[i] for i in keep]
P = m.values[keep]
wd = np.array([attrs[d]["weekday"] for d in days])
bd = np.array([attrs[d]["vix_band"] for d in days])
dn = np.array([attrs[d]["dte_n"] for d in days])
ds = np.array([attrs[d]["dte_s"] for d in days])


def minutes(tag):
    return int(tag[:2]) * 60 + int(tag[2:])


def pool(kind):
    out = []
    for j, n in enumerate(names):
        idx, fam, tag = parts(n)
        wide_ok = fam == "p100" if idx == "N" else fam == "p250"
        if kind == "full":
            ok = True
        elif kind == "fam":
            ok = fam == "dir" or wide_ok
        else:  # fam_band
            ok = (fam == "dir" and minutes(tag) < 780) or (wide_ok and minutes(tag) >= 780)
        if ok:
            out.append(j)
    return out


pools = {k: pool(k) for k in ("full", "fam", "fam_band")}
print({k: len(v) for k, v in pools.items()})
col = {n: j for j, n in enumerate(names)}
rows = []
series = {}
picks_log = {}
for pk, ix in pools.items():
    cn = [names[j] for j in ix]
    fam = family_index(cn)
    for lk, lst in LISTS.items():
        per_lot, pickfreq = [], {}
        for i, d in enumerate(days):
            if d < START or i < WARMUP:
                continue
            sub = P[: i + 1, ix].copy()
            sub[-1, :] = 0.0
            comp = composite(
                sub,
                wd[: i + 1],
                bd[: i + 1],
                dte_matrix(dn[: i + 1], ds[: i + 1], cn),
                cn,
                lst,
                fam,
            )
            pk_ = select(comp, cn)
            chosen = pk_.core + pk_.buy
            for c in chosen:
                pickfreq[c] = pickfreq.get(c, 0) + 1
            per_lot.append(float(np.mean([P[i, col[c]] for c in chosen])))
        series[(pk, lk)] = np.array(per_lot)
        picks_log[(pk, lk)] = pickfreq
sel_days = [d for i, d in enumerate(days) if d >= START and i >= WARMUP]
# fixed base per lot-day (gross) for the same days
bpl = base_mod.base_per_lot(root, "gross")
base = np.array([bpl.get(d, np.nan) for d in sel_days])


def mdd(x):
    e = np.cumsum(x)
    return float((e - np.maximum.accumulate(np.maximum(e, 0))).min())


print(
    f"days scored {len(sel_days)}  base per lot-day {np.nanmean(base):.0f}  base days {np.isfinite(base).sum()}"
)
print(
    f"{'pool':9s}{'list':5s}{'₹/lot-day':>10s}{'cum/lot':>10s}{'maxDD/lot':>11s}{'pos-days':>9s}{'vs base':>9s}{'top pick':>26s}"
)
for (pk, lk), s in series.items():
    top = max(picks_log[(pk, lk)].items(), key=lambda kv: kv[1])
    ok = np.isfinite(base)
    print(
        f"{pk:9s}{lk:5s}{s.mean():10.0f}{s.sum():10.0f}{mdd(s):11.0f}{(s > 0).mean():9.2f}{(s[ok] - base[ok]).mean():9.0f}{top[0] + ' ' + str(top[1]):>26s}"
    )
    rows.append(
        [pk, lk, round(s.mean(), 1), round(s.sum(), 1), round(mdd(s), 1), round((s > 0).mean(), 3)]
    )
with (Path(__file__).parent / "replay_lastyear.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["pool", "list", "per_lot_day", "cum_per_lot", "max_dd_per_lot", "pos_day_share"])
    w.writerows(rows)
