-- Migration 001: Core schema — hypertables, regular tables, straddle_1min
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

-- ---------------------------------------------------------------------------
-- straddle_signals
-- ---------------------------------------------------------------------------
-- One signal event produced by the peak detection engine when it identifies a
-- momentum exhaustion, a scheduled entry window, or a pullback opportunity.
-- Each signal is broadcast to all active personalities; the personality decision
-- engine records its accept/reject decision in paper_trades.signal_id.
--
-- adjusted_probability is the final probability score after VIX and time-of-day
-- adjustments — not the raw exhaustion score. Typed separately so callers can
-- compare them to understand how context adjustments shifted the signal quality.
--
-- confidence_tier is a pre-computed categorical bucket derived from
-- adjusted_probability so the decision engine can apply simple equality checks
-- rather than threshold comparisons on every filter step.
--
-- Columns such as expansion_pct, roc_decline_candles, and acceleration_value are
-- nullable: SCHEDULED signals are not produced by the peak detection algorithm and
-- do not have these algorithm-specific fields.
--
-- TimescaleDB hypertable on `time` — all queries must include a time-range filter.
-- Composite PRIMARY KEY (id, time) is required by TimescaleDB for unique indexes
-- on hypertables: every unique constraint must include the partition column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS straddle_signals (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  time                 TIMESTAMPTZ NOT NULL,
  underlying           TEXT        NOT NULL,
  signal_type          TEXT        NOT NULL CHECK (signal_type IN ('MOMENTUM_EXHAUSTION', 'SCHEDULED', 'PULLBACK')),
  atm_strike           NUMERIC     NOT NULL,
  spot                 NUMERIC     NOT NULL,
  straddle_value       NUMERIC     NOT NULL,
  vix                  NUMERIC,
  raw_exhaustion_score NUMERIC,
  adjusted_probability NUMERIC     NOT NULL,
  confidence_tier      TEXT        NOT NULL CHECK (confidence_tier IN ('HIGH', 'MEDIUM', 'LOW')),
  expansion_pct        NUMERIC,
  roc_decline_candles  INTEGER,
  acceleration_value   NUMERIC,
  adjustment_breakdown TEXT,
  PRIMARY KEY (id, "time")
);

-- if_not_exists = true keeps this idempotent if the migration is re-applied.
SELECT create_hypertable('straddle_signals', 'time', if_not_exists => true);

-- ---------------------------------------------------------------------------
-- personality_configs
-- ---------------------------------------------------------------------------
-- Each row describes one trading personality: its decision strategy, management
-- style, and the tunable parameter set (params JSONB) that the evolution engine
-- adjusts over time.
--
-- is_frozen = TRUE marks the Clockwork benchmark: the evolution engine MUST
-- throw FROZEN_VIOLATION rather than silently skipping it when this flag is set.
--
-- is_active = FALSE personalities are deployed but not yet running; they can be
-- activated via PUT /personalities/:id without a code change.
--
-- group_type: 'reference' personalities have fixed entry logic; 'learning'
-- personalities have their params tuned by the retrospection engine.
--
-- management_style values: 'hold', 'roll', 'cut_reenter' (lowercase, params-shape).
-- entry_type values: 'fixed_time', 'momentum_exhaustion', 'any_signal', 'sr_anchored'.
--
-- IF NOT EXISTS makes every CREATE idempotent — safe to re-run migrations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personality_configs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL UNIQUE,
  display_name     TEXT        NOT NULL,
  group_type       TEXT        NOT NULL CHECK (group_type IN ('reference', 'learning')),
  entry_type       TEXT        NOT NULL CHECK (entry_type IN ('fixed_time', 'momentum_exhaustion', 'any_signal', 'sr_anchored')),
  management_style TEXT        NOT NULL CHECK (management_style IN ('hold', 'roll', 'cut_reenter')),
  is_frozen        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
  phase            INTEGER     NOT NULL DEFAULT 1,
  params           JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual paper trade records.
-- personality_id FK points to personality_configs(id).
-- signal_id is nullable (no FK) because SCHEDULED entries are not triggered
-- by a detected signal — they enter at a fixed time regardless.
-- The FK to straddle_signals is intentionally omitted: straddle_signals is a
-- hypertable with composite PK (id, time); a FK to (id) alone is not possible
-- without including the partition column, and referencing (id, time) would
-- require storing the signal's time redundantly in paper_trades. Using signal_id
-- as a bare UUID reference without a FK constraint is the correct approach here.
-- market_regime is nullable on entry; the EOD retrospection engine fills
-- it in after classifying the day.
-- exit_reason uses CHECK rather than enum for the same extensibility reason
-- as signal_type above.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id        UUID          REFERENCES personality_configs(id),
  signal_id             UUID,
  symbol                TEXT          NOT NULL,
  expiry                DATE,
  strike                NUMERIC(10,2),
  entry_type            TEXT          NOT NULL DEFAULT 'MOMENTUM_EXHAUSTION',
  entry_time            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  entry_straddle_value  NUMERIC(12,2) NOT NULL,
  exit_time             TIMESTAMPTZ,
  exit_straddle_value   NUMERIC(12,2),
  exit_reason           TEXT          CHECK (exit_reason IN ('SL', 'TSL', 'TARGET', 'EOD', 'TIME', 'DAILY_LOSS_CAP', 'MANUAL')),
  pnl_pct               NUMERIC(8,4),
  pnl_abs               NUMERIC(12,2),
  status                TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  market_regime         TEXT          CHECK (market_regime IN ('RANGING', 'TRENDING_STRONG', 'VOLATILE_REVERTING', 'EVENT_DAY')),
  -- Legacy columns preserved for the milestones-0-1 branch compatibility
  lots                  INTEGER       NOT NULL DEFAULT 1,
  lot_size              INTEGER       NOT NULL DEFAULT 50,
  straddle_at_entry     NUMERIC,
  lowest_straddle_value_seen NUMERIC,
  vix_at_entry          NUMERIC,
  spot_at_entry         NUMERIC,
  gross_pnl             NUMERIC,
  net_pnl               NUMERIC,
  max_drawdown          NUMERIC,
  notes                 TEXT,
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
