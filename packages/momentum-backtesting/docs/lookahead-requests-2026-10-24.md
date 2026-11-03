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

## Fixed 2026-10-25 (owner: "fix F6")

Branch `fix/momentum-f6-point-in-time-ranking`, stacked on the PR that added the check. **Merged
2026-10-28** (PRs #318, #319, #322, merge commit `778ba02e`): the fixed ranking is what every run
and the Friday signal use from then on.

What changed (Broad only; ETF, Stock and Custom Index results are byte-identical, all ten golden
controls and every live control run):

1. **The cross-section is the week's point-in-time members behind the gate** (plus the atomic
   instruments). `engine.compute_ranks(..., cross_section=)` takes a week x column table; an
   instrument outside it that week gets no rank and takes no part in the voladj mean and spread or
   in the rank positions. `broad.cross_section_mask` builds it from `stock_membership`;
   `compute_universe_base`, the live preview (`rebalance.live_broad_ranking`) and the stock-tilt
   ranking (`levers.grouped_momentum_ranks`, which ranked the whole frame a second time) all use it.
   `persisted_broad_ranking` and the live ranking now carry membership forward so the tilt sees it
   for the sentinel and live weeks.
2. **Only the weeks after a stale column's last real price are forward-filled** in the Broad price
   frame (`build_stock_weekly_prices(fill_internal_gaps=False)`). Gaps inside a history stay empty;
   Broad already values positions on a forward-filled copy, so a held stock in a gap keeps a price.
   Custom Index still fills the whole column.

Check (same dates, same two groups, `mbt audit lookahead-requests`): **24 of 24 pairs identical**
(orders, equity curve, KPIs, rotations, yearly, open positions). Before the second change the
stock-tilt sleeves of the ensemble still differed; that is how the tilt call was found.

### What it does to the numbers (live data, headline run, before to after)

The check removes a hindsight-bearing cross-section, so levels move, not just noise. Mean CAGR over
a strategy's sleeves, pre-tax as the dashboard shows it:

| Strategy | Sleeves | CAGR before | CAGR after | Change | Max drawdown before / after |
|---|---|---|---|---|---|
| **Four Sectors Monthly, No Tilt (followed)** | 4 | 42.93% | 35.03% | **-7.90** | -30.8 / -36.9 |
| Four Sectors, Quick Exit | 4 | 38.65% | 28.45% | -10.20 | -33.1 / -37.7 |
| Six Sectors Monthly, No Tilt | 4 | 36.92% | 31.62% | -5.29 | -28.5 / -34.1 |
| Five Sectors, Wide Pool | 4 | 36.02% | 31.61% | -4.40 | -30.9 / -31.4 |
| Five Sectors, Stock Tilt | 4 | 39.87% | 35.88% | -3.99 | -29.6 / -35.6 |
| Six Sectors, Make Room | 4 | 37.05% | 33.21% | -3.84 | -32.6 / -38.1 |
| Five Sectors Monthly | 4 | 39.31% | 35.82% | -3.49 | -29.9 / -37.0 |
| Trio Fortnightly | 2 | 42.18% | 40.65% | -1.53 | -26.2 / -32.9 |
| Phase 6 ensemble (4 saved sleeves) | 1 each | 29.11 to 34.60 | 27.66 to 33.72 | -0.63 to -1.45 | |
| Five Sectors, Rank Sum | 4 | 39.43% | 39.40% | -0.03 | -30.8 / -37.0 |
| Four Sectors, Half Tilt | 4 | 39.07% | 39.47% | +0.40 | -32.0 / -34.8 |

Eight golden Broad scenarios moved by -3.44 to +0.35 points (`tests/golden/CHANGELOG.md`).

Reading it: the old ranking let stocks that were not in the week's universe set the scale the
members were scored on. Removing them lowers the headline for most strategies (3.5 to 10 points
for seven of the eleven) and deepens the average worst fall for most (0.5 to 9 points; one
ensemble sleeve gets shallower). The followed strategy still beats
the momentum index by a wide margin on this headline, but BL-010's figures and the search that
picked these strategies both used the old ranking, so the selection itself carries some of the
hindsight. Nothing here re-ran the search.

### What the merge changed in live use (written before it, 2026-10-25)

- **That Friday's orders for lot 1 of the followed strategy changed.** With the old ranking the model
  buys NAZARA, GRWRHITECH, THELEELA and sells ATHERENERG, AZAD, KPIL; with the fix it buys NAZARA and
  SYRMA, adds ATHERENERG, trims CUPID and sells ACMESOLAR, KIRLOSENG, NAVINFLUOR#2. (Lots 2 to 4 have
  no trades that week either way.) It was merged on 2026-10-28, a Wednesday, so the
  first Friday to trade on the fixed ranking is 2026-10-30.
- Rank numbers in "why this pick" texts and the Momentum Scores page are unchanged in meaning; the
  Scores page already ranked within the members.

### Not done

- `score="residual"` (killed in BL-085, off by default) does not take the cross-section.
- Custom Index keeps whole-column gap filling and its own cross-section.
- Search results already on disk (`data/search/*`) and the BL-010 write-ups were produced with the
  old ranking and are not re-run. Re-running the search on the fixed ranking is BL-176.
- `live_rules.toml`'s drawdown rules were set against the old backtest; the followed strategy's
  backtest drawdown is now about 6 points deeper.
