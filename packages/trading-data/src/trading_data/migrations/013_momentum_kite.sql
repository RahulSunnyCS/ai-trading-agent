-- BL-142 Phase 1: the Momentum money is on Zerodha Kite. Holdings snapshots can come from Kite
-- (read-only), the owner's holdings source can be 'kite', and each Kite snapshot keeps the free
-- equity cash read with it (Kite's margins endpoint, `net`), which a due sleeve's rebalance uses.
--
-- DuckDB cannot alter a CHECK constraint, so the two tables whose CHECK lists the sources are
-- rebuilt: a new table with the wider CHECK, the rows copied, the old one dropped, the new one
-- renamed. Every column and row is kept. momentum_holdings' key gains `source`, so a Kite and a
-- Fyers snapshot taken in the same second never collide.

CREATE TABLE momentum_holdings_new (
    owner       TEXT NOT NULL,
    synced_at   TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('fyers', 'paste', 'kite')),
    symbol      TEXT NOT NULL,
    quantity    DOUBLE NOT NULL,
    avg_price   DOUBLE,
    PRIMARY KEY (owner, synced_at, source, symbol)  -- two sources may sync in the same second
);
INSERT INTO momentum_holdings_new
SELECT owner, synced_at, source, symbol, quantity, avg_price FROM momentum_holdings;
DROP TABLE momentum_holdings;
ALTER TABLE momentum_holdings_new RENAME TO momentum_holdings;

CREATE TABLE momentum_owner_settings_new (
    owner            TEXT PRIMARY KEY,
    min_trade_rs     DOUBLE NOT NULL DEFAULT 10000,
    extra_cash_rs    DOUBLE NOT NULL DEFAULT 0,
    -- 'paper', 'fyers' or (BL-142) 'kite': where Your orders reads what the owner holds.
    holdings_source  TEXT NOT NULL DEFAULT 'paper'
        CHECK (holdings_source IN ('paper', 'fyers', 'kite')),
    paper_capital_rs DOUBLE NOT NULL DEFAULT 100000,
    updated_at       TEXT
);
INSERT INTO momentum_owner_settings_new
SELECT owner, min_trade_rs, extra_cash_rs, holdings_source, COALESCE(paper_capital_rs, 100000),
       updated_at
FROM momentum_owner_settings;
DROP TABLE momentum_owner_settings;
ALTER TABLE momentum_owner_settings_new RENAME TO momentum_owner_settings;

-- The free cash read alongside a holdings snapshot (same owner, synced_at and source). Only Kite
-- snapshots have one; a snapshot without a row here simply has no cash reading.
CREATE TABLE IF NOT EXISTS momentum_cash (
    owner      TEXT NOT NULL,
    synced_at  TEXT NOT NULL,
    source     TEXT NOT NULL,
    cash_rs    DOUBLE NOT NULL,
    PRIMARY KEY (owner, synced_at, source)
);
