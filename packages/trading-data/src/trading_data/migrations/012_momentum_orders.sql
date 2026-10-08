-- BL-051 Phase 3: Momentum › This week's "Your orders". What the owner holds, how a holding is
-- treated, the owner's order settings, and the orders computed each Friday. Every row carries
-- an owner ID so friends can be added later; only the owner exists for now.
--
-- Timestamps are ISO 8601 TEXT (as in 007): returning TIMESTAMPTZ to Python makes DuckDB import
-- pytz, which these packages do not depend on.

-- One row per holding per sync: a sync is a complete snapshot, read from Fyers (read-only) or
-- pasted, never merged with an earlier one.
CREATE TABLE momentum_holdings (
    owner       TEXT NOT NULL,
    synced_at   TEXT NOT NULL,                -- ISO 8601 with offset: the snapshot this row belongs to
    source      TEXT NOT NULL CHECK (source IN ('fyers', 'paste')),
    symbol      TEXT NOT NULL,                -- NSE symbol, no exchange prefix or series (SBIN)
    quantity    DOUBLE NOT NULL,
    avg_price   DOUBLE,
    PRIMARY KEY (owner, synced_at, symbol)
);

-- A holding the strategy must not touch: left out of the portfolio, or counted as cash (a
-- liquid ETF).
CREATE TABLE momentum_holding_rules (
    owner      TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    treatment  TEXT NOT NULL CHECK (treatment IN ('exclude', 'cash')),
    PRIMARY KEY (owner, symbol)
);

CREATE TABLE momentum_owner_settings (
    owner            TEXT PRIMARY KEY,
    -- Top-ups and trims smaller than this are skipped; full exits and new buys always go through.
    min_trade_rs     DOUBLE NOT NULL DEFAULT 10000,
    -- Cash held for the strategy outside the broker account.
    extra_cash_rs    DOUBLE NOT NULL DEFAULT 0,
    -- 'paper': orders against the paper portfolio (the model at the owner's capital) until money
    -- goes in; 'fyers': against the synced holdings.
    holdings_source  TEXT NOT NULL DEFAULT 'paper' CHECK (holdings_source IN ('paper', 'fyers')),
    -- The paper portfolio's size while holdings_source is 'paper' (owner, 2026-10-08: Rs 1 lakh).
    paper_capital_rs DOUBLE NOT NULL DEFAULT 100000,
    updated_at       TEXT
);

-- The orders computed for a week (the 14:15 run, or one asked for on the page). Kept, not
-- overwritten, so "Since your 14:15 orders" can compare them with the 19:30 final.
CREATE TABLE momentum_orders (
    owner            TEXT NOT NULL,
    week             DATE NOT NULL,
    created_at       TEXT NOT NULL,
    trigger          TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    favourite_id     TEXT NOT NULL,
    holdings_source  TEXT NOT NULL,
    payload          TEXT NOT NULL,           -- JSON: rows, totals, prices and where they came from
    PRIMARY KEY (owner, week, created_at)
);
