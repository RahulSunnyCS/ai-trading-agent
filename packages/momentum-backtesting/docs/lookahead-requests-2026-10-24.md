# Look-ahead check on the saved favourites (2026-10-24)

Question: does a favourite's backtest, stopped at a past date on today's database, equal the same
favourite run on a database that holds nothing after that date? Earlier look-ahead checks
(`tests/golden/test_lookahead.py`, `mbt audit lookahead`) never ran the point-in-time
`turnover_rank` universe or the followed strategy as saved. This one does.

```
TRADING_DATA_ROOT=/Volumes/TradingData uv run mbt audit lookahead-requests \
  --favourite "Four Sectors Monthly, No Tilt · all Fridays" --favourite "Phase 6 ensemble" \
  --cut 2019-06-28 --cut 2021-06-25 --cut 2024-03-28
```

Each saved request is posted to the real API twice per cut (`mbt audit lookahead-requests`,
`audit/request_lookahead.py`): once on the live database with `end` set to the cut, once on a copy
cut by `audit/truncate.py`. Two groups, four sleeves each, three cuts: 24 pairs. The tolerance is
a relative 1e-9 on every number; trade prices are not compared (a later split rescales a price
level, never a return).

## Result: not equal. All 24 pairs differ in something (at least the rank numbers shown in the exit reasons); the size is small.

| Group | Cuts where a sleeve's CAGR moved | Largest CAGR move | Trade lists |
|---|---|---|---|
| Four Sectors Monthly, No Tilt (followed) | sleeve 1 only: +0.12 (2021), +0.07 (2024) | 0.12 points | identical in 10 of 12 pairs; sleeve 1 has one extra trade in 2021 and in 2024 |
| Phase 6 ensemble | most sleeves, both signs | 1.03 points (2019, sleeve 1) | between 0 and 27 trades differ per sleeve (entry, exit and name, either run) |

Per sleeve, whole database against cut (CAGR in %, max drawdown never moved by more than 0.21 pt):

| Cut | Four Sectors 1 / 2 / 3 / 4 | Phase 6 1 / 2 / 3 / 4 |
|---|---|---|
| 2019-06-28 | 20.42 = 20.42 · 25.70 = 25.70 · 25.41 = 25.41 · 23.25 = 23.25 | 14.11 / 15.14 · 22.63 / 22.01 · 9.91 = 9.91 · 18.34 / 18.02 |
| 2021-06-25 | 41.68 / 41.56 · 35.25 = 35.25 · 38.13 = 38.13 · 36.51 = 36.51 | 30.99 / 31.31 · 35.18 / 34.48 · 24.91 / 24.02 · 35.47 / 35.22 |
| 2024-03-28 | 46.75 / 46.67 · 35.21 = 35.21 · 42.88 = 42.88 · 36.20 = 36.20 | 36.90 / 37.15 · 35.10 / 35.25 · 29.20 / 28.61 · 33.67 / 33.40 |

The signs are mixed, so this is noise from a point-in-time breach, not a one-way inflation of the
headline. It is still a breach: a backtest at a past date should not change when later data
arrives.

## Cause (isolated, reproduced exactly)

The ranking at a past week differs because of two things that depend on data after that week. Not
the arithmetic, not a price read.

1. **Who is in the cross-section.** The default `voladj` score z-scores each component "across
   whatever instruments have a value that week" (`engine._compute_ranks_voladj`). The stock frame
   holds every column from every year's `turnover_rank` list. A stock that traded in 2012 but only
   became liquid enough for the list in 2022 is a column from 2011 on, so it sits in the 2012
   cross-section and moves its mean and spread. At 2012-02-03 the full run ranks 964 names, the
   cut run 942.
2. **Gap handling that depends on the end of the data.** A column whose last real week falls
   short of the frame's last week counts as stale and is forward-filled over its whole length
   (`categories/prices.py`, `_forward_filled`), internal gaps included. A suspension in 2013 is
   filled if the stock is missing the newest week today, and left empty in a run stopped in 2019.
   42 columns differ this way at the 2019 cut.

Proof: take the full-data prices, keep only the cut run's columns, put the cut run's gaps back,
and rank them with the engine's own function. The result equals the cut run's stored ranks in all
605,138 cells. Keeping only the cut's columns, without the gaps, still leaves 281,734 cells
different, so both matter. Prices themselves agree up to a constant per-column rescale from later
splits (ratio constant over time for all 1,366 shared columns).

Why Four Sectors barely moves: it picks one name in each of four top categories, so a small
reshuffle of ranks rarely changes who is picked. The ensemble's wider pools (top 2, 8 to 12
holdings) have more near-ties.

## What this does and does not mean

- It does not affect the live Friday signal. Live ranking is the latest week, where the frame holds
  exactly what exists today.
- It does affect every historical Broad figure, including the ones BL-010 reports, by an amount
  that is small for the followed strategy and up to about 1 point for ensemble sleeves.
- A fix changes every Broad result (and the frozen BL-010 numbers), so it is the owner's call:
  rank over the names in that week's point-in-time universe and gate only, and forward-fill only
  the stale tail after a column's own last real week. Then re-accept the goldens and re-measure.
  Not done.
- A planted look-ahead test would not have caught this in `tests/golden/`: the fixture has 170
  stocks and the golden scenarios pin `total_market`.

## Also found on the way

- `categories/broad.py::_compute_pool_membership` used the first quarter-end's pool decision for
  the weeks before it, which reads ranks from after those weeks. With the default 52-week lookback
  those weeks have no rank, so a real run is unaffected (identical results on all seven distinct
  lookback and score combinations in the saved favourites, run on live data at end 2026-10-16).
  Fixed: those weeks now have no pool. Two new unit tests pin it
  (`tests/categories/test_broad.py`).
- The run itself was done with the pool fix applied part way through. The fix changes none of the
  results, as the comparison above shows, so the table stands.
