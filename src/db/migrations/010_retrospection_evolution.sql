-- Migration 010: Add retrospection metric columns, evolution tracking columns,
--               and M2 personality params migration

-- ---------------------------------------------------------------------------
-- personality_configs: add M2 columns
-- ---------------------------------------------------------------------------

-- display_name: human-readable label used by the M2 dashboard (distinct from
-- the machine-readable `name` column which must stay stable as a FK target).
ALTER TABLE personality_configs
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- group_type: classifies a personality as either the immutable reference
-- benchmark ('reference', i.e. Clockwork) or a learning personality subject
-- to parameter evolution ('learning'). The CHECK constraint is applied here
-- even on ADD COLUMN IF NOT EXISTS — PostgreSQL silently skips adding the
-- column if it already exists, so the constraint is part of the original
-- column definition and will only fire on new inserts/updates.
ALTER TABLE personality_configs
  ADD COLUMN IF NOT EXISTS group_type TEXT CHECK (group_type IN ('reference', 'learning'));

-- params: JSONB bag for M2-style personality parameters. NOT NULL with empty
-- object default so that M2 code can always safely read `params->>'key'`
-- without a null check. Existing rows start with '{}' and are populated below.
ALTER TABLE personality_configs
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Data migration: populate params from M1 top-level columns for existing rows
-- ---------------------------------------------------------------------------

-- For any row that still has the empty default, seed params from the M1
-- columns that are authoritative on M1 rows. max_daily_trades is set to 5
-- as a safe operational default (not stored in M1 schema; no M1 column exists
-- to read it from). Only runs when min_probability is non-NULL to guard
-- against any future rows that legitimately have no M1 data.
UPDATE personality_configs
SET params = jsonb_build_object(
  'min_probability', min_probability,
  'max_daily_loss', max_daily_loss_pct,
  'max_daily_trades', 5
)
WHERE params = '{}'::jsonb AND min_probability IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Data migration: backfill display_name and group_type for the Clockwork row
-- ---------------------------------------------------------------------------

-- The Clockwork row was seeded by 002_seed_clockwork.sql using the M1 schema,
-- which predates the display_name / group_type columns. Set them now.
-- The WHERE clause is conservative: only updates if display_name is still NULL,
-- so re-running this migration (idempotent) will not overwrite operator edits.
UPDATE personality_configs
SET display_name = 'Clockwork', group_type = 'reference'
WHERE name = 'Clockwork' AND display_name IS NULL;

-- ---------------------------------------------------------------------------
-- personality_configs: add evolution tracking columns
-- ---------------------------------------------------------------------------

-- last_evolved_at: wall-clock timestamp of the most recent automated
-- parameter change. NULL means the personality has never been evolved.
-- Used by the evolution engine to enforce cooldown periods between changes.
ALTER TABLE personality_configs
  ADD COLUMN IF NOT EXISTS last_evolved_at TIMESTAMPTZ;

-- evolution_consecutive_applications: count of how many evolution rule
-- applications have been accepted in a row without a losing day in between.
-- The evolution engine uses this to cap aggressive compounding of adjustments.
-- NOT NULL DEFAULT 0 so that existing rows are immediately valid without
-- a separate data migration.
ALTER TABLE personality_configs
  ADD COLUMN IF NOT EXISTS evolution_consecutive_applications INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- retrospection_results: add new metric columns
-- ---------------------------------------------------------------------------

-- sharpe: risk-adjusted return for the day's trades. Nullable because it
-- requires at least 2 trades to compute (std dev is undefined on 1 trade).
ALTER TABLE retrospection_results
  ADD COLUMN IF NOT EXISTS sharpe NUMERIC;

-- max_drawdown_pct: peak-to-trough drawdown as a percentage of notional,
-- measured intraday across the personality's open positions. Nullable for
-- the same reason as sharpe (no trades = no drawdown to compute).
ALTER TABLE retrospection_results
  ADD COLUMN IF NOT EXISTS max_drawdown_pct NUMERIC;

-- proposed_adjustments_at: timestamp when the evolution engine queued the
-- proposed_adjustments payload. NULL until the retrospection job has finished
-- and the rule engine has run. Separate from created_at because the rule
-- engine may run asynchronously after the base metrics are written.
ALTER TABLE retrospection_results
  ADD COLUMN IF NOT EXISTS proposed_adjustments_at TIMESTAMPTZ;
