-- Migration 001: Core schema — paper_trades, market_ticks, straddle_snapshots

-- ---------------------------------------------------------------------------
-- paper_trades
-- ---------------------------------------------------------------------------
-- Stores every simulated straddle entry and its full lifecycle. Each row
-- represents one paper trade opened by a personality. The straddle is always
-- sold (short), so gross_pnl is positive when the straddle decays and negative
-- when it expands beyond the entry value.
--
-- lowest_straddle_value_seen tracks the intra-trade minimum straddle value
-- for max-profit-point calculation (used by the Adjuster's roll trigger).
--
-- status is constrained to 'open' | 'closed' so the trigger engine can filter
-- active positions with a simple equality check rather than a NULL scan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paper_trades (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_time               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_time                TIMESTAMPTZ,
  entry_ce_strike          NUMERIC,
  entry_pe_strike          NUMERIC,
  entry_ce_price           NUMERIC,
  entry_pe_price           NUMERIC,
  exit_ce_price            NUMERIC,
  exit_pe_price            NUMERIC,
  lots                     INTEGER     NOT NULL DEFAULT 1,
  lot_size                 INTEGER     NOT NULL DEFAULT 50,
  straddle_at_entry        NUMERIC     NOT NULL,
  lowest_straddle_value_seen NUMERIC   NOT NULL,
  vix_at_entry             NUMERIC,
  spot_at_entry            NUMERIC,
  exit_reason              TEXT,
  gross_pnl                NUMERIC,
  net_pnl                  NUMERIC,
  max_drawdown             NUMERIC,
  status                   TEXT        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'closed')),
  notes                    TEXT
);

-- ---------------------------------------------------------------------------
-- market_ticks
-- ---------------------------------------------------------------------------
-- Raw tick data from the broker WebSocket (or simulator). Partitioned as a
-- TimescaleDB hypertable on `time` for efficient time-range queries.
--
-- volume and oi are nullable because the Fyers WebSocket does not always
-- include them in every tick message (sparse fields in the SDK payload).
--
-- Queries against this table MUST include a WHERE time > ... filter.
-- Full-table scans on hypertables are extremely slow (see technical.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_ticks (
  time        TIMESTAMPTZ NOT NULL,
  symbol      TEXT        NOT NULL,
  last_price  NUMERIC     NOT NULL,
  volume      BIGINT,
  oi          BIGINT
);

-- Convert market_ticks to a TimescaleDB hypertable partitioned by time.
-- if_not_exists = true makes this idempotent: re-running the migration when
-- the hypertable already exists is a no-op rather than an error.
SELECT create_hypertable('market_ticks', 'time', if_not_exists => true);

-- ---------------------------------------------------------------------------
-- straddle_snapshots
-- ---------------------------------------------------------------------------
-- 15-second ATM straddle snapshots produced by straddle-calc.ts. Used for
-- ROC/acceleration peak detection and retrospection charting.
--
-- vix is nullable because the VIX poller may not have a value at startup
-- (e.g. first snapshot arrives before the NSE API responds).
--
-- Also a TimescaleDB hypertable — same time-range filter requirement as above.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS straddle_snapshots (
  time            TIMESTAMPTZ NOT NULL,
  underlying      TEXT        NOT NULL,
  spot            NUMERIC     NOT NULL,
  atm_strike      NUMERIC     NOT NULL,
  ce_price        NUMERIC     NOT NULL,
  pe_price        NUMERIC     NOT NULL,
  straddle_value  NUMERIC     NOT NULL,
  vix             NUMERIC
);

SELECT create_hypertable('straddle_snapshots', 'time', if_not_exists => true);
