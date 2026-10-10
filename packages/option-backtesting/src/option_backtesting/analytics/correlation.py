"""How strategies' daily P&L move together (BL-090), and a basket that does not move as one.

Input is each strategy's daily net P&L in rupees for 1 lot, so a family with bigger daily swings
weighs more in the basket numbers; correlations themselves are scale-free. Everything is numpy:
the Spearman columns reuse `rotation.score.pct_rank`, and scipy / pandas are not dependencies.

What is measured, for k strategies over the days they all have (Monday to Friday):

* `pearson`, `spearman`: k x k correlation of the daily P&L and of its ranks.
* `loss_overlap[i, j]`: of the days i lost money, the share on which j lost too. Not symmetric.
* `loss_corr[i, j]`: Pearson over the days where either lost, the "do they crash together" view.
* `basket`: equal lots in every strategy: max drawdown, worst day, and how the basket's drawdown
  compares with the sum of the parts' drawdowns (`dd_ratio`; below 1 is a diversification gain).
* `rolling`: Pearson over consecutive blocks of `window` trading days, so a pair that is
  uncorrelated on average but moves as one in a quarter shows up.

Every figure here is in-sample over the window given. Using a matrix to pick strategies for a
day must use only days before it: pass `end` (the day before) to `analyse`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import numpy as np

from ..rotation.score import pct_rank

MIN_DAYS = 40  # fewer common days than this and a correlation is not worth printing
WINDOW = 63
MEASURES = ("pearson", "spearman", "loss")


@dataclass(frozen=True)
class Series:
    """One strategy's daily net P&L."""

    name: str
    kind: str  # "variant" (a rotation variant file) | "legwise" (a saved legwise strategy)
    values: dict[date, float]


@dataclass(frozen=True)
class PartStats:
    net: float
    max_dd: float  # <= 0, on the cumulative net from a start of 0
    worst_day: float
    loss_day_share: float  # share of days with net < 0
    mean_over_std: float  # daily mean / daily standard deviation (not annualised)


@dataclass(frozen=True)
class BasketStats:
    names: list[str]
    net: float
    max_dd: float
    worst_day: float
    loss_day_share: float
    sum_of_part_dds: float
    dd_ratio: float  # max_dd / sum_of_part_dds; below 1 the basket draws down less than its parts
    mean_over_std: float


@dataclass(frozen=True)
class RollingRow:
    start: date
    end: date
    n_days: int
    min: float
    mean: float
    max: float
    top_pair: tuple[str, str, float] | None


@dataclass(frozen=True)
class CorrelationReport:
    days: list[date]
    names: list[str]
    kinds: list[str]
    values: np.ndarray  # len(days) x len(names)
    pearson: np.ndarray
    spearman: np.ndarray
    loss_overlap: np.ndarray
    loss_corr: np.ndarray
    both_lose_days: np.ndarray
    parts: dict[str, PartStats]
    basket: BasketStats
    rolling: list[RollingRow]
    window: int

    @property
    def n_days(self) -> int:
        return len(self.days)


@dataclass(frozen=True)
class Basket:
    names: list[str]
    wanted: int
    cap: float
    measure: str
    skipped: list[tuple[str, str, float]]  # (name, taken name that blocked it, correlation)
    stats: BasketStats
    uncapped: BasketStats  # the same size, best by rank, no cap
    in_sample: bool = True

    @property
    def short(self) -> bool:
        return len(self.names) < self.wanted


# --- alignment --------------------------------------------------------------------------------


def align(
    series: list[Series],
    start: date | None = None,
    end: date | None = None,
    min_days: int = MIN_DAYS,
) -> tuple[list[date], list[str], np.ndarray]:
    """Net P&L by day and strategy over the days every strategy has, Monday to Friday only (the
    same rule as `rotation.store.load_matrix`), within [start, end]."""
    if not series:
        raise ValueError("no strategies given")
    names = [s.name for s in series]
    if len(set(names)) != len(names):
        raise ValueError("a strategy was given twice")
    common = set(series[0].values)
    for s in series[1:]:
        common &= set(s.values)
    days = sorted(
        d
        for d in common
        if d.weekday() < 5 and (start is None or d >= start) and (end is None or d <= end)
    )
    if len(days) < min_days:

        def in_window(s: Series) -> int:
            return sum(
                1
                for d in s.values
                if d.weekday() < 5 and (start is None or d >= start) and (end is None or d <= end)
            )

        shortest = sorted(series, key=in_window)[:3]
        detail = ", ".join(f"{s.name} ({in_window(s)} days)" for s in shortest)
        raise ValueError(
            f"only {len(days)} days in common (need {min_days}); "
            f"shortest history: {detail}. Widen --from/--to or leave those out"
        )
    values = np.array([[s.values[d] for s in series] for d in days], dtype=float)
    return days, names, values.reshape(len(days), len(series))


