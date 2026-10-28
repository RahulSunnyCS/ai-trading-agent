"""BL-185 Stage B: overlays over every recorded base cell, scored on the selection year.

For each part (underlying, cohort, slot) and each of its 360 variants, every config = (exit, overall
stop) is applied to the recorded path (overlay.py's rules, vectorised over days), charges are rebuilt
from the recorded trades, and the daily net / gross are scored per stratum (all days, expiry days of
the variant's own index, other days) on the selection year S. Writes stageb/<part>.npz:
  metrics[v, c, stratum, m]  with m in METRICS, plus the config lists.

    uv run python research/common/two_session/stage_b.py [--only NIFTY_W_0917] [--force]
"""

from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
from paths import PATHS_ROOT, load  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import minute_index  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.ruletest import charges as ch  # noqa: E402

S_START, S_END = date(2024, 10, 9), date(2025, 10, 8)
T_START = date(2025, 10, 9)
STOPS = (None, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000)
EXITS_AM = ("11:30", "12:00", "12:30", "13:00", "15:28")  # 15:28 = the whole-day run (A1)
EXITS_PM = ("15:28",)
MIN_HOLD = 10  # an exit must be at least this many minutes after the entry
STRATA = ("all", "expiry", "other")
METRICS = (
    "n", "net", "gross", "calmar", "pf", "martin", "maxdd", "stopdays", "pos_pieces", "ulcer", "entered",
)  # fmt: skip
OUT = PATHS_ROOT.parent / "stageb"


def configs(slot: str) -> list[tuple[str, int | None]]:
    entry = minute_index(f"{slot[:2]}:{slot[2:]}")
    exits = EXITS_AM if grid.BAND[slot] in ("A", "B") else EXITS_PM
    return [(e, s) for e in exits if minute_index(e) - entry >= MIN_HOLD for s in STOPS]


