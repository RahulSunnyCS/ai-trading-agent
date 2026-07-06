-- Migration 005: Seed all 10 trading personalities
--
-- Active at launch: clockwork, precision, adjuster
-- Inactive (activate via PUT /personalities/:id): scanner, reducer, blitz, levelhead, conservative_learner, medium_learner, aggressive_learner
-- ON CONFLICT (name) DO NOTHING ensures idempotency: re-running produces no changes

INSERT INTO personality_configs
  (name, display_name, group_type, entry_type, management_style, is_frozen, is_active, phase, params)
VALUES

  -- -------------------------------------------------------------------------
  -- REFERENCE GROUP — active at launch
  -- -------------------------------------------------------------------------

  -- Clockwork: the frozen benchmark. Enters at a fixed time every day regardless
  -- of signal quality. is_frozen = TRUE means the evolution engine must refuse to
  -- modify its params and throw FROZEN_VIOLATION if attempted.
  (
    'clockwork',
    'Clockwork',
    'reference',
    'fixed_time',
    'hold',
    TRUE,   -- is_frozen: benchmark, never evolved
    TRUE,   -- is_active: runs from day one
    1,
    '{"max_daily_trades":1,"max_daily_loss":5000}'
  ),

  -- Precision: momentum-exhaustion signals only, holds until EOD. Its min_probability
  -- threshold must stay within 8pp of Adjuster and Reducer for comparison integrity.
  (
    'precision',
    'Precision',
    'reference',
    'momentum_exhaustion',
    'hold',
    FALSE,
    TRUE,
    1,
    '{"min_probability":0.70,"max_daily_trades":2,"max_daily_loss":8000,"entry_delay_secs":120,"vix_max":25}'
  ),

  -- Adjuster: same entry criteria as Precision but rolls legs when the straddle
  -- recovers beyond roll_trigger_points from its lowest seen value.
  (
    'adjuster',
    'Adjuster',
    'reference',
    'momentum_exhaustion',
    'roll',
    FALSE,
    TRUE,
    1,
    '{"min_probability":0.70,"max_daily_trades":2,"roll_trigger_points":70,"max_open_legs":4,"max_daily_loss":12000}'
  ),

  -- -------------------------------------------------------------------------
  -- REFERENCE GROUP — inactive at launch
  -- -------------------------------------------------------------------------

  -- Scanner: listens to any signal type with a lower probability bar. Useful for
  -- measuring how much filtering by signal type adds value vs. raw volume.
  (
    'scanner',
    'Scanner',
    'reference',
    'any_signal',
    'hold',
    FALSE,
    FALSE,  -- is_active: off at launch, activate when ready to compare
    1,
    '{"min_probability":0.50,"max_daily_trades":5,"max_daily_loss":10000,"entry_delay_secs":60,"vix_max":30}'
  ),

  -- Reducer: same signals as Precision but cuts losing legs and re-enters instead
  -- of holding. Designed to test whether active cut + reentry beats passive hold.
  (
    'reducer',
    'Reducer',
    'reference',
    'momentum_exhaustion',
    'cut_reenter',
    FALSE,
    FALSE,
    1,
    '{"min_probability":0.70,"max_daily_trades":4,"cut_trigger_points":70,"reentry_min_probability":0.65,"max_daily_loss":10000}'
  ),

  -- Blitz: high-frequency roll strategy responding to any signal. Serves as an
  -- upper-bound test for how much turnover the roll mechanic can sustain.
  (
    'blitz',
    'Blitz',
    'reference',
    'any_signal',
    'roll',
    FALSE,
    FALSE,
    1,
    '{"min_probability":0.50,"max_daily_trades":5,"roll_trigger_points":70,"max_open_legs":4,"max_daily_loss":15000}'
  ),

  -- Levelhead: Phase 2 personality gated behind S/R signal detection.
  -- entry_type = 'sr_anchored' requires the S/R engine from Sprint 4+.
  -- phase = 2 prevents the engine from activating it until Phase 2 is deployed.
  (
    'levelhead',
    'Levelhead',
    'reference',
    'sr_anchored',
    'cut_reenter',
    FALSE,
    FALSE,
    2,      -- phase: gated — will not activate until Phase 2 engine is deployed
    '{"sr_proximity_points":20,"sr_strength_threshold":0.65,"max_daily_trades":2,"cut_trigger_points":70}'
  ),

  -- -------------------------------------------------------------------------
  -- LEARNING GROUP — inactive at launch
  -- -------------------------------------------------------------------------
  -- Learning personalities use fixed_time entry (same as Clockwork) but evolve
  -- their params at different speeds via the retrospection engine. They differ only
  -- in how aggressively min_samples, max_change_pct, and cooldown are set.
  -- Comparing the three learners isolates the effect of evolution speed.

  (
    'conservative_learner',
    'Conservative Learner',
    'learning',
    'fixed_time',
    'hold',
    FALSE,
    FALSE,
    1,
    '{"learning_speed":"conservative","min_samples_before_change":30,"max_changes_per_cycle":1,"max_change_pct":3,"cooldown_days":14,"max_daily_trades":1,"max_daily_loss":5000}'
  ),

  (
    'medium_learner',
    'Medium Learner',
    'learning',
    'fixed_time',
    'hold',
    FALSE,
    FALSE,
    1,
    '{"learning_speed":"medium","min_samples_before_change":15,"max_changes_per_cycle":2,"max_change_pct":6,"cooldown_days":7,"max_daily_trades":1,"max_daily_loss":5000}'
  ),

  (
    'aggressive_learner',
    'Aggressive Learner',
    'learning',
    'fixed_time',
    'hold',
    FALSE,
    FALSE,
    1,
    '{"learning_speed":"aggressive","min_samples_before_change":5,"max_changes_per_cycle":3,"max_change_pct":10,"cooldown_days":3,"max_daily_trades":1,"max_daily_loss":5000}'
  )

ON CONFLICT (name) DO NOTHING;
