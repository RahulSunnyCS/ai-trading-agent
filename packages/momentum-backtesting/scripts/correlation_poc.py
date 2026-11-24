# ruff: noqa: E501 (the HTML/CSS template below)
"""BL-114 proof of concept: how alike are the saved Momentum strategies?

Reads every saved strategy's stored weekly equity curve (a group's is its sleeves' blend,
`runs_store.group_blend`) and writes, under `data/correlation_poc/`:

- one CSV per view (`returns`, `excess`, `down_weeks`, `drawdown_overlap`, `holdings_overlap`),
  plus `summary.csv` (one row per strategy);
- `report.html`: the same tables as heatmaps, to read in a browser.

Views (all pairwise over the weeks both strategies have; a pair with fewer than MIN_WEEKS is blank):

- returns:          Pearson correlation of weekly returns.
- excess:           the same after removing the common factor from each strategy (its beta times
                    the average weekly return of the saved Broad groups). What is left is what a
                    strategy does that the others do not.
- down_weeks:       correlation over the weeks the common factor is in its worst 10%.
- drawdown_overlap: of the weeks either strategy is more than 10% below its peak, the share in
                    which both are.
- holdings_overlap: this week's weights, sum of the smaller weight per name (0-100%), for the
                    strategies the This week page has a signal for.

In-sample and descriptive: the curves were chosen after the results were seen.

Run from packages/momentum-backtesting:  uv run python scripts/correlation_poc.py
"""

from __future__ import annotations

import html

import numpy as np
import pandas as pd

from momentum_backtesting import api, runs_store
from momentum_backtesting.config import DATA_DIR
from momentum_backtesting.db_read import read_catalog

MIN_WEEKS = 52
DRAWDOWN = 0.10
WORST_SHARE = 0.10
OUT = DATA_DIR / "correlation_poc"


def load() -> tuple[pd.DataFrame, pd.DataFrame]:
    """(weekly equity curves by label, one metadata row per label)."""
    with read_catalog() as con:
        strategies = runs_store.list_strategies(con)
    curves: dict[str, pd.Series] = {}
    meta = []
    for s in strategies:
        if s["group"]:
            blend = s.get("blend")
            if not blend:
                continue
            dates, values, kind = blend["dates"], blend["strategy"], "group"
        else:
            latest = s["latest"]
            dates, values, kind = latest["dates"], latest["strategy"], "single"
        series = pd.Series(values, index=pd.to_datetime(dates), dtype=float).dropna()
        if len(series) < 3:
            continue
        label = s["name"].replace(" · all Fridays", "")
        if label in curves:
            label = f"{label} #{s['id'][:4]}"
        curves[label] = series
        meta.append(
            {
                "label": label,
                "kind": kind,
                "dataset": s["dataset"],
                "status": s["status"] or "",
                "id": s["id"],
            }
        )
    frame = pd.DataFrame(curves).sort_index()
    return frame, pd.DataFrame(meta).set_index("label")


def pairwise(returns: pd.DataFrame, fn) -> pd.DataFrame:
    labels = list(returns.columns)
    out = pd.DataFrame(np.nan, index=labels, columns=labels)
    for i, a in enumerate(labels):
        for b in labels[i:]:
            if a == b:
                if returns[a].count() >= MIN_WEEKS:
                    out.loc[a, a] = 1.0
                continue
            pair = returns[[a, b]].dropna()
            if len(pair) >= MIN_WEEKS:
                out.loc[a, b] = out.loc[b, a] = fn(pair[a], pair[b])
    return out