def charge_vec(
    events: np.ndarray, end: np.ndarray, closed_upto: np.ndarray, u: str, stt: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """(charges, orders) per day. `end`: the last minute whose trades exist; `closed_upto`: trades with
    exit_min <= this are valued at their exit price, others at entry (open at the overlay's exit)."""
    ent, ext, side, qty, ep, xp = (events[:, :, i] for i in range(6))
    inc = ~np.isnan(ent) & (ent <= end[:, None])
    closed = inc & (ext >= 0) & (ext <= closed_upto[:, None]) & ~np.isnan(xp)
    entry_val = np.nan_to_num(ep * qty)
    exit_val = np.where(closed, np.nan_to_num(xp * qty), entry_val)
    sold = side > 0
    sell = np.where(inc, np.where(sold, entry_val, exit_val), 0.0).sum(1)
    buy = np.where(inc, np.where(sold, exit_val, entry_val), 0.0).sum(1)
    orders = 2 * inc.sum(1)
    both = buy + sell
    brokerage = ch.BROKERAGE_PER_ORDER * orders
    exch = ch.EXCHANGE[u] * both
    ipft = ch.IPFT_NSE * both if u != "SENSEX" else 0.0
    sebi_ipft = ch.SEBI * both + ipft
    gst = ch.GST * (brokerage + exch + sebi_ipft)
    return brokerage + stt * sell + exch + sebi_ipft + ch.STAMP_BUY * buy + gst, orders


def evaluate(
    z: dict, entry: str, exit_: str, u: str, stt: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """For every stop in STOPS at this exit: (gross, net, stopped, orders), each (n_stops, days)."""
    path = z["path"]
    start, last = minute_index(entry), minute_index(exit_) - 1
    seg = path[:, start : last + 1]
    runmin = np.minimum.accumulate(seg, axis=1)
    n_days = len(path)
    gross = np.empty((len(STOPS), n_days))
    net = np.empty((len(STOPS), n_days))
    stopped = np.zeros((len(STOPS), n_days), dtype=bool)
    orders = np.zeros((len(STOPS), n_days))
    rows = np.arange(n_days)
    exit_idx = minute_index(exit_)
    for si, stop in enumerate(STOPS):
        if stop is None:
            hit = np.zeros(n_days, dtype=bool)
            idx = np.full(n_days, seg.shape[1] - 1)
        else:
            m = runmin <= -float(stop)
            hit = m.any(1)
            idx = np.where(hit, m.argmax(1), seg.shape[1] - 1)
        g = seg[rows, idx]
        end_min = start + idx
        closed_upto = np.where(hit, end_min, exit_idx)  # an unforced day closes at the exit minute
        last_min = np.where(hit, end_min, exit_idx)
        c, o = charge_vec(z["events"], last_min, closed_upto, u, stt)
        gross[si], net[si], stopped[si], orders[si] = g, g - c, hit, o
    return gross, net, stopped, orders


def stats(
    net: np.ndarray, gross: np.ndarray, stopped: np.ndarray, piece: np.ndarray, entered: np.ndarray
) -> np.ndarray:
    """METRICS for one daily series (days,)."""
    n = len(net)
    if n == 0:
        return np.full(len(METRICS), np.nan)
    cum = np.cumsum(net)
    peak = np.maximum.accumulate(np.maximum(cum, 0.0))
    dd = cum - peak
    maxdd = dd.min()
    ulcer = float(np.sqrt(np.mean(dd**2)))
    ann = net.mean() * 252.0
    wins, losses = net[net > 0].sum(), -net[net < 0].sum()
    pos = sum(1 for p in np.unique(piece) if net[piece == p].sum() > 0)
    return np.array([
        n, net.mean(), gross.mean(), ann / abs(maxdd) if maxdd < 0 else np.inf,
        wins / losses if losses > 0 else np.inf, ann / ulcer if ulcer > 0 else np.inf,
        maxdd, stopped.mean(), pos, ulcer, entered.mean(),
    ])  # fmt: skip


def day_tables(days: np.ndarray, u: str):
    attrs = store.read_days(data_dir(), "weekdays")
    dd = [date.fromisoformat(d) for d in days]
    key = "dte_n" if u == "NIFTY" else "dte_s"
    expiry = np.array([attrs[d][key] == "0" if d in attrs else False for d in dd])
    insel = np.array([S_START <= d <= S_END for d in dd])
    piece = np.array([f"{d.year}{1 if d.month <= 6 else 2}" for d in dd])
    stt = np.array([ch.stt_rate(d.isoformat()) for d in dd])
    return expiry, insel, piece, stt


def run_part(part_dir: Path, force: bool = False) -> bool:
    out = OUT / f"{part_dir.name}.npz"
    if out.exists() and not force:
        return False
    u, co, slot = part_dir.name.split("_")
    u = {"NIFTY": "NIFTY", "SENSEX": "SENSEX"}[u]
    cfgs = configs(slot)
    files = sorted(part_dir.glob("*.npz"))
    cells = grid.cells(co)
    assert len(files) == len(cells), (part_dir, len(files), len(cells))
    entry = f"{slot[:2]}:{slot[2:]}"
    M = np.full((len(files), len(cfgs), len(STRATA), len(METRICS)), np.nan)
    first = None
    for vi, f in enumerate(files):
        z = load(f)
        if first is None:
            first = z["days"]
            expiry, insel, piece, stt = day_tables(first, u)
        assert (z["days"] == first).all(), f
        entered = ~np.isnan(z["events"][:, 0, 0])
        by_exit = {}
        for ci, (exit_, stop) in enumerate(cfgs):
            if exit_ not in by_exit:
                by_exit[exit_] = evaluate(z, entry, exit_, u, stt)
            g, n, s, _ = by_exit[exit_]
            si = STOPS.index(stop)
            masks = (insel, insel & expiry, insel & ~expiry)
            for k, m in enumerate(masks):
                M[vi, ci, k] = stats(n[si][m], g[si][m], s[si][m], piece[m], entered[m])
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(
        f"{out.stem}.{os.getpid()}.tmp.npz"
    )  # atomic: two scorers never share a file
    np.savez(tmp, metrics=M, exits=np.array([c[0] for c in cfgs]), stops=np.array([-1 if c[1] is None else c[1] for c in cfgs]),
             cells=np.array([c.cid for c in cells]), days=first)  # fmt: skip
    os.replace(tmp, out)
    return True


def main() -> None:
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    force = "--force" in sys.argv
    for d in sorted(PATHS_ROOT.iterdir()):
        if not (d / "DONE").exists() or (only and only not in d.name):
            continue
        done = run_part(d, force)
        print(f"{d.name}: {'scored' if done else 'already scored'}", flush=True)


if __name__ == "__main__":
    main()
