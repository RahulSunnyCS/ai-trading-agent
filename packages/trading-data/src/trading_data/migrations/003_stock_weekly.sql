-- 003: the Nifty 50 stock-momentum dataset's WEEKLY, pre-adjusted series (built by `mbt
-- stocks fetch` into data/stocks/nifty50_weekly_{tr,price}.csv and
-- nifty50_membership_weekly.csv). Separate from `bars_1d_stock` (002's DAILY, unadjusted
-- raw bars): these are the corporate-action-adjusted, already-reindexed-to-a-weekly-
-- calendar series `stocks/ui_data.py::load_stock_dataset` hands straight to the engine —
-- recomputing that adjustment from daily bars here would duplicate real logic
-- (stocks/adjust.py) for no benefit; storing its cached output is the same choice
-- `momentum_prices` (002) already made for the ETF dataset's weekly_closes.csv.
--
-- benchmarks_weekly.csv and cash_weekly.csv are plain named weekly series — no new table,
-- they go into 002's `momentum_prices` (kind='weekly'), same shape it already holds.

CREATE TABLE stock_weekly_prices (
    company_id  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('tr', 'price')),  -- total-return vs. plain price
    week        DATE NOT NULL,
    close       DOUBLE NOT NULL,
    PRIMARY KEY (company_id, kind, week)
);

CREATE TABLE stock_membership_weekly (
    company_id  TEXT NOT NULL,
    week        DATE NOT NULL,
    is_member   BOOLEAN NOT NULL,
    PRIMARY KEY (company_id, week)
);
