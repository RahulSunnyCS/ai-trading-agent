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
-- Only Clockwork is seeded here. The full 10-personality set
-- (Precision, Adjuster, Reducer, Levelhead, etc.) is deferred to the
-- M2 seed migration (T-25).

INSERT INTO personality_configs (
  name,
  description,
  phase,
  is_frozen,
  entry_type,
  management_style,
  min_probability,
  sl_pct,
  target_pct,
  tsl_trigger_pct,
  max_daily_loss_pct,
  entry_window_start,
  entry_window_end,
  exit_time,
  is_active
) VALUES (
  'Clockwork',
  'Frozen benchmark personality. Never evolves. All other personalities are compared against it.',
  1,         -- phase 1: active in the current sprint, not gated behind a later phase flag
  TRUE,      -- is_frozen: the evolution engine must never modify this row
  'MOMENTUM_EXHAUSTION',
  'HOLD',    -- management_style HOLD: Clockwork never adjusts or cuts — it is the unchanging control
  0.5500,    -- min_probability: 55% threshold — the baseline signal quality gate
  0.1500,    -- sl_pct: 15% stop-loss as a fraction of entry straddle value
  0.2500,    -- target_pct: 25% profit target as a fraction of entry straddle value
  NULL,      -- tsl_trigger_pct: NULL because HOLD style never activates a trailing stop
  0.0300,    -- max_daily_loss_pct: 3% daily loss cap — trading halts for the day if breached
  '09:20',   -- entry_window_start: 10 minutes after NSE open (avoids opening auction noise)
  '14:30',   -- entry_window_end: no new entries after 2:30 PM IST (leaves time to exit before EOD)
  '15:15',   -- exit_time: force-close all positions 15 minutes before NSE close (3:30 PM IST)
  TRUE       -- is_active: Clockwork participates in all live trading sessions
)
ON CONFLICT (name) DO NOTHING;
