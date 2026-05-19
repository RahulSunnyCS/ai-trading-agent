-- Migration: 001_core_schema
-- Core schema for AI Trading Agent — hypertables, regular tables, straddle_1min
-- continuous aggregate, and all required indexes.
--
-- This migration is fully idempotent: every CREATE uses IF NOT EXISTS,
-- create_hypertable uses if_not_exists => TRUE, and index creation uses
-- IF NOT EXISTS. Running it twice produces no errors.

-- ---------------------------------------------------------------------------
-- Hypertables (partitioned on the `time` column via TimescaleDB)
-- ---------------------------------------------------------------------------

-- Raw tick data from the broker WebSocket (Fyers) or the simulator.
-- Partitioned by time because all production queries include a time-range
-- filter — full-table scans on this table would be catastrophically slow.
CREATE TABLE IF NOT EXISTS market_ticks (
  id      BIGSERIAL     NOT NULL,
  symbol  TEXT          NOT NULL,                  -- e.g. 'NSE:NIFTY50-INDEX'
  time    TIMESTAMPTZ   NOT NULL,
  ltp     NUMERIC(12,2) NOT NULL,                  -- last traded price
  volume  BIGINT,
  oi      BIGINT,                                  -- open interest
  bid     NUMERIC(12,2),
  ask     NUMERIC(12,2),
  source  TEXT          NOT NULL DEFAULT 'fyers',  -- 'fyers' | 'simulator'
  PRIMARY KEY (id, time)                           -- composite PK required by TimescaleDB hypertable
);

SELECT create_hypertable(
  'market_ticks',
  'time',
  if_not_exists => TRUE
);

-- 15-second ATM straddle calculator snapshots.
-- `roc` and `roc_acceleration` are nullable because the first few snapshots
-- after startup do not yet have enough history to compute the rate of change.
CREATE TABLE IF NOT EXISTS straddle_snapshots (
  id                BIGSERIAL     NOT NULL,
  time              TIMESTAMPTZ   NOT NULL,
  symbol            TEXT          NOT NULL,  -- underlying, e.g. 'NIFTY'
  expiry            DATE          NOT NULL,  -- weekly/monthly expiry date
  strike            NUMERIC(10,2) NOT NULL,  -- ATM strike price
  call_ltp          NUMERIC(12,2) NOT NULL,
  put_ltp           NUMERIC(12,2) NOT NULL,
  straddle_value    NUMERIC(12,2) NOT NULL,  -- call_ltp + put_ltp
  roc               NUMERIC(8,4),            -- rate of change of straddle_value
  roc_acceleration  NUMERIC(8,4),            -- second derivative (roc delta)
  vix               NUMERIC(6,2),            -- India VIX at snapshot time
  PRIMARY KEY (id, time)
);

SELECT create_hypertable(
  'straddle_snapshots',
  'time',
  if_not_exists => TRUE
);

-- Individual option leg ticks (call and put) for greeks tracking.
-- delta and iv (implied volatility) are nullable — they are only populated
-- when the broker or a pricing model provides them.
CREATE TABLE IF NOT EXISTS option_ticks (
  id      BIGSERIAL     NOT NULL,
  time    TIMESTAMPTZ   NOT NULL,
  symbol  TEXT          NOT NULL,  -- full Fyers option symbol, e.g. NSE:NIFTY25MAY24000CE
  ltp     NUMERIC(12,2) NOT NULL,
  volume  BIGINT,
  oi      BIGINT,
  delta   NUMERIC(6,4),
  iv      NUMERIC(6,4),
  PRIMARY KEY (id, time)
);

