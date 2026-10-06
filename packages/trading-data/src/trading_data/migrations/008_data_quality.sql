-- 008: one quality verdict per lake partition (asset, name, trading_day), so every day a
-- backtest might read has been judged: usable, or excluded and why. It mirrors the Parquet
-- files one-to-one — written as partitions are imported, regenerable from the files with
-- `tdata quality rebuild`. Readers (legwise's available_days) do not consult it yet; days a
-- backtest should skip can be found with
--   SELECT * FROM data_quality WHERE verdict = 'excluded'.
-- No FKs (see 001): name is the partition value (an underlying for option/future, a symbol
-- for index); run_id points at ingest_runs.run_id and is NULL when a rebuild wrote the row.
CREATE TABLE data_quality (
    asset             TEXT NOT NULL CHECK (asset IN ('option', 'future', 'index')),
    name              TEXT NOT NULL,
    trading_day       DATE NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('fyers', 'vendor')),
    verdict           TEXT NOT NULL CHECK (verdict IN ('usable', 'excluded')),
    reason            TEXT,           -- off_session_only | short_session:<n> | thin_chain:<n> | duplicate_bars:<n> | no_spot
    session_kind      TEXT NOT NULL CHECK (session_kind IN ('regular', 'special', 'off_session')),
    n_rows            BIGINT NOT NULL,
    contracts         INTEGER NOT NULL,   -- distinct instrument_id (1 for an index)
    expiries          INTEGER,            -- distinct expiry; options only
    max_bars          INTEGER NOT NULL,   -- most bars (09:15-15:29) any one instrument has; 375 = a full day
    off_session_rows  BIGINT NOT NULL DEFAULT 0,  -- rows outside 09:15-15:29; they stay in the file
    first_ts          TIMESTAMPTZ,
    last_ts           TIMESTAMPTZ,
    run_id            TEXT,
    judged_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset, name, trading_day)
);
