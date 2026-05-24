-- Migration 011: Add performance indexes for retrospection_results queries
--
-- Addresses two query patterns identified in the Phase 4 performance review:
-- 1. GET /api/retrospection filters by personality_id, market_regime, and/or
--    trade_date range with ORDER BY trade_date DESC — needs a composite index.
-- 2. GET /api/retrospection/evolution/pending filters on adjustments_applied=FALSE
--    and proposed_adjustments IS NOT NULL — a partial index keeps it tiny.

-- Index 1: composite covering the common filter/sort combination.
-- Covers: personality only, personality + regime, personality + date range,
-- and the ORDER BY trade_date DESC without a separate sort step.
CREATE INDEX IF NOT EXISTS idx_retrospection_results_personality_regime_date
  ON retrospection_results (personality_id, market_regime, trade_date DESC);

-- Index 2: partial index for the pending-adjustments inbox query.
-- Only indexes the small subset of rows awaiting approval, so the index stays
-- tiny regardless of total table size.
CREATE INDEX IF NOT EXISTS idx_retrospection_pending
  ON retrospection_results (personality_id, created_at DESC)
  WHERE adjustments_applied = FALSE AND proposed_adjustments IS NOT NULL;

-- Index 3: partial index on paper_trades.signal_id for the Brier score JOIN.
-- Skips rows where signal_id IS NULL (fixed_time trades) to keep the index compact.
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_id
  ON paper_trades (signal_id)
  WHERE signal_id IS NOT NULL;
