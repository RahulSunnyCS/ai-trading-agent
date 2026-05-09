-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002: Seed personality configs
-- All 10 personalities with their starting parameters.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Clockwork ─────────────────────────────────────────────────────────────
-- Permanent benchmark. Fixed 9:17 AM entry every qualifying day.
-- Nothing ever changes (is_frozen = TRUE).
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'clockwork', 1, TRUE, TRUE,
  'FIXED_TIME', 'HOLD', 1,
  NULL, 1, 5000,
  0, 1.0,
  0, 100,
  FALSE, FALSE,
  ARRAY['RANGING','TRENDING_STRONG','VOLATILE_REVERTING'],
  ARRAY[1]
) ON CONFLICT DO NOTHING;

-- ── 2. Precision ─────────────────────────────────────────────────────────────
-- High-confidence momentum exhaustion. Hold to SL/TSL/EOD.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'precision', 1, TRUE, TRUE,
  'MOMENTUM_EXHAUSTION', 'HOLD', 1,
  0.70, 2, 8000,
  120, 1.0,
  0, 25,
  FALSE, FALSE,
  ARRAY['RANGING','VOLATILE_REVERTING'],
  ARRAY[1,2]
) ON CONFLICT DO NOTHING;

-- ── 3. Scanner ────────────────────────────────────────────────────────────────
-- Low-confidence, any signal. More trades, higher loss limit.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'scanner', 1, TRUE, TRUE,
  'ANY_SIGNAL', 'HOLD', 1,
  0.50, 5, 10000,
  60, 1.0,
  0, 30,
  FALSE, FALSE,
  ARRAY['RANGING','VOLATILE_REVERTING','TRENDING_STRONG'],
  ARRAY[1,2,3]
) ON CONFLICT DO NOTHING;

-- ── 4. Adjuster ───────────────────────────────────────────────────────────────
-- High-confidence momentum with Roll management at 70pt.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  adjustment_trigger_points, max_open_legs,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'adjuster', 1, TRUE, TRUE,
  'MOMENTUM_EXHAUSTION', 'ROLL', 1,
  0.70, 2, 12000,
  120, 1.0,
  70, 4,
  0, 28,
  FALSE, FALSE,
  ARRAY['RANGING','VOLATILE_REVERTING'],
  ARRAY[1,2]
) ON CONFLICT DO NOTHING;

-- ── 5. Reducer ────────────────────────────────────────────────────────────────
-- High-confidence momentum with Cut + Re-enter at 70pt.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  adjustment_trigger_points, reentry_min_probability,
  min_vix, max_vix,
  require_profit_gate, allow_reentry, reentry_delay_mins,
  allowed_regimes, allowed_strategies
) VALUES (
  'reducer', 1, TRUE, TRUE,
  'MOMENTUM_EXHAUSTION', 'CUT_REENTER', 1,
  0.70, 4, 10000,
  120, 1.0,
  70, 0.65,
  0, 28,
  FALSE, TRUE, 15,
  ARRAY['RANGING','VOLATILE_REVERTING'],
  ARRAY[1,2]
) ON CONFLICT DO NOTHING;

-- ── 6. Blitz ──────────────────────────────────────────────────────────────────
-- Any signal with Roll management. Most aggressive reference personality.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  adjustment_trigger_points, max_open_legs,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'blitz', 1, TRUE, TRUE,
  'ANY_SIGNAL', 'ROLL', 1,
  0.50, 5, 15000,
  60, 1.0,
  70, 4,
  0, 35,
  FALSE, FALSE,
  ARRAY['RANGING','VOLATILE_REVERTING','TRENDING_STRONG'],
  ARRAY[1,2,3]
) ON CONFLICT DO NOTHING;

-- ── 7. Levelhead ─────────────────────────────────────────────────────────────
-- S/R-anchored entry with Cut + Re-enter. Phase 2 personality.
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  adjustment_trigger_points, reentry_min_probability,
  min_vix, max_vix,
  require_profit_gate, allow_reentry, reentry_delay_mins,
  allowed_regimes, allowed_strategies
) VALUES (
  'levelhead', 1, TRUE, TRUE,
  'SR_ANCHORED', 'CUT_REENTER', 2,
  0.65, 2, 10000,
  0, 1.0,
  70, 0.65,
  0, 28,
  FALSE, TRUE, 15,
  ARRAY['RANGING'],
  ARRAY[1,3]
) ON CONFLICT DO NOTHING;

-- ── 8. Conservative Learner ───────────────────────────────────────────────────
-- Starts as Clockwork clone. Very slow adaptation (30 trade minimum, 14d cooldown).
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'conservative_learner', 1, TRUE, FALSE,
  'FIXED_TIME', 'HOLD', 1,
  NULL, 1, 5000,
  0, 1.0,
  0, 100,
  FALSE, FALSE,
  ARRAY['RANGING','TRENDING_STRONG','VOLATILE_REVERTING'],
  ARRAY[1]
) ON CONFLICT DO NOTHING;

-- ── 9. Medium Learner ─────────────────────────────────────────────────────────
-- Starts as Clockwork clone. Moderate adaptation (15 trade minimum, 7d cooldown).
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'medium_learner', 1, TRUE, FALSE,
  'FIXED_TIME', 'HOLD', 1,
  NULL, 1, 5000,
  0, 1.0,
  0, 100,
  FALSE, FALSE,
  ARRAY['RANGING','TRENDING_STRONG','VOLATILE_REVERTING'],
  ARRAY[1]
) ON CONFLICT DO NOTHING;

-- ── 10. Aggressive Learner ────────────────────────────────────────────────────
-- Starts as Clockwork clone. Fast adaptation (5 trade minimum, 3d cooldown).
INSERT INTO personality_configs (
  name, version, is_active, is_frozen,
  entry_type, management_style, phase,
  min_probability, max_daily_trades, max_daily_loss,
  entry_delay_secs, position_multiplier,
  min_vix, max_vix,
  require_profit_gate, allow_reentry,
  allowed_regimes, allowed_strategies
) VALUES (
  'aggressive_learner', 1, TRUE, FALSE,
  'FIXED_TIME', 'HOLD', 1,
  NULL, 1, 5000,
  0, 1.0,
  0, 100,
  FALSE, FALSE,
  ARRAY['RANGING','TRENDING_STRONG','VOLATILE_REVERTING'],
  ARRAY[1]
) ON CONFLICT DO NOTHING;
