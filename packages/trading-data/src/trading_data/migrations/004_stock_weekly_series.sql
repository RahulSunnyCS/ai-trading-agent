-- 004: the Nifty 50 stock dataset's benchmark TRIs and cash NAV (data/stocks/
-- benchmarks_weekly.csv, cash_weekly.csv) get their own table instead of sharing
-- 002's `momentum_prices`, which 003 had them reuse.
--
-- Sharing broke in two ways. `momentum_prices` is wholesale-replaced from the ETF
-- pipeline's data/ files on every `mbt weekly` run (db_migrate.import_momentum_prices,
-- via local_store.push_dir), which deleted the three TRI series outright — the stock
-- dataset then crashed reading them. And the stock cash series (from 2011) and the ETF
-- dataset's cash column (from 2016) are both named 'Cash (liquid fund)', so they
-- collided on (instrument, kind='weekly', date): whichever import ran last won, and the
-- ETF reader (kind='weekly', every instrument) also picked up the TRI columns.
-- With its own table, `momentum_prices` has exactly one writer again.
--
-- `series` is the canonical output name ui_data.py uses ('Nifty 50 TRI', ...,
-- 'Cash (liquid fund)'). Any TRI rows 003 left in momentum_prices are moved here; the
-- shared cash rows cannot be told apart, so they stay — `mbt local migrate` refills
-- this table from data/stocks/ and the ETF import owns momentum_prices' cash rows.

CREATE TABLE stock_weekly_series (
    series  TEXT NOT NULL,
    week    DATE NOT NULL,
    close   DOUBLE NOT NULL,
    PRIMARY KEY (series, week)
);

INSERT INTO stock_weekly_series
SELECT instrument, date, close FROM momentum_prices
WHERE kind = 'weekly'
  AND instrument IN ('Nifty 50 TRI', 'Nifty200 Momentum 30 TRI', 'Nifty50 Equal Weight TRI');

DELETE FROM momentum_prices
WHERE kind = 'weekly'
  AND instrument IN ('Nifty 50 TRI', 'Nifty200 Momentum 30 TRI', 'Nifty50 Equal Weight TRI');
