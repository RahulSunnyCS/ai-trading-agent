"""BL-042 Phase 3: a chart gallery the owner labels Correct / Wrong / Unsure.

Samples (seeded, so the same detections give the same gallery):

- `per_pattern` detected bases per pattern, stratified by year (an *episode* is one base, shown
  at the first week it was detected);
- `near_misses` per pattern: bases that only pass with every float threshold loosened by
  `LOOSEN` (max limits x LOOSEN, min limits / LOOSEN) and that the real detector did not find
  within two weeks. They are mixed in unmarked, so the labels also show what the detector misses.

Each chart ends on the detection day (nothing after it is drawn) and hides the symbol and the
exact date: the owner judges the shape, not what the stock did next. The manifest that maps a
sample id back to its symbol, week and kind stays in `data/patterns/` with the page.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import numpy as np
import pandas as pd

from . import criteria, detector_params
from .bars import SymbolBars, split_symbols
from .common import states
from .features import SCANNERS
from .formation import episodes

LOOSEN = 1.3
SEED = 41
TEMPLATE = Path(__file__).with_name("gallery_template.html")
LEAD_DAYS = {"tight_range": 120, "flag": 60}
LEAD_WEEKS = {"cup_handle": 26}
TITLES = {"tight_range": "Tight range", "flag": "Bull flag", "cup_handle": "Cup and handle"}


def loosened(params, mode: str | None = None):
    """Every float threshold relaxed: names starting max_ grow by LOOSEN, min_ shrink by it
    (a dict under a max_/min_ key inherits its direction). Day/week counts and switches stay."""
    if isinstance(params, dict):
        out = {}
        for key, value in params.items():
            child = "max" if key.startswith("max_") else "min" if key.startswith("min_") else mode
            out[key] = loosened(value, child)
        return out
    if isinstance(params, float) and mode == "max":
        return params * LOOSEN
    if isinstance(params, float) and mode == "min":
        return params / LOOSEN
    return copy.deepcopy(params)


def _stratified(frame: pd.DataFrame, count: int, rng: np.random.Generator) -> pd.DataFrame:
    """Round-robin over years, random within a year, until `count` rows."""
    if len(frame) <= count:
        return frame
    pools = {
        year: list(rng.permutation(part.index))
        for year, part in frame.groupby(frame["week"].dt.year)
    }
    chosen: list = []
    while len(chosen) < count and any(pools.values()):
        for year in sorted(pools):
            if pools[year] and len(chosen) < count:
                chosen.append(pools[year].pop())
    return frame.loc[chosen]


def near_misses(
    daily: pd.DataFrame, detections: pd.DataFrame, pattern: str, symbols: list[str]
) -> pd.DataFrame:
    """Loose-only episodes for `pattern` on `symbols`, as detection rows (first week each)."""
    params = loosened(detector_params(pattern))
    found = []
    for bars in split_symbols(daily[daily["symbol"].isin(symbols)]).values():
        found.extend(states(bars, SCANNERS[pattern](bars, params), pattern))
    if not found:
        return pd.DataFrame(columns=detections.columns)
    loose = pd.DataFrame(found)
    since = pd.Timestamp(criteria()["windows"]["development"]["from"])
    loose = loose[loose["week"] >= since]
    loose_eps = episodes(loose)
    strict = detections[detections["pattern"] == pattern]
    strict_weeks = {(s, w) for s, w in zip(strict["symbol"], strict["week"], strict=True)}
    keep = []
    for ep in loose_eps.itertuples(index=False):
        near = {(ep.symbol, ep.week + pd.Timedelta(weeks=d)) for d in range(-2, 3)}
        if not near & strict_weeks:
            keep.append(ep)
    keyed = pd.DataFrame(keep, columns=loose_eps.columns)
    rows = loose.merge(keyed[["pattern", "symbol", "base_start", "week"]])
    rows["geometry"] = rows["geometry"].map(lambda g: json.dumps(g, sort_keys=True))
    return rows


def _chart(bars: SymbolBars, row: pd.Series) -> dict:
    """Bars from the lead-in to the detection day, in prices as traded on the detection day."""
    end = int(np.searchsorted(bars.dates, np.datetime64(row["base_end"]), side="right")) - 1
    start_day = int(np.searchsorted(bars.dates, np.datetime64(row["base_start"])))
    scale = bars.scale[end]
    if row["pattern"] in LEAD_WEEKS:
        w = bars.weekly()
        last = int(np.searchsorted(bars.week_end, end))
        first_week = int(np.searchsorted(bars.week_end, start_day))
        lo = max(0, first_week - LEAD_WEEKS[row["pattern"]])
        dates = [
            str(np.datetime_as_string(bars.dates[bars.week_end[k]], unit="D"))
            for k in range(lo, last + 1)
        ]
        opens = [bars.open[w.start[k]] for k in range(lo, last + 1)]
        series = (
            opens,
            w.high[lo : last + 1],
            w.low[lo : last + 1],
            w.close[lo : last + 1],
            w.volume[lo : last + 1],
        )
        unit = "week"
    else:
        lo = max(0, start_day - LEAD_DAYS[row["pattern"]])
        sl = slice(lo, end + 1)
        dates = [str(d) for d in np.datetime_as_string(bars.dates[sl], unit="D")]
        series = (bars.open[sl], bars.high[sl], bars.low[sl], bars.close[sl], bars.volume[sl])
        unit = "day"
    o, h, low, c, v = (np.asarray(s, dtype=float) for s in series)
    return {
        "unit": unit,
        "d": dates,
        "o": np.round(o / scale, 2).tolist(),
        "h": np.round(h / scale, 2).tolist(),
        "l": np.round(low / scale, 2).tolist(),
        "c": np.round(c / scale, 2).tolist(),
        "v": np.round(v * scale).astype(int).tolist(),
    }


def build(
    daily: pd.DataFrame,
    detections: pd.DataFrame,
    out_dir: Path,
    *,
    per_pattern: int | None = None,
    near: int | None = None,
    echo=print,
) -> tuple[Path, Path]:
    """Write `gallery.html` (the page to publish) and `gallery_manifest.json` into `out_dir`."""
    spec = criteria()["phase_3_gallery"]
    per_pattern = per_pattern or spec["sample_per_pattern"]
    near = near or spec["near_misses_per_pattern"]
    rng = np.random.default_rng(SEED)
    picked = []
    symbols = sorted(daily["symbol"].unique())
    probe = list(rng.choice(symbols, size=min(250, len(symbols)), replace=False))
    for pattern in criteria()["patterns_tested"]:
        mine = detections[detections["pattern"] == pattern]
        eps = episodes(mine).merge(mine, on=["pattern", "symbol", "base_start", "week", "state"])
        eps = eps.drop_duplicates(["pattern", "symbol", "base_start"])
        picked.append(_stratified(eps, per_pattern, rng).assign(kind="detected"))
        misses = near_misses(daily, detections, pattern, probe)
        misses = episodes(misses).merge(
            misses, on=["pattern", "symbol", "base_start", "week", "state"]
        )
        misses = misses.drop_duplicates(["pattern", "symbol", "base_start"])
        picked.append(_stratified(misses, near, rng).assign(kind="near_miss"))
        echo(
            f"{pattern}: {len(eps)} episodes, {len(misses)} near-miss episodes "
            f"on {len(probe)} symbols"
        )
    sample = pd.concat(picked, ignore_index=True)
    sample = sample.iloc[rng.permutation(len(sample))].reset_index(drop=True)

    by_symbol = split_symbols(daily[daily["symbol"].isin(sample["symbol"].unique())])
    items, manifest = [], []
    for n, row in sample.iterrows():
        sid = f"s{n + 1:03d}"
        geometry = (
            json.loads(row["geometry"]) if isinstance(row["geometry"], str) else row["geometry"]
        )
        items.append(
            {
                "id": sid,
                "pattern": row["pattern"],
                "title": TITLES[row["pattern"]],
                "year": int(row["week"].year),
                "pivot": round(float(row["pivot"]), 2),
                "base_start": str(pd.Timestamp(row["base_start"]).date()),
                "base_end": str(pd.Timestamp(row["base_end"]).date()),
                "geometry": geometry,
                "chart": _chart(by_symbol[row["symbol"]], row),
            }
        )
        manifest.append(
            {
                "id": sid,
                "symbol": row["symbol"],
                "week": str(row["week"].date()),
                "pattern": row["pattern"],
                "state": row["state"],
                "kind": row["kind"],
                "base_start": str(pd.Timestamp(row["base_start"]).date()),
                "geometry": geometry,
            }
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    page = out_dir / "gallery.html"
    payload = json.dumps(items, separators=(",", ":")).replace("</", "<\\/")
    page.write_text(TEMPLATE.read_text().replace("__GALLERY_DATA__", payload))
    manifest_path = out_dir / "gallery_manifest.json"
    manifest_path.write_text(
        json.dumps({"seed": SEED, "loosen": LOOSEN, "items": manifest}, indent=1)
    )
    echo(f"{len(items)} charts -> {page} ({page.stat().st_size / 1e6:.1f} MB)")
    return page, manifest_path
