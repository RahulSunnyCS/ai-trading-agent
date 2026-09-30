-- 002: momentum-backtesting's data — companies/renames/corporate actions/index &
-- category membership (all curated CSVs; the CSVs stay the master, this is an import
-- for querying — see reference.py's docstring for why that pattern is used), the
-- small cross-instrument price series (momentum_prices, mirroring the retired Neon
-- schema), and the weekly signal history (momentum_signals).
--
-- Individual stocks' daily OHLCV bars are NOT a table here — like bars_1m, they are
-- Parquet under lake/bars_1d/asset=stock/year=<YYYY>/data.parquet, exposed as the
-- bars_1d_stock view (see db.py's LAKE_VIEWS). Momentum's index/ETF/commodity series
-- stay in momentum_prices: unlike a stock, "Silver" isn't one instrument with a
-- clean OHLC bar — it is several derived series (signal price, traded ETF price,
-- premium-to-NAV, weekly close) keyed by a plain name, exactly as the file layout
-- under data/daily*, data/etf_premium.csv and data/weekly_closes.csv already has it.

CREATE TABLE companies (
    company_id  TEXT PRIMARY KEY,
    name        TEXT NOT NULL
);

-- A company's NSE trading symbol over time (e.g. MUNDRAPORT -> ADANIPORTS). Every
-- `instruments` row for a stock is keyed on ONE literal symbol (see instrument_key);
-- a company that renamed has more than one instrument row, linked by company_id.
CREATE TABLE company_symbols (
    company_id  TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    from_date   DATE NOT NULL,
    to_date     DATE,
    source      TEXT,
    PRIMARY KEY (company_id, symbol, from_date)
);

-- No PRIMARY KEY: subject_sha1 (the dedup key against re-fetches) is null for 16 of
-- ~1900 rows, and DuckDB (like Postgres) rejects a null key column. The migration
-- re-imports this table wholesale each run — the CSV/parquet is the master copy.
CREATE TABLE corporate_actions (
    company_id    TEXT NOT NULL,
    symbol_at_ex  TEXT NOT NULL,
    session       TEXT,
    ex_date       DATE NOT NULL,
    kind          TEXT NOT NULL,
    factor        DOUBLE,
    dividend      DOUBLE,
    source        TEXT,
    subject_sha1  TEXT
);

CREATE TABLE index_membership (
    index_name  TEXT NOT NULL,
    company_id  TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    from_date   DATE NOT NULL,
    to_date     DATE,
    kind        TEXT,
    source      TEXT,
    source2     TEXT,  -- nifty50_membership.csv's secondary citation column
    PRIMARY KEY (index_name, company_id, from_date)
);

CREATE TABLE category_membership (
    category           TEXT NOT NULL,
    year                INTEGER NOT NULL,
    symbol              TEXT NOT NULL,
    source_tier         TEXT,
    wayback_timestamp   TEXT,
    PRIMARY KEY (category, year, symbol)
);

-- Mirrors the retired Neon schema exactly (packages/momentum-backtesting/src/
-- momentum_backtesting/store.py), so `mbt`'s existing rows_from_dir/write_dir
-- round-trip logic needs no reshaping to read from here instead.
CREATE TABLE momentum_prices (
    instrument  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (
        kind IN ('signal', 'etf', 'at10_index', 'at10_etf', 'premium', 'weekly')
    ),
    date        DATE NOT NULL,
    open        DOUBLE,
    close       DOUBLE NOT NULL,
    PRIMARY KEY (instrument, kind, date)
);
CREATE TABLE momentum_signals (
    week          DATE NOT NULL,
    run_kind      TEXT NOT NULL CHECK (run_kind IN ('preview', 'final')),
    config_label  TEXT NOT NULL,
    generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload       JSON NOT NULL,
    PRIMARY KEY (week, run_kind, config_label)
);
