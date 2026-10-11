# Pending themes — set aside, not read by any backtest

`pending_themes.csv` holds own-research themes added in a session on 2026-10-05. **Battery
Storage (BESS) has moved out** (BL-092, 2026-10-11): its 16 stocks are in `stock_groups_dated.csv`
with launch date 2026-10-12, selectable in the Broad run from that week and never before. Three more
BESS candidates (SHILCTECH, TCPLPACK, SPMLINFRA, from an infographic, exposure unverified) wait here
until someone checks them. Still pending:

| Category | Stocks |
|---|---|
| Semiconductors | 10 |
| Nuclear Supply Chain | 9 |
| Optic Fibre | 8 |
| Data Centre Power & Cooling | 7 |

A theme leaves this file the way BESS did: rows move to `stock_groups_dated.csv` with a launch date
(no backtest sees it before then). Each row's note says whether the exposure is real revenue or still order book. Excluded for no
price history in `bars_1d_stock`: ORIANA, BONDADA, MAXVOLT, ATCENERGY (battery storage); ASMTEC,
SAHASRA (semiconductors); VALIANT, RTL, KDL (optic fibre).

**Why they are not in `category_extras.csv`.** That file is read by every "broad" run
(`categories/resolve.py`), and its tags apply to all years. These themes were picked in 2026
knowing they had become popular, so ranking them in 2017–2025 is hindsight — BL-010 finding F2.
They move into the extras file only once BL-010 Phase 3 step 3's launch-dated taxonomy exists and
each theme has a launch date (selectable only from that date on). Same columns as
`category_extras.csv`, so moving a row is a copy.
