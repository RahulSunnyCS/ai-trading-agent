-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001: Initial schema
-- TimescaleDB hypertables + standard tables for Sprint 1
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Hypertable: market_ticks ──────────────────────────────────────────────────
-- Raw WebSocket tick data. One row per tick per symbol.
CREATE TABLE IF NOT EXISTS market_ticks (
  time            TIMESTAMPTZ       NOT NULL,
  symbol          TEXT              NOT NULL,
  underlying      TEXT              NOT NULL,  -- NIFTY | BANKNIFTY | SENSEX
  expiry          DATE,
  strike          INTEGER,
  option_type     CHAR(2),                     -- CE | PE
  ltp             NUMERIC(10,2)     NOT NULL,
  bid             NUMERIC(10,2),
  ask             NUMERIC(10,2),
  volume          BIGINT,
  oi              BIGINT
);

SELECT create_hypertable('market_ticks', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol_time ON market_ticks (symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_market_ticks_underlying_time ON market_ticks (underlying, time DESC);

-- ── Hypertable: straddle_snapshots ───────────────────────────────────────────
-- Pre-computed straddle values every 15 seconds. Core input for signal generation.
CREATE TABLE IF NOT EXISTS straddle_snapshots (
  time                  TIMESTAMPTZ   NOT NULL,
  underlying            TEXT          NOT NULL,
  expiry                DATE          NOT NULL,
  atm_strike            INTEGER       NOT NULL,
  ce_ltp                NUMERIC(10,2),
  pe_ltp                NUMERIC(10,2),
  straddle_value        NUMERIC(10,2),          -- ce_ltp + pe_ltp
  straddle_change_pct   NUMERIC(8,4),           -- % change from open straddle
  roc                   NUMERIC(10,6),          -- rate of change (first derivative)
  acceleration          NUMERIC(10,6),          -- second derivative of roc
  vix                   NUMERIC(6,2)
);

SELECT create_hypertable('straddle_snapshots', 'time', if_not_exists => TRUE);
ALTER TABLE straddle_snapshots SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'underlying, expiry'
);
CREATE INDEX IF NOT EXISTS idx_straddle_underlying_expiry_time
  ON straddle_snapshots (underlying, expiry, time DESC);

-- ── Hypertable: option_ticks ─────────────────────────────────────────────────
-- Per-strike OHLC and derived values (1-minute bars).
CREATE TABLE IF NOT EXISTS option_ticks (
  time              TIMESTAMPTZ   NOT NULL,
  symbol            TEXT          NOT NULL,
  underlying        TEXT          NOT NULL,
  expiry            DATE          NOT NULL,
  strike            INTEGER       NOT NULL,
  option_type       CHAR(2)       NOT NULL,
  open              NUMERIC(10,2),
  high              NUMERIC(10,2),
  low               NUMERIC(10,2),
  close             NUMERIC(10,2),
  volume            BIGINT,
  oi                BIGINT,
  price_ema8        NUMERIC(10,4),
  price_ema20       NUMERIC(10,4),
  price_ema40       NUMERIC(10,4),
  delta             NUMERIC(8,4),
  gamma             NUMERIC(8,6),
  theta             NUMERIC(8,4),
  vega              NUMERIC(8,4),
  exhaustion_score  NUMERIC(6,4)  -- 0.0–1.0, used in peak detection
);

SELECT create_hypertable('option_ticks', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_option_ticks_symbol_time ON option_ticks (symbol, time DESC);

-- ── Table: straddle_signals ───────────────────────────────────────────────────
-- Output of the peak detection engine.
CREATE TABLE IF NOT EXISTS straddle_signals (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  underlying              TEXT          NOT NULL,
  expiry                  DATE          NOT NULL,
  signal_time             TIMESTAMPTZ   NOT NULL,
  signal_type             TEXT          NOT NULL,  -- MOMENTUM_EXHAUSTION | SCHEDULED | PULLBACK
  atm_strike              INTEGER       NOT NULL,
  straddle_value          NUMERIC(10,2),
  expansion_pct           NUMERIC(8,4),
  probability             NUMERIC(5,4),            -- 0.0–1.0
  confidence_tier         TEXT,                    -- LOW | MEDIUM | HIGH
  trigger_layer           TEXT,
  status                  TEXT          DEFAULT 'pending',
  -- Outcome tracking (filled post-hoc by retrospection)
  actual_peak_value       NUMERIC(10,2),
  actual_peak_time        TIMESTAMPTZ,
  signal_to_peak_gap_pct  NUMERIC(8,4)
);

CREATE INDEX IF NOT EXISTS idx_signals_underlying_time ON straddle_signals (underlying, signal_time DESC);
CREATE INDEX IF NOT EXISTS idx_signals_status ON straddle_signals (status);

-- ── Table: external_signals ───────────────────────────────────────────────────
-- Flexible storage for VIX, FII/DII, global cues, calendar events.
CREATE TABLE IF NOT EXISTS external_signals (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  recorded_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  signal_date   DATE          NOT NULL,
  signal_type   TEXT          NOT NULL,  -- FII_DII | GLOBAL_CUES | SENTIMENT | CALENDAR | VIX
  source        TEXT,
  data          JSONB         NOT NULL,
  relevance     NUMERIC(4,2)             -- 0.0–1.0
);

CREATE INDEX IF NOT EXISTS idx_external_signals_date_type ON external_signals (signal_date, signal_type);

-- ── Table: personality_configs ────────────────────────────────────────────────
-- Version-controlled parameter sets. One active row per personality.
CREATE TABLE IF NOT EXISTS personality_configs (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT          NOT NULL,       -- clockwork | precision | scanner | adjuster | reducer | blitz
  version               INTEGER       NOT NULL DEFAULT 1,
  is_active             BOOLEAN       DEFAULT TRUE,
  is_frozen             BOOLEAN       DEFAULT FALSE,  -- TRUE for Clockwork
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Identity (fixed — defines the experiment)
  entry_type            TEXT          NOT NULL,       -- FIXED_TIME | MOMENTUM_EXHAUSTION | ANY_SIGNAL | SR_ANCHORED
  management_style      TEXT          NOT NULL,       -- HOLD | ROLL | CUT_REENTER
  phase                 INTEGER       NOT NULL DEFAULT 1,
  -- Core tunable parameters
  min_probability       NUMERIC(4,3),
  max_daily_trades      INTEGER       NOT NULL,
  max_daily_loss        NUMERIC(10,2) NOT NULL,
  entry_delay_secs      INTEGER       NOT NULL DEFAULT 0,
  position_multiplier   NUMERIC(4,2)  NOT NULL DEFAULT 1.0,
  -- Management parameters
  adjustment_trigger_points INTEGER,
  max_open_legs         INTEGER,
  reentry_min_probability NUMERIC(4,3),
  -- VIX constraints
  min_vix               NUMERIC(5,2)  DEFAULT 0,
  max_vix               NUMERIC(5,2)  DEFAULT 100,
  -- Feature flags
  require_profit_gate   BOOLEAN       DEFAULT FALSE,
  profit_gate_amount    NUMERIC(10,2),
  profit_gate_days      INTEGER,
  allow_reentry         BOOLEAN       DEFAULT FALSE,
  reentry_delay_mins    INTEGER,
  allowed_regimes       TEXT[],
  allowed_strategies    INTEGER[],
  -- Performance cache (30-day rolling, updated by retrospection)
  cached_win_rate       NUMERIC(5,4),
  cached_sharpe         NUMERIC(6,4),
  cached_total_trades   INTEGER,
  cache_updated_at      TIMESTAMPTZ,
  -- Evolution audit
  evolved_from          UUID          REFERENCES personality_configs(id),
  evolution_reason      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personality_name_active
  ON personality_configs (name) WHERE is_active = TRUE;

-- ── Table: paper_trades ───────────────────────────────────────────────────────
-- One row per trade execution per personality.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id            UUID          REFERENCES personality_configs(id),
  signal_id                 UUID          REFERENCES straddle_signals(id),
  strategy_id               INTEGER       NOT NULL DEFAULT 1,
  underlying                TEXT          NOT NULL,
  expiry                    DATE          NOT NULL,
  entry_time                TIMESTAMPTZ   NOT NULL,
  exit_time                 TIMESTAMPTZ,
  status                    TEXT          DEFAULT 'open',   -- open | closed | stopped
  exit_reason               TEXT,                          -- TARGET | SL | TSL | EOD | MANUAL
  -- Legs
  entry_ce_strike           INTEGER,
  entry_ce_price            NUMERIC(10,2),
  exit_ce_price             NUMERIC(10,2),
  entry_pe_strike           INTEGER,
  entry_pe_price            NUMERIC(10,2),
  exit_pe_price             NUMERIC(10,2),
  lots                      INTEGER       DEFAULT 1,
  position_multiplier       NUMERIC(4,2)  DEFAULT 1.0,
  -- P&L
  gross_pnl                 NUMERIC(12,2),
  net_pnl                   NUMERIC(12,2),
  max_drawdown              NUMERIC(12,2),
  max_favorable_excursion   NUMERIC(12,2),
  -- Context at entry
  vix_at_entry              NUMERIC(6,2),
  spot_at_entry             NUMERIC(10,2),
  straddle_at_entry         NUMERIC(10,2),
  market_regime             TEXT,
  has_event_flag            BOOLEAN       DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_personality_entry
  ON paper_trades (personality_id, entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades (status);

-- ── Table: retrospection_results ─────────────────────────────────────────────
-- Daily EOD analysis. One row per personality per day.
CREATE TABLE IF NOT EXISTS retrospection_results (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_date         DATE          NOT NULL,
  personality_id        UUID          REFERENCES personality_configs(id),
  run_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Regime context
  market_regime         TEXT          NOT NULL,  -- RANGING | TRENDING_STRONG | VOLATILE_REVERTING | EVENT_DAY
  vix_open              NUMERIC(6,2),
  index_move_pct        NUMERIC(6,4),
  -- Aggregate metrics
  total_trades          INTEGER,
  winning_trades        INTEGER,
  losing_trades         INTEGER,
  win_rate              NUMERIC(5,4),
  total_pnl             NUMERIC(12,2),
  avg_pnl_per_trade     NUMERIC(10,2),
  max_drawdown          NUMERIC(12,2),
  sharpe_ratio          NUMERIC(8,4),
  -- Clockwork comparison
  clockwork_pnl_today   NUMERIC(12,2),
  beat_clockwork_by     NUMERIC(12,2),
  -- Signal calibration
  signals_received      INTEGER,
  signals_acted_on      INTEGER,
  signal_brier_score    NUMERIC(6,4),
  -- Management effectiveness
  adjustments_made      INTEGER,
  mgmt_pnl_delta        NUMERIC(12,2),
  mgmt_verdict          TEXT,                   -- HELPED | HURT | NEUTRAL
  -- Integrity flags
  threshold_drift_flag  BOOLEAN       DEFAULT FALSE,
  evolution_paused      BOOLEAN       DEFAULT FALSE,
  -- Insights
  insights              JSONB,
  suggested_changes     JSONB,
  applied               BOOLEAN       DEFAULT FALSE,
  applied_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retrospection_date_personality
  ON retrospection_results (analysis_date, personality_id);
CREATE INDEX IF NOT EXISTS idx_retrospection_regime
  ON retrospection_results (market_regime, personality_id);

-- ── Continuous Aggregate: straddle_1min ──────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS straddle_1min
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  underlying,
  expiry,
  first(straddle_value, time)   AS open,
  max(straddle_value)           AS high,
  min(straddle_value)           AS low,
  last(straddle_value, time)    AS close,
  last(atm_strike, time)        AS atm_strike,
  last(vix, time)               AS vix
FROM straddle_snapshots
GROUP BY bucket, underlying, expiry
WITH NO DATA;

SELECT add_continuous_aggregate_policy('straddle_1min',
  start_offset => INTERVAL '1 hour',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

-- ── Schema migrations tracking ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER     PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES (1, 'Initial schema: hypertables, signals, trades, personalities, retrospection')
ON CONFLICT (version) DO NOTHING;