SELECT create_hypertable(
  'option_ticks',
  'time',
  if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- Regular (non-hypertable) tables
-- ---------------------------------------------------------------------------

-- Detected trading signals emitted by the peak detection engine.
-- signal_type and status use CHECK constraints rather than enums so that
-- adding new values is a migration-only change, not a type drop/recreate.
CREATE TABLE IF NOT EXISTS straddle_signals (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  time                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  symbol              TEXT          NOT NULL,
  signal_type         TEXT          NOT NULL CHECK (signal_type IN ('MOMENTUM_EXHAUSTION', 'SCHEDULED', 'PULLBACK')),
  direction           TEXT          CHECK (direction IN ('LONG', 'SHORT')),
  probability         NUMERIC(5,4),    -- relative ranking score [0,1], not a calibrated probability
  peak_roc            NUMERIC(8,4),
  peak_acceleration   NUMERIC(8,4),
  vix_at_signal       NUMERIC(6,2),
  status              TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- The 10 trading personalities plus the immutable Clockwork benchmark.
-- is_frozen = TRUE for the Clockwork row; the evolution engine must check
-- this flag and throw FROZEN_VIOLATION rather than silently skipping.
-- TIME columns store the wall-clock windows within which a personality may enter/exit.
CREATE TABLE IF NOT EXISTS personality_configs (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT          NOT NULL UNIQUE,
  description         TEXT,
  phase               INTEGER       NOT NULL DEFAULT 1,
  is_frozen           BOOLEAN       NOT NULL DEFAULT FALSE,
  entry_type          TEXT          NOT NULL DEFAULT 'MOMENTUM_EXHAUSTION',
  management_style    TEXT          NOT NULL CHECK (management_style IN ('HOLD', 'ADJUST', 'REDUCE')),
  min_probability     NUMERIC(5,4)  NOT NULL DEFAULT 0.55,
  sl_pct              NUMERIC(6,4)  NOT NULL DEFAULT 0.15,   -- stop-loss threshold as fraction
  target_pct          NUMERIC(6,4)  NOT NULL DEFAULT 0.25,   -- profit target as fraction
  tsl_trigger_pct     NUMERIC(6,4),                          -- trailing SL activation threshold (nullable — HOLD style doesn't use it)
  max_daily_loss_pct  NUMERIC(6,4)  NOT NULL DEFAULT 0.03,
  entry_window_start  TIME          NOT NULL DEFAULT '09:20',
  entry_window_end    TIME          NOT NULL DEFAULT '14:30',
  exit_time           TIME          NOT NULL DEFAULT '15:15',
  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Individual paper trade records.
-- Both FKs (personality_id, signal_id) are referenced here.
-- signal_id is nullable because SCHEDULED entries are not triggered by a
-- detected signal — they enter at a fixed time regardless.
-- market_regime is nullable on entry; the EOD retrospection engine fills
-- it in after classifying the day.
-- exit_reason uses CHECK rather than enum for the same extensibility reason
-- as signal_type above.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id        UUID          NOT NULL REFERENCES personality_configs(id),
  signal_id             UUID          REFERENCES straddle_signals(id),
  symbol                TEXT          NOT NULL,
  expiry                DATE          NOT NULL,
  strike                NUMERIC(10,2) NOT NULL,
  entry_type            TEXT          NOT NULL,
  entry_time            TIMESTAMPTZ   NOT NULL,
  entry_straddle_value  NUMERIC(12,2) NOT NULL,
  exit_time             TIMESTAMPTZ,
  exit_straddle_value   NUMERIC(12,2),
  exit_reason           TEXT          CHECK (exit_reason IN ('SL', 'TSL', 'TARGET', 'EOD', 'TIME', 'DAILY_LOSS_CAP', 'MANUAL')),
  pnl_pct               NUMERIC(8,4),
  pnl_abs               NUMERIC(12,2),
  status                TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  market_regime         TEXT          CHECK (market_regime IN ('RANGING', 'TRENDING_STRONG', 'VOLATILE_REVERTING', 'EVENT_DAY')),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- EOD per-personality analytics written by the BullMQ retrospection job.
-- UNIQUE(personality_id, trade_date) prevents duplicate retrospection rows
-- for the same personality on the same day — the job is idempotent by design.
-- proposed_adjustments is JSONB because the shape of suggestions varies by
-- rule type and will evolve as the parameter evolution engine matures.
CREATE TABLE IF NOT EXISTS retrospection_results (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id          UUID          NOT NULL REFERENCES personality_configs(id),
  trade_date              DATE          NOT NULL,
  market_regime           TEXT          NOT NULL CHECK (market_regime IN ('RANGING', 'TRENDING_STRONG', 'VOLATILE_REVERTING', 'EVENT_DAY')),
  total_trades            INTEGER       NOT NULL DEFAULT 0,
  winning_trades          INTEGER       NOT NULL DEFAULT 0,
  total_pnl_pct           NUMERIC(8,4),
  beat_clockwork_delta    NUMERIC(8,4),  -- difference vs Clockwork P&L for same day/regime
  signal_brier_score      NUMERIC(6,4),  -- calibration quality of probability scores
  management_effectiveness NUMERIC(6,4), -- management style outcome scoring
  proposed_adjustments    JSONB,
  adjustments_applied     BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (personality_id, trade_date)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- per-symbol time-range queries on the hypertable (the most common access pattern)
CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_time
  ON market_ticks (symbol, time DESC);

-- personality_configs: name lookup (already unique, but an explicit index
-- makes covering lookups faster when joining) and is_frozen for fast
-- Clockwork filter queries (most queries filter to is_frozen = FALSE)
CREATE UNIQUE INDEX IF NOT EXISTS idx_personality_configs_name
  ON personality_configs (name);

CREATE INDEX IF NOT EXISTS idx_personality_configs_is_frozen
  ON personality_configs (is_frozen);

-- position monitor: list open trades per personality
CREATE INDEX IF NOT EXISTS idx_paper_trades_personality_status
  ON paper_trades (personality_id, status);

-- signal router: fetch pending signals ordered by time
CREATE INDEX IF NOT EXISTS idx_straddle_signals_status_time
  ON straddle_signals (status, time DESC);

-- ---------------------------------------------------------------------------
-- Continuous aggregate: straddle_1min
-- ---------------------------------------------------------------------------

-- 1-minute OHLC buckets over straddle_snapshots.
-- first() and last() are TimescaleDB aggregate functions that return the
-- value from the row with the earliest/latest `time` within the bucket —
-- they produce correct open/close values even when rows arrive out of order.
-- The view is refreshed automatically by the policy added below.
CREATE MATERIALIZED VIEW IF NOT EXISTS straddle_1min
  WITH (timescaledb.continuous)
  AS
  SELECT
    time_bucket('1 minute', time) AS bucket,
    symbol,
    expiry,
    strike,
    first(straddle_value, time)   AS open,
    max(straddle_value)           AS high,
    min(straddle_value)           AS low,
    last(straddle_value, time)    AS close,
    avg(roc)                      AS avg_roc,
    avg(vix)                      AS avg_vix
  FROM straddle_snapshots
  GROUP BY bucket, symbol, expiry, strike
  WITH NO DATA;

-- Automatic refresh policy: keep data up to date with a 1-minute lag.
-- start_offset = 1 hour back so the policy covers any late-arriving data.
-- end_offset = 1 minute so the open bucket is never partially materialized.
-- schedule_interval = 1 minute matches the bucket size.
-- The DO $$ block guards against the policy already existing — calling
-- add_continuous_aggregate_policy twice on the same view raises an error.
DO $$
BEGIN
  PERFORM add_continuous_aggregate_policy(
    'straddle_1min',
    start_offset  => INTERVAL '1 hour',
    end_offset    => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
  );
END $$;