def main() -> None:
    curves, meta = load()
    returns = curves.pct_change(fill_method=None)
    returns = returns.where(curves.notna() & curves.shift().notna())
    groups = [c for c in curves if meta.loc[c, "kind"] == "group"]
    factor = returns[groups].mean(axis=1)

    pearson = pairwise(returns, lambda a, b: a.corr(b))

    betas = {}
    resid = pd.DataFrame(index=returns.index)
    for c in returns:
        pair = pd.concat([returns[c], factor], axis=1).dropna()
        if len(pair) < MIN_WEEKS:
            continue
        beta = np.cov(pair.iloc[:, 0], pair.iloc[:, 1])[0, 1] / pair.iloc[:, 1].var()
        betas[c] = beta
        resid[c] = returns[c] - beta * factor
    excess = pairwise(resid, lambda a, b: a.corr(b))

    worst = factor <= factor.quantile(WORST_SHARE)
    down = pairwise(returns[worst], lambda a, b: a.corr(b))

    under = (curves / curves.cummax() - 1) < -DRAWDOWN
    labels = list(curves)
    overlap = pd.DataFrame(np.nan, index=labels, columns=labels)
    for i, a in enumerate(labels):
        for b in labels[i:]:
            if a == b:
                overlap.loc[a, a] = 1.0
                continue
            both = curves[[a, b]].dropna().index
            if len(both) < MIN_WEEKS:
                continue
            either = (under.loc[both, a] | under.loc[both, b]).sum()
            overlap.loc[a, b] = overlap.loc[b, a] = (
                (under.loc[both, a] & under.loc[both, b]).sum() / either if either else np.nan
            )

    # This week's weights, for the strategies with a signal on the This week page.
    week = api._week_view(None)
    names = {c["name"].replace(" · all Fridays", ""): c for c in week["favourites"]}
    weights = {}
    for label, card in names.items():
        w = {r["asset"]: r["after"] for r in card["rows"] if (r.get("after") or 0) > 0}
        if w:
            weights[label] = w
    held = pd.DataFrame(np.nan, index=list(weights), columns=list(weights))
    for a in weights:
        for b in weights:
            held.loc[a, b] = sum(
                min(weights[a].get(n, 0), weights[b].get(n, 0)) for n in weights[a]
            )

    # Summary: one row per strategy.
    offdiag = pearson.where(~np.eye(len(pearson), dtype=bool))
    rows = []
    for c in curves:
        s = curves[c].dropna()
        weekly = s.pct_change().dropna()
        years = (s.index[-1] - s.index[0]).days / 365.25
        twin = offdiag[c].dropna()
        resid_c = (
            excess[c].where(excess.index != c).dropna() if c in excess else pd.Series(dtype=float)
        )
        rows.append(
            {
                "strategy": c,
                "kind": meta.loc[c, "kind"],
                "dataset": meta.loc[c, "dataset"],
                "status": meta.loc[c, "status"],
                "from": s.index[0].date(),
                "weeks": len(s),
                "cagr": (s.iloc[-1] / s.iloc[0]) ** (1 / years) - 1,
                "max_dd": (s / s.cummax() - 1).min(),
                "vol": weekly.std() * np.sqrt(52),
                "beta_to_factor": betas.get(c, np.nan),
                "avg_corr": twin.mean() if len(twin) else np.nan,
                "closest": twin.idxmax() if len(twin) else "",
                "closest_corr": twin.max() if len(twin) else np.nan,
                "least_alike": twin.idxmin() if len(twin) else "",
                "least_alike_corr": twin.min() if len(twin) else np.nan,
                "avg_excess_corr": resid_c.mean() if len(resid_c) else np.nan,
            }
        )
    summary = pd.DataFrame(rows).set_index("strategy")

    # Effective number of independent bets, from the groups' common window.
    common = returns[groups].dropna()
    eig = np.linalg.eigvalsh(common.corr().values)
    share = eig / eig.sum()
    effective = 1 / np.sum(share**2)

    OUT.mkdir(parents=True, exist_ok=True)
    tables = {
        "returns": pearson,
        "excess": excess,
        "down_weeks": down,
        "drawdown_overlap": overlap,
        "holdings_overlap": held,
    }
    for name, table in tables.items():
        table.round(4).to_csv(OUT / f"{name}.csv")
    summary.round(4).to_csv(OUT / "summary.csv")
    (OUT / "report.html").write_text(report(tables, summary, groups, effective, share[-1], factor))
    print(
        f"{curves.shape[1]} strategies ({len(groups)} groups), common window "
        f"{common.index[0].date()} to {common.index[-1].date()} ({len(common)} weeks)"
    )
    print(
        f"effective independent bets among the groups: {effective:.2f} of {len(groups)} "
        f"(first factor {share[-1]:.0%})"
    )
    print(f"written to {OUT}")


# --- HTML ---------------------------------------------------------------------------------------


def shade(value: float, low: float, high: float, diverging: bool) -> str:
    if value != value:
        return "background:#f3f3f3;color:#aaa"
    span = high - low or 1
    t = min(1.0, max(0.0, (value - low) / span))
    if diverging:  # blue (negative) - white - red (positive correlation)
        mid = (0 - low) / span
        if t >= mid:
            k = (t - mid) / (1 - mid) if mid < 1 else 0
            r, g, b = 255, int(255 - 140 * k), int(255 - 160 * k)
        else:
            k = (mid - t) / mid if mid > 0 else 0
            r, g, b = int(255 - 150 * k), int(255 - 100 * k), 255
    else:
        r, g, b = 255, int(255 - 150 * t), int(255 - 190 * t)
    dark = (r + g + b) < 460
    return f"background:rgb({r},{g},{b});color:{'#fff' if dark else '#111'}"


