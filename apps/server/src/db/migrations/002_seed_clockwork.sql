-- Migration: 002_seed_clockwork
-- Seeds the single immutable Clockwork benchmark personality.
--
-- Clockwork is the frozen control against which all other personalities are
-- compared. It never evolves — the evolution engine checks is_frozen = TRUE
-- and throws FROZEN_VIOLATION rather than silently skipping it.
--
-- ON CONFLICT (name) DO NOTHING makes this migration fully idempotent:
-- running bun run migrate twice (or after a partial failure) produces no
-- duplicate row error and leaves the existing row untouched.
--
-- The name 'clockwork' (lowercase) matches the row in 005_personality_seed.sql.
-- This dedup is critical: on a fresh migration chain both files run, but the
-- ON CONFLICT clause ensures exactly one Clockwork row ends up in the table.
-- The full 10-personality set is seeded by 005_personality_seed.sql.

INSERT INTO personality_configs
  (name, display_name, group_type, entry_type, management_style, is_frozen, is_active, phase, params)
VALUES (
  'clockwork',   -- lowercase: matches 005_personality_seed.sql for ON CONFLICT dedup
  'Clockwork',
  'reference',
  'fixed_time',  -- Clockwork enters at a fixed time every day, not on signal quality
  'hold',        -- HOLD: never adjusts or cuts — it is the unchanging control
  TRUE,          -- is_frozen: evolution engine must refuse to modify this row (FROZEN_VIOLATION)
  TRUE,          -- is_active: Clockwork participates in all live trading sessions
  1,             -- phase 1: active from the current sprint, not gated behind a later phase flag
  '{"max_daily_trades":1,"max_daily_loss":5000}'
)
ON CONFLICT (name) DO NOTHING;