# --- measures ---------------------------------------------------------------------------------


def _pearson(x: np.ndarray) -> np.ndarray:
    """k x k Pearson of the columns; a column with no variance gives NaN."""
    n = x.shape[0]
    centred = x - x.mean(axis=0)
    norm = np.sqrt((centred**2).sum(axis=0))
    norm[norm < 1e-12] = np.nan
    z = centred / norm
    out = z.T @ z
    k = x.shape[1]
    out = np.clip(out, -1.0, 1.0)
    out[np.arange(k), np.arange(k)] = np.where(np.isnan(norm), np.nan, 1.0)
    return out if n > 1 else np.full((k, k), np.nan)


def _spearman(x: np.ndarray) -> np.ndarray:
    ranks = np.column_stack([pct_rank(x[:, j]) for j in range(x.shape[1])])
    return _pearson(ranks)


def _loss_overlap(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    lost = (x < 0).astype(float)
    both = lost.T @ lost
    own = np.diag(both)
    with np.errstate(invalid="ignore", divide="ignore"):
        overlap = both / own[:, None]
    return overlap, both


def _loss_corr(x: np.ndarray) -> np.ndarray:
    """Pearson of i and j over the days where i or j lost, for every pair at once. With G the
    1 - lost indicator the day mask is 1 - G_i G_j, so each sum over the masked days is the
    full sum minus a product of two matrices."""
    n = x.shape[0]
    g = (x >= 0).astype(float)
    xg = x * g
    n_ij = n - g.T @ g
    sx = x.sum(axis=0)[:, None] - xg.T @ g  # sum of x_i over the pair's days
    sy = sx.T
    sxx = (x**2).sum(axis=0)[:, None] - (x**2 * g).T @ g
    syy = sxx.T
    sxy = x.T @ x - xg.T @ xg
    with np.errstate(invalid="ignore", divide="ignore"):
        num = n_ij * sxy - sx * sy
        den = np.sqrt(np.maximum(n_ij * sxx - sx**2, 0) * np.maximum(n_ij * syy - sy**2, 0))
        out = np.where((n_ij >= 3) & (den > 1e-9), num / den, np.nan)
    out = np.clip(out, -1.0, 1.0)
    k = x.shape[1]
    out[np.arange(k), np.arange(k)] = 1.0
    return out


def _max_drawdown(daily: np.ndarray) -> float:
    if len(daily) == 0:
        return 0.0
    cum = np.cumsum(daily)
    peak = np.maximum.accumulate(np.maximum(cum, 0.0))
    return float(np.min(cum - peak).clip(max=0.0))


def _mean_over_std(daily: np.ndarray) -> float:
    sd = float(daily.std(ddof=1)) if len(daily) > 1 else 0.0
    return float(daily.mean() / sd) if sd > 1e-12 else math.nan


def _part(daily: np.ndarray) -> PartStats:
    return PartStats(
        net=float(daily.sum()),
        max_dd=_max_drawdown(daily),
        worst_day=float(daily.min()),
        loss_day_share=float((daily < 0).mean()),
        mean_over_std=_mean_over_std(daily),
    )


def basket_stats(values: np.ndarray, names: list[str]) -> BasketStats:
    """Equal lots in every column of `values` (days x strategies)."""
    total = values.sum(axis=1)
    dds = [_max_drawdown(values[:, j]) for j in range(values.shape[1])]
    parts_sum = float(sum(dds))
    dd = _max_drawdown(total)
    return BasketStats(
        names=list(names),
        net=float(total.sum()),
        max_dd=dd,
        worst_day=float(total.min()),
        loss_day_share=float((total < 0).mean()),
        sum_of_part_dds=parts_sum,
        dd_ratio=dd / parts_sum if parts_sum < -1e-9 else math.nan,
        mean_over_std=_mean_over_std(total),
    )


def _rolling(
    days: list[date], names: list[str], values: np.ndarray, window: int
) -> list[RollingRow]:
    k = len(names)
    if k < 2:
        return []
    rows = []
    iu = np.triu_indices(k, 1)
    for lo in range(0, len(days), window):
        hi = min(lo + window, len(days))
        if hi - lo < max(10, window // 2):
            break  # a short tail says little; the previous block already covers it
        c = _pearson(values[lo:hi])[iu]
        ok = ~np.isnan(c)
        if not ok.any():
            rows.append(
                RollingRow(days[lo], days[hi - 1], hi - lo, math.nan, math.nan, math.nan, None)
            )
            continue
        top = int(np.nanargmax(np.where(ok, c, -np.inf)))
        rows.append(
            RollingRow(
                start=days[lo],
                end=days[hi - 1],
                n_days=hi - lo,
                min=float(c[ok].min()),
                mean=float(c[ok].mean()),
                max=float(c[ok].max()),
                top_pair=(names[iu[0][top]], names[iu[1][top]], float(c[top])),
            )
        )
    return rows


def analyse(
    series: list[Series],
    *,
    start: date | None = None,
    end: date | None = None,
    window: int = WINDOW,
    min_days: int = MIN_DAYS,
) -> CorrelationReport:
    days, names, values = align(series, start, end, min_days)
    overlap, both = _loss_overlap(values)
    return CorrelationReport(
        days=days,
        names=names,
        kinds=[s.kind for s in series],
        values=values,
        pearson=_pearson(values),
        spearman=_spearman(values),
        loss_overlap=overlap,
        loss_corr=_loss_corr(values),
        both_lose_days=both.astype(int),
        parts={n: _part(values[:, j]) for j, n in enumerate(names)},
        basket=basket_stats(values, names),
        rolling=_rolling(days, names, values, window),
        window=window,
    )


def matrix_of(report: CorrelationReport, measure: str) -> np.ndarray:
    if measure not in MEASURES:
        raise ValueError(f"measure must be one of {', '.join(MEASURES)}")
    return {"pearson": report.pearson, "spearman": report.spearman, "loss": report.loss_corr}[
        measure
    ]


def order_by_similarity(corr: np.ndarray) -> list[int]:
    """A leaf order that puts strategies that move together next to each other, so a heatmap
    shows blocks: average-linkage agglomeration on 1 - correlation (an incomputable one counts
    as 1, not alike), members listed in merge order. Ties break by index, so it is stable."""
    k = corr.shape[0]
    if k <= 2:
        return list(range(k))
    dist = 1.0 - np.nan_to_num(np.asarray(corr, dtype=float), nan=0.0)
    np.fill_diagonal(dist, np.inf)
    members: list[list[int]] = [[i] for i in range(k)]
    size = np.ones(k)
    live = np.ones(k, dtype=bool)
    for _ in range(k - 1):
        masked = np.where(live[:, None] & live[None, :], dist, np.inf)
        a, b = np.unravel_index(int(np.argmin(masked)), masked.shape)
        a, b = (int(a), int(b)) if a < b else (int(b), int(a))
        merged = (size[a] * dist[a] + size[b] * dist[b]) / (size[a] + size[b])
        dist[a, :], dist[:, a] = merged, merged
        dist[a, a] = np.inf
        members[a] = members[a] + members[b]
        size[a] += size[b]
        live[b] = False
        dist[b, :], dist[:, b] = np.inf, np.inf
    return members[int(np.flatnonzero(live)[0])]


# --- a basket whose parts are not alike -------------------------------------------------------


def pick_diverse(
    report: CorrelationReport,
    k: int,
    max_corr: float,
    *,
    rank: dict[str, float] | None = None,
    measure: str = "pearson",
    require: list[str] | tuple[str, ...] = (),
) -> Basket:
    """Greedy: strategies in rank order (best first), each kept only when its correlation with
    every strategy already kept is below `max_corr`, until k are kept. `require` names go in
    first. The default rank is each strategy's own mean / std over the window, so the result
    is in-sample. A correlation that cannot be computed (a strategy that never varies) counts
    as not independent. The basket is short, never padded, when nothing else qualifies."""
    if k < 1:
        raise ValueError("k must be at least 1")
    corr = matrix_of(report, measure)
    index = {n: i for i, n in enumerate(report.names)}
    unknown = [n for n in require if n not in index]
    if unknown:
        raise ValueError(f"not in the report: {', '.join(unknown)}")
    if len(require) > k:
        raise ValueError(f"{len(require)} required names do not fit in a basket of {k}")
    for n, first in enumerate(require):
        for second in require[n + 1 :]:
            c = corr[index[first], index[second]]
            if math.isnan(c) or c >= max_corr:
                alike = "cannot be compared" if math.isnan(c) else f"are {c:.2f} alike"
                raise ValueError(
                    f"required {first} and {second} {alike}, not below the cap "
                    f"{max_corr:.2f}: raise the cap or drop one of them"
                )
    score = {n: p.mean_over_std for n, p in report.parts.items()} if rank is None else dict(rank)
    missing = [n for n in report.names if n not in score]
    if missing:
        raise ValueError(f"rank has no score for: {', '.join(missing[:5])}")
    key = {n: (-score[n] if not math.isnan(score[n]) else math.inf, n) for n in report.names}
    order = sorted(report.names, key=lambda n: key[n])

    taken: list[str] = list(require)
    skipped: list[tuple[str, str, float]] = []
    for name in order:
        if len(taken) >= k:
            break
        if name in taken:
            continue
        clash = None
        for other in taken:
            c = corr[index[name], index[other]]
            if math.isnan(c) or c >= max_corr:
                clash = (other, float(c))
                break
        if clash is None:
            taken.append(name)
        else:
            skipped.append((name, clash[0], clash[1]))

    def stats(names: list[str]) -> BasketStats:
        cols = [index[n] for n in names]
        return basket_stats(report.values[:, cols], names)

    uncapped = list(require) + [n for n in order if n not in require][: k - len(require)]
    return Basket(
        names=taken,
        wanted=k,
        cap=max_corr,
        measure=measure,
        skipped=skipped,
        stats=stats(taken),
        uncapped=stats(uncapped),
    )


# --- output -----------------------------------------------------------------------------------


def _f(x: float, width: int = 5, digits: int = 2) -> str:
    return f"{'—':>{width}}" if x is None or math.isnan(x) else f"{x:>{width}.{digits}f}"


def _money(x: float) -> str:
    return f"{x:>10,.0f}"


FULL_MATRIX_MAX = 14  # a bigger set prints the extremes, not a wall of numbers


def _matrix_text(
    title: str, m: np.ndarray, names: list[str], digits: int = 2, full: bool = False
) -> list[str]:
    k = len(names)
    out = [title]
    width = max(len(n) for n in names)
    head = " " * (width + 4) + " ".join(f"{j + 1:>5d}" for j in range(k))
    out.append(head)
    for i, n in enumerate(names):
        cells = " ".join(_f(m[i, j], 5, digits) if (full or j <= i) else " " * 5 for j in range(k))
        out.append(f"{i + 1:>2d}. {n:<{width}} {cells}")
    return out


def _extremes(title: str, m: np.ndarray, names: list[str], n: int = 8) -> list[str]:
    k = len(names)
    iu = np.triu_indices(k, 1)
    vals = m[iu]
    ok = np.flatnonzero(~np.isnan(vals))
    order = ok[np.argsort(vals[ok], kind="stable")]
    out = [title]
    for label, picks in (("most alike", order[::-1][:n]), ("least alike", order[:n])):
        out.append(f"  {label}:")
        out += [f"    {_f(vals[p])}  {names[iu[0][p]]}  ~  {names[iu[1][p]]}" for p in picks]
    return out


def render_text(report: CorrelationReport) -> str:
    r = report
    k = len(r.names)
    lines = [
        f"Correlation of daily net P&L, 1 lot each: {k} strategies, {r.n_days} common days "
        f"({r.days[0]} to {r.days[-1]}). In-sample.",
        "",
    ]
    show_all = k <= FULL_MATRIX_MAX
    for title, m in (
        ("Pearson (daily P&L)", r.pearson),
        ("Spearman (rank of daily P&L)", r.spearman),
    ):
        lines += _matrix_text(title, m, r.names) if show_all else _extremes(title, m, r.names)
        lines.append("")
    if show_all:
        lines += _matrix_text(
            "Loss overlap: of the days ROW lost, the share COLUMN also lost",
            r.loss_overlap,
            r.names,
            full=True,
        )
    else:
        lines += _extremes("Pearson over days where either lost", r.loss_corr, r.names)
    lines.append("")

    lines.append("Each strategy")
    width = max(len(n) for n in r.names)
    lines.append(
        f"  {'':<{width}} {'net':>10} {'max DD':>10} {'worst day':>10} "
        f"{'loss days':>9} {'mean/sd':>8}"
    )
    shown = r.names if show_all else r.names[:FULL_MATRIX_MAX]
    for n in shown:
        p = r.parts[n]
        lines.append(
            f"  {n:<{width}} {_money(p.net)} {_money(p.max_dd)} {_money(p.worst_day)} "
            f"{p.loss_day_share:>8.0%} {_f(p.mean_over_std, 8, 3)}"
        )
    if not show_all:
        lines.append(f"  ... {k - len(shown)} more (use --json for all)")
    lines.append("")

    b = r.basket
    lines += [
        f"Basket of all {k}, one lot each",
        f"  net {b.net:,.0f}   max drawdown {b.max_dd:,.0f}   worst day {b.worst_day:,.0f}   "
        f"loss days {b.loss_day_share:.0%}",
        f"  sum of the parts' drawdowns {b.sum_of_part_dds:,.0f}   "
        f"ratio {_f(b.dd_ratio, 4, 2).strip()}"
        "  (below 1: the basket draws down less than its parts added up)",
        "",
    ]
    if r.rolling:
        lines.append(f"Pairwise Pearson in blocks of {r.window} trading days (min / mean / max)")
        for row in r.rolling:
            top = (
                f"   most alike: {row.top_pair[0]} ~ {row.top_pair[1]} {row.top_pair[2]:.2f}"
                if row.top_pair
                else ""
            )
            lines.append(
                f"  {row.start} .. {row.end} ({row.n_days:>3d}d)  "
                f"{_f(row.min)} / {_f(row.mean)} / {_f(row.max)}{top}"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_basket(b: Basket) -> str:
    lines = [
        f"Diverse basket: {len(b.names)} of {b.wanted} wanted, {b.measure} below {b.cap:.2f}. "
        "In-sample: chosen and measured on the same days.",
        "  taken: " + ", ".join(b.names),
    ]
    if b.short:
        lines.append(
            f"  SHORT: nothing else qualifies under the cap ({b.wanted - len(b.names)} slots empty)"
        )
    for name, blocker, c in b.skipped[:8]:
        lines.append(f"  skipped {name}: {_f(c).strip()} with {blocker}")
    if len(b.skipped) > 8:
        lines.append(f"  ... and {len(b.skipped) - 8} more skipped")
    for label, s in (("capped  ", b.stats), ("no cap  ", b.uncapped)):
        lines.append(
            f"  {label} net {s.net:>10,.0f}  max DD {s.max_dd:>10,.0f}  "
            f"worst day {s.worst_day:>9,.0f}  "
            f"dd/parts {_f(s.dd_ratio, 4, 2).strip()}  [{', '.join(s.names)}]"
        )
    return "\n".join(lines) + "\n"


# --- machine-readable -------------------------------------------------------------------------


def _clean(x):
    if isinstance(x, float):
        return None if math.isnan(x) or math.isinf(x) else x
    if isinstance(x, np.ndarray):
        return [_clean(v) for v in x.tolist()]
    if isinstance(x, list):
        return [_clean(v) for v in x]
    return x


def to_json(report: CorrelationReport) -> dict:
    r = report
    return {
        "names": r.names,
        "kinds": r.kinds,
        "days": [d.isoformat() for d in r.days],
        "n_days": r.n_days,
        "window": r.window,
        "order": order_by_similarity(r.pearson),
        "pearson": _clean(np.round(r.pearson, 4)),
        "spearman": _clean(np.round(r.spearman, 4)),
        "loss_overlap": _clean(np.round(r.loss_overlap, 4)),
        "loss_corr": _clean(np.round(r.loss_corr, 4)),
        "both_lose_days": r.both_lose_days.tolist(),
        "parts": {
            n: {key: _clean(float(val)) for key, val in vars(p).items()} for n, p in r.parts.items()
        },
        "basket": {
            key: (_clean(val) if not isinstance(val, list) else val)
            for key, val in vars(r.basket).items()
        },
        "rolling": [
            {
                "start": row.start.isoformat(),
                "end": row.end.isoformat(),
                "n_days": row.n_days,
                "min": _clean(row.min),
                "mean": _clean(row.mean),
                "max": _clean(row.max),
                "top_pair": list(row.top_pair) if row.top_pair else None,
            }
            for row in r.rolling
        ],
    }


def basket_to_json(b: Basket) -> dict:
    def s(x: BasketStats) -> dict:
        return {k: (_clean(v) if not isinstance(v, list) else v) for k, v in vars(x).items()}

    return {
        "names": b.names,
        "wanted": b.wanted,
        "cap": b.cap,
        "measure": b.measure,
        "short": b.short,
        "in_sample": b.in_sample,
        "skipped": [[n, o, _clean(c)] for n, o, c in b.skipped],
        "stats": s(b.stats),
        "uncapped": s(b.uncapped),
    }


def to_csv_rows(report: CorrelationReport, measure: str = "pearson") -> list[list[str]]:
    m = matrix_of(report, measure)
    rows = [["", *report.names]]
    for i, n in enumerate(report.names):
        rows.append([n, *("" if math.isnan(v) else f"{v:.4f}" for v in m[i])])
    return rows
