# StockScans custom-index catalog

Source: https://www.stockscans.in/custom-index (StockScans, by SOIC Technologies Pvt Ltd),
read 2026-09-29. These are hand-curated thematic stock groupings with no official NSE index
equivalent for most of them — finer-grained and more pure-play than NSE's own sectoral/thematic
indices (see `sources.py`'s `CATEGORY_SLUGS` for those). No public API was found for this site;
each entry was read one at a time through the site's own UI, not scraped in bulk.

**All 46 have now been pulled into `category_extras.csv`** (2026-09-29). Where a StockScans name
would collide with an existing official NSE category already in `CATEGORY_SLUGS`, `" (custom)"`
is appended to keep the two sources distinct (`PSU Banks (custom)` vs `Nifty PSU Bank`,
`Cements (custom)` vs `Nifty Cement`, `Hospitals (custom)` vs `Nifty Hospitals`, `Railways
(custom)` vs `Nifty India Railways PSU`) — the StockScans list is usually a tighter, more
pure-play group than the official one, not a duplicate.

10 of 259 listed constituents across all 46 categories were excluded (no price history at all in
`data/stocks/daily.parquet` — very recent/thin listings): JAGAJITIND, JAYBEE, VILAS, MVKAGRO,
VMARCIND, SRAMSET, ALPEXSOLAR, ORIANA, INFLAME, BEWLTD. 2 more were excluded earlier from
Diamonds/Gems/Jewellery specifically (KHAZANCHI, GARGI). All exclusions are silent gaps, not
errors — `run_inner_category_backtest` logs missing symbols as a warning, never fails the run.

## All 46 categories, stock count as fetched

| Category | Stocks | Category | Stocks |
|---|---|---|---|
| CDMO | 20 | Consumer Electronics EMS | 7 |
| Hospitals (custom) | 20 | FMCG - DAIRY | 7 |
| Hotels | 20 | Logistics | 7 |
| Cements (custom) | 18 | Paints | 7 |
| Diamonds Gems Jewellery | 16 | Tubes & Tyres | 7 |
| PSU Banks (custom) | 13 | Cables - Power | 7 |
| Alcoholic Beverages | 12 | Finance - AMC | 7 |
| Transmission | 10 | Agrochemical Domestic | 6 |
| Transformer / CRGO | 9 | Contract Manufacturing | 5 |
| Sugar | 8 | Middle Class Apparel | 6 |
| Mining / Minerals | 8 | Opalware / Kitchenware | 6 |
| QSR | 6 | Paper | 6 |
| Railways (custom) | 6 | Small Finance Banks | 6 |
| Solar | 6 | Water EPC | 6 |
| Data Centre | 5 | Affordable Housing Finance | 5 |
| Micro Finance | 5 | Gold Loan Finance | 5 |
| Pre-Engineered Buildings | 5 | Polyester Films | 5 |
| Steel Pipes | 5 | Shipping | 5 |
| Heavy Engineering Equipment | 5 | Commercial Vehicle Finance | 4 |
| Co-Working | 4 | Liquid Handling Terminals | 4 |
| PET Waste Recycling | 4 | Private Large Banks | 4 |
| Refrigerant Gas | 4 | Credit Ratings | 3 |
| Geospatial | 2 | | |

## Verified

Ran real backtests (not mocked) for a sample beyond the original top 5 — PSU Banks (custom),
Paints, Tubes & Tyres, Railways (custom) — all completed with no NaN, real numbers. Full
package test suite (394 passed / 1 skipped) and ruff clean after all 46 were added.