def table_html(table: pd.DataFrame, title: str, note: str, pct: bool, diverging: bool) -> str:
    values = table.values[np.isfinite(table.values)]
    off = table.where(~np.eye(len(table), dtype=bool)).values
    off = off[np.isfinite(off)]
    low = float(min(off.min(), 0)) if diverging and len(off) else 0.0
    high = float(off.max()) if len(off) else 1.0
    head = "".join(f"<th><div>{html.escape(str(c))}</div></th>" for c in table.columns)
    body = []
    for idx, row in table.iterrows():
        cells = []
        for col, v in row.items():
            text = "" if v != v else (f"{v:.0%}" if pct else f"{v:.2f}")
            style = shade(v, low, high, diverging) if idx != col else "background:#222;color:#fff"
            cells.append(f'<td style="{style}">{text}</td>')
        body.append(f"<tr><th class='r'>{html.escape(str(idx))}</th>{''.join(cells)}</tr>")
    del values
    return (
        f"<h2>{html.escape(title)}</h2><p class='n'>{html.escape(note)}</p>"
        f"<div class='w'><table><tr><th></th>{head}</tr>{''.join(body)}</table></div>"
    )


def report(tables, summary, groups, effective, first_share, factor) -> str:
    notes = {
        "returns": (
            "Weekly return correlation",
            "Pearson, pairwise over common weeks (blank under 52). Red = move together.",
            False,
            False,
        ),
        "excess": (
            "Excess correlation (common factor removed)",
            "Each strategy's weekly return minus beta x the average of the saved Broad groups. "
            "Red = still alike after the shared move; blue = opposite once it is removed.",
            False,
            True,
        ),
        "down_weeks": (
            "Correlation in the worst 10% of weeks",
            "Weeks the common factor is in its worst decile. Higher than the all-weeks figure "
            "= they fall together.",
            False,
            False,
        ),
        "drawdown_overlap": (
            "Drawdown overlap",
            "Of the weeks either is more than 10% below its own peak, the share where both are.",
            True,
            False,
        ),
        "holdings_overlap": (
            "This week's holdings overlap",
            "Sum of the smaller weight per name: 100% = the same portfolio.",
            True,
            False,
        ),
    }
    parts = []
    s = summary.copy()
    for col in ("cagr", "max_dd", "vol"):
        s[col] = s[col].map(lambda v: f"{v:.1%}")
    for col in (
        "beta_to_factor",
        "avg_corr",
        "closest_corr",
        "least_alike_corr",
        "avg_excess_corr",
    ):
        s[col] = s[col].map(lambda v: "" if v != v else f"{v:.2f}")
    rows = "".join(
        "<tr>" + "".join(f"<td>{html.escape(str(v))}</td>" for v in [i, *r.values]) + "</tr>"
        for i, r in s.iterrows()
    )
    head = "".join(f"<th>{html.escape(c)}</th>" for c in ["strategy", *s.columns])
    parts.append(
        f"<h2>Summary</h2><div class='w'><table class='s'><tr>{head}</tr>{rows}</table></div>"
    )
    for name, table in tables.items():
        title, note, pct, div = notes[name]
        parts.append(table_html(table, title, note, pct, div))
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Momentum correlation POC</title>
<style>
body{{font:13px/1.4 -apple-system,system-ui,sans-serif;margin:24px;color:#111}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 2px}}
.n{{color:#555;margin:0 0 8px;max-width:900px}}
.w{{overflow:auto}} table{{border-collapse:collapse}} td,th{{padding:3px 6px;border:1px solid #e3e3e3;white-space:nowrap}}
td{{text-align:center;min-width:34px;font-variant-numeric:tabular-nums}}
th div{{writing-mode:vertical-rl;transform:rotate(180deg);max-height:190px;overflow:hidden;text-align:left}}
th.r{{text-align:right;font-weight:500;position:sticky;left:0;background:#fff}}
table.s td{{text-align:left}} .k{{background:#f6f6f6;padding:10px 14px;border-radius:6px;display:inline-block}}
</style></head><body>
<h1>Momentum strategies: how alike are they? (BL-114 POC)</h1>
<p class="n">Saved strategies' stored weekly equity curves; a group is its sleeves blended at equal capital. In-sample and descriptive: these curves were picked after the results were seen.</p>
<p class="k">Among the {len(groups)} saved groups, the correlation matrix has the equivalent of <b>{effective:.2f}</b> independent bets; its first factor carries <b>{first_share:.0%}</b> of the variance. The common factor used for the excess view is the groups' average return.</p>
{"".join(parts)}
</body></html>"""


if __name__ == "__main__":
    main()
