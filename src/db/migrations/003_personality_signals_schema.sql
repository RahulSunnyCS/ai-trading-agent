-- Migration 003: personality_configs, personality_audit_log, straddle_signals
--               and ROC/acceleration columns on straddle_snapshots

-- ---------------------------------------------------------------------------
-- personality_configs
-- ---------------------------------------------------------------------------
-- NOTE: This CREATE TABLE is now an idempotent no-op on fresh installs because
-- 001_core_schema.sql creates the canonical params-shape table first.
-- Edits to this file do not affect the running table; use 001 for schema changes.
--
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

-- ---------------------------------------------------------------------------
-- personality_audit_log
-- ---------------------------------------------------------------------------
-- Immutable append-only log of every parameter change applied to a personality.
-- Stores the full old and new params JSONB blobs so any change can be reviewed
-- or rolled back without querying external systems.
--
-- changed_by defaults to 'api' but can be set to 'evolution_engine' or a user
-- identifier to distinguish automated from manual changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personality_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id  UUID        NOT NULL REFERENCES personality_configs(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      TEXT        NOT NULL DEFAULT 'api',
  old_params      JSONB       NOT NULL,
  new_params      JSONB       NOT NULL,
  reason          TEXT
);

-- ---------------------------------------------------------------------------
-- straddle_signals
-- ---------------------------------------------------------------------------
-- NOTE: This CREATE TABLE is now an idempotent no-op on fresh installs because
-- 001_core_schema.sql creates the canonical hypertable with composite PK first.
-- Edits to this file do not affect the running table; use 001 for schema changes.
--
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
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS straddle_signals (
  -- Composite PK (id, time): TimescaleDB requires the partition column to be
  -- included in the primary key; a simple (id) PK is rejected at create_hypertable.
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
-- straddle_snapshots — add ROC and acceleration columns
-- ---------------------------------------------------------------------------
-- roc (rate-of-change) and acceleration (second derivative of straddle value)
-- are computed by straddle-calc.ts and stored here so the peak detection engine
-- can query recent history without recomputing from raw prices.
--
-- ADD COLUMN IF NOT EXISTS is idempotent — safe on re-run.
-- Both columns are nullable: the first few snapshots do not have enough history
-- to compute a meaningful ROC or acceleration value.
-- ---------------------------------------------------------------------------
ALTER TABLE straddle_snapshots ADD COLUMN IF NOT EXISTS roc          NUMERIC;
ALTER TABLE straddle_snapshots ADD COLUMN IF NOT EXISTS acceleration NUMERIC;
